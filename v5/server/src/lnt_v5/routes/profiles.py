"""Profiles: instruction-level counter data for one test in one run (E7).

Read-only: a profile is submitted inside a run, and stored as a `{suite}.profile` row and a
`{suite}.profile_function` row per function (D5, O7). Four endpoints address a profile by its
UUID, and the run's listing is how a client that knows a run and a test finds that UUID. A function
is named in `function=` rather than in the path, since its name can contain `/` (I1).
"""

from __future__ import annotations

from typing import Annotated, Any

from fastapi import APIRouter, Query, Response
from pydantic import BaseModel, Field
from sqlalchemy import Connection, Row, Select, Table, and_, select

from lnt_v5.auth import require_scope
from lnt_v5.db import EngineDep
from lnt_v5.errors import ApiError, ErrorCode
from lnt_v5.responses import Items
from lnt_v5.routes.runs import NO_RUN, RUNS_PATH, run_id
from lnt_v5.routes.suites import SUITES_PATH
from lnt_v5.scopes import Scope
from lnt_v5.suites.entities import UuidKey, identifier
from lnt_v5.suites.profile_document import document_json, instructions
from lnt_v5.suites.registry import RegistryDep, Suite
from lnt_v5.suites.scope import SUITE_NOT_FOUND, suite_responses, suite_scope

PROFILES_PATH = f"{SUITES_PATH}/{{testsuite}}/profiles"
RUN_PROFILES_PATH = f"{RUNS_PATH}/{{uuid}}/profiles"

router = APIRouter(prefix=PROFILES_PATH, tags=["Profiles"])

# The one route under a run rather than under `/profiles`, tagged so that I8's document groups it
# with the profiles, as `runs.machine_runs_router` is with the machines.
run_profiles_router = APIRouter(prefix=RUNS_PATH, tags=["Profiles"])

# `suite_scope`'s 404, widened with the cases these endpoints add.
_NO_PROFILE = f"{SUITE_NOT_FOUND} Or no profile in it has that UUID."
_NO_FUNCTION = f"{_NO_PROFILE} Or the profile holds no function of that name."

# Field descriptions more than one response model carries.
_TEST = "The name of the test this profile was measured for."
_DISASSEMBLY_FORMAT = "How the instruction text was produced, for example `llvm-objdump`."
_INSTRUCTIONS = "The function's instructions, in the order the profile records them."


class RunProfile(BaseModel):
    """A profile as a run's listing carries it: what it measured, and how to ask for it."""

    test: str = Field(description=_TEST)
    uuid: str = Field(
        description="Identifies the profile. Server-generated (I1); the profile data endpoints "
        "take it."
    )


class ProfileMetadata(BaseModel):
    """What a profile is of, and the counters it measured as a whole."""

    uuid: str = Field(description="Identifies the profile.")
    test: str = Field(description=_TEST)
    run_uuid: str = Field(description="The UUID of the run this profile belongs to.")
    counters: dict[str, int] = Field(
        description=(
            "The profile's top-level counters, keyed by counter name. Raw totals for the whole "
            "profile, and integers -- unlike every other counter here, which is a number."
        )
    )
    disassembly_format: str = Field(description=_DISASSEMBLY_FORMAT)


class ProfileFunction(BaseModel):
    """One function of a profile, as the functions response carries it."""

    name: str = Field(description="The function's name, as the profile's producer recorded it.")
    counters: dict[str, float] = Field(
        description=(
            "The function's counters, keyed by counter name: each the sum of that counter over the "
            "function's instructions. Raw counts, not percentages: a client that wants a share of "
            "the profile computes it against the top-level counters. "
            "A function carries only the counters its instructions were measured with, which may "
            "be fewer than the profile has."
        )
    )
    length: int = Field(description="How many instructions the function's disassembly holds.")


class Instruction(BaseModel):
    """One instruction of a function's disassembly."""

    address: int = Field(description="The instruction's address.")
    counters: dict[str, float] = Field(
        description=(
            "The counts measured at this instruction, keyed by counter name. Raw counts, not "
            "percentages, and the same counters the function carries."
        )
    )
    text: str = Field(
        description="The disassembled instruction, in the profile's `disassembly_format`."
    )


class FunctionDisassembly(BaseModel):
    """One function's disassembly and the counters measured along it."""

    name: str = Field(description="The function's name.")
    counters: dict[str, float] = Field(
        description=(
            "The function's counters, keyed by counter name: the same sums the functions "
            "response carries."
        )
    )
    disassembly_format: str = Field(description=_DISASSEMBLY_FORMAT)
    instructions: list[Instruction] = Field(description=_INSTRUCTIONS)


class DocumentFunction(BaseModel):
    """One function of a profile document: its instructions, and no counters of its own (O7)."""

    name: str = Field(description="The function's name.")
    instructions: list[Instruction] = Field(description=_INSTRUCTIONS)


# Describes the response for I8 only: the endpoint encodes the document itself.
class ProfileDocument(BaseModel):
    """A whole profile, as the document a submission carries it in (O7), but uncompressed."""

    disassembly_format: str = Field(description=_DISASSEMBLY_FORMAT)
    counters: dict[str, int] = Field(
        description="The profile's top-level counters, keyed by counter name, as in the metadata."
    )
    functions: list[DocumentFunction] = Field(
        description=(
            "Every function of the profile, in the order the functions response lists them -- not "
            "necessarily the order they were submitted in."
        )
    )


class Profiles:
    """The queries the profile endpoints are built from, and how to read one of their rows back.

    Only `disassembly` and `document` select a function's `instructions` (D5).
    """

    def __init__(self, suite: Suite) -> None:
        self.schema = suite.schema
        self.table: Table = suite.tables.profile
        self._function: Table = suite.tables.profile_function
        self._test: Table = suite.tables.test
        self._run: Table = suite.tables.run
        # The "C" collation gives endpoints.md's code-point order, whereas the database's default
        # depends on its locale.
        self._by_name = self._function.c.name.collate("C")

    def of_run(self, run: int) -> Select[Any]:
        """Every profile attached to one run, by test name (E7)."""
        return (
            select(self._test.c.name, self.table.c.uuid)
            .select_from(self.table.join(self._test, self._test.c.id == self.table.c.test_id))
            .where(self.table.c.run_id == run)
            .order_by(self._test.c.name)
        )

    def read(self, row: Row[Any]) -> RunProfile:
        return RunProfile(
            test=row._mapping[self._test.c.name], uuid=row._mapping[self.table.c.uuid]
        )

    def metadata(self, connection: Connection, uuid: str) -> ProfileMetadata:
        """One profile's metadata, or the 404 for a UUID nothing holds."""
        row = connection.execute(
            select(
                self._test.c.name,
                self._run.c.uuid,
                self.table.c.counters,
                self.table.c.disassembly_format,
            )
            .select_from(
                self.table.join(self._test, self._test.c.id == self.table.c.test_id).join(
                    self._run, self._run.c.id == self.table.c.run_id
                )
            )
            .where(self.table.c.uuid == uuid)
        ).one_or_none()
        if row is None:
            raise self.missing(uuid)
        return ProfileMetadata(
            uuid=uuid,
            test=row._mapping[self._test.c.name],
            run_uuid=row._mapping[self._run.c.uuid],
            counters=row._mapping[self.table.c.counters],
            disassembly_format=row._mapping[self.table.c.disassembly_format],
        )

    def functions(self, connection: Connection, uuid: str) -> list[ProfileFunction]:
        """Every function of one profile, by name, or the 404 for a missing UUID."""
        profile = identifier(connection, self.table.c.uuid, uuid, self.missing)
        rows = connection.execute(
            select(self._function.c.name, self._function.c.counters, self._function.c.length)
            .where(self._function.c.profile_id == profile)
            .order_by(self._by_name)
        )
        return [
            ProfileFunction(name=name, counters=counters, length=length)
            for name, counters, length in rows
        ]

    def disassembly(
        self, connection: Connection, uuid: str, name: str
    ) -> tuple[str, dict[str, float], bytes]:
        """One function's disassembly format, counters and stored instructions, or the 404 for a
        profile or a function that is not there.

        One query for both: the outer join leaves the function's columns null when the profile
        holds no function of that name, and returns no row at all when there is no such profile.
        """
        row = connection.execute(
            select(
                self.table.c.disassembly_format,
                self._function.c.counters,
                self._function.c.instructions,
            )
            .select_from(
                self.table.outerjoin(
                    self._function,
                    and_(
                        self._function.c.profile_id == self.table.c.id,
                        self._function.c.name == name,
                    ),
                )
            )
            .where(self.table.c.uuid == uuid)
        ).one_or_none()
        if row is None:
            raise self.missing(uuid)
        if row.instructions is None:
            raise ApiError(
                ErrorCode.NOT_FOUND,
                f"Profile '{uuid}' in test suite '{self.schema.name}' holds no function named "
                f"'{name}'",
            )
        return row.disassembly_format, row.counters, row.instructions

    def document(
        self, connection: Connection, uuid: str
    ) -> tuple[str, dict[str, int], list[tuple[str, bytes]]]:
        """One profile's disassembly format, top-level counters, and the name and stored
        instructions of every function, by name, or the 404 for a missing UUID.
        """
        profile = connection.execute(
            select(self.table.c.id, self.table.c.disassembly_format, self.table.c.counters).where(
                self.table.c.uuid == uuid
            )
        ).one_or_none()
        if profile is None:
            raise self.missing(uuid)
        functions = connection.execute(
            select(self._function.c.name, self._function.c.instructions)
            .where(self._function.c.profile_id == profile.id)
            .order_by(self._by_name)
        )
        return profile.disassembly_format, profile.counters, list(functions.tuples())

    def missing(self, uuid: str) -> ApiError:
        """The 404 for a profile that is not there, worded in one place for all its callers."""
        return ApiError(
            ErrorCode.NOT_FOUND, f"No profile '{uuid}' in test suite '{self.schema.name}'"
        )


@run_profiles_router.get(
    "/{uuid}/profiles",
    dependencies=[require_scope(Scope.READ)],
    summary="List a run's profiles",
    responses=suite_responses(not_found=NO_RUN),
)
def list_run_profiles(
    testsuite: str, uuid: UuidKey, engine: EngineDep, registry: RegistryDep
) -> Items[RunProfile]:
    """Which tests of one run have a profile, and the UUID of each (I2).

    Unpaginated: a run holds at most one profile per test it measured, so the response is bounded
    by the run itself.
    """
    with engine.connect() as connection, suite_scope(registry, connection, testsuite) as suite:
        profiles = Profiles(suite)
        rows = connection.execute(profiles.of_run(run_id(connection, suite, uuid)))
        return Items(items=[profiles.read(row) for row in rows])


@router.get(
    "/{uuid}",
    dependencies=[require_scope(Scope.READ)],
    summary="Get a profile's metadata",
    responses=suite_responses(not_found=_NO_PROFILE),
)
def get_profile(
    testsuite: str, uuid: UuidKey, engine: EngineDep, registry: RegistryDep
) -> ProfileMetadata:
    """What a profile is of, and its top-level counters (E7)."""
    with engine.connect() as connection, suite_scope(registry, connection, testsuite) as suite:
        return Profiles(suite).metadata(connection, uuid)


@router.get(
    "/{uuid}/functions",
    dependencies=[require_scope(Scope.READ)],
    summary="List a profile's functions",
    responses=suite_responses(not_found=_NO_PROFILE),
)
def list_profile_functions(
    testsuite: str, uuid: UuidKey, engine: EngineDep, registry: RegistryDep
) -> Items[ProfileFunction]:
    """Every function the profile measured, by name (I2, E7).

    Unpaginated, since O7 caps a profile's functions.
    """
    with engine.connect() as connection, suite_scope(registry, connection, testsuite) as suite:
        return Items(items=Profiles(suite).functions(connection, uuid))


@router.get(
    "/{uuid}/disassembly",
    dependencies=[require_scope(Scope.READ)],
    summary="Get a function's disassembly",
    responses=suite_responses(not_found=_NO_FUNCTION),
)
def get_profile_disassembly(
    testsuite: str,
    uuid: UuidKey,
    function: Annotated[
        str,
        Query(
            description=(
                "The name of the function, exactly as the functions response gives it. 404 if the "
                "profile holds no function of that name."
            )
        ),
    ],
    engine: EngineDep,
    registry: RegistryDep,
) -> FunctionDisassembly:
    """One function's disassembly and the counters measured along it (E7)."""
    with engine.connect() as connection, suite_scope(registry, connection, testsuite) as suite:
        disassembly_format, counters, stored = Profiles(suite).disassembly(
            connection, uuid, function
        )

    # The connection is released before the instructions are decompressed, so that a pooled
    # connection and its open transaction are not held across the expensive part.
    return FunctionDisassembly(
        name=function,
        counters=counters,
        disassembly_format=disassembly_format,
        instructions=[
            Instruction(address=address, counters=values, text=text)
            for address, values, text in instructions(stored)
        ],
    )


@router.get(
    "/{uuid}/document",
    dependencies=[require_scope(Scope.READ)],
    summary="Get a whole profile, as a document",
    response_model=ProfileDocument,
    responses=suite_responses(not_found=_NO_PROFILE),
)
def get_profile_document(
    testsuite: str, uuid: UuidKey, engine: EngineDep, registry: RegistryDep
) -> Response:
    """The whole profile in one response, as the profile document a submission carries (E7)."""
    with engine.connect() as connection, suite_scope(registry, connection, testsuite) as suite:
        disassembly_format, counters, functions = Profiles(suite).document(connection, uuid)

    # As for the disassembly, the connection is released before anything is decompressed. Encoded
    # with msgspec rather than through the response model, for the reason `suites.profile_document`
    # parses with it: a profile can hold hundreds of thousands of instructions. A memoryview is sent
    # as it is, where `bytes` would copy a document of up to O7's 32 MiB.
    document = memoryview(document_json(disassembly_format, counters, functions))
    return Response(document, media_type="application/json")

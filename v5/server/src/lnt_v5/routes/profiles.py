"""Profiles: instruction-level counter data for one test in one run (E7).

Read-only: a profile is submitted inside a run, and stored as a `{suite}.profile` row and a
`{suite}.profile_function` row per function (D5, O7). Four endpoints address a profile by its
UUID, and the run's listing is how a client that knows a run and a test finds that UUID. A function
is named in `function=` rather than in the path, since its name can contain `/` (I1).
"""

from __future__ import annotations

from typing import Annotated, Any

from fastapi import APIRouter, Path, Query, Response
from pydantic import BaseModel, Field
from sqlalchemy import Connection, Row, Select, Table, and_, select

from lnt_v5 import examples
from lnt_v5.auth import require_scope
from lnt_v5.db import EngineDep
from lnt_v5.errors import ApiError, ErrorCode
from lnt_v5.responses import Items
from lnt_v5.routes.runs import NO_RUN, RUNS_PATH, RunKey, run_id
from lnt_v5.routes.suites import SUITES_PATH
from lnt_v5.scopes import Scope
from lnt_v5.suites.entities import UuidKey, identifier
from lnt_v5.suites.profile_document import document_json, instructions
from lnt_v5.suites.registry import RegistryDep, Suite
from lnt_v5.suites.scope import SuiteName, suite_responses, suite_scope

PROFILES_PATH = f"{SUITES_PATH}/{{testsuite}}/profiles"
RUN_PROFILES_PATH = f"{RUNS_PATH}/{{uuid}}/profiles"

router = APIRouter(prefix=PROFILES_PATH, tags=["Profiles"])

# The one route under a run rather than under `/profiles`, tagged so that I8's document groups it
# with the profiles.
run_profiles_router = APIRouter(prefix=RUNS_PATH, tags=["Profiles"])

# `suite_scope`'s 404, widened with the cases these endpoints add.
_NO_PROFILE = "The test suite or the profile doesn't exist."
_NO_FUNCTION = "The test suite, the profile, or the function doesn't exist."

# The path segment naming a profile.
ProfileKey = Annotated[UuidKey, Path(description="The profile's UUID (not case-sensitive).")]

# The docstrings of the models and endpoints below, and the field descriptions, are published, as
# the descriptions I8's document gives them, so they are written for API users.

# Field descriptions more than one response model carries.
_TEST = "The name of the test the profile was measured for."
_DISASSEMBLY_FORMAT = "The tool that produced the instruction text, for example `llvm-objdump`."
_INSTRUCTIONS = "The function's instructions, in their original order."
_FUNCTION_COUNTERS = (
    "The function's counters, keyed by counter name. Each is the sum of that counter over the "
    "function's instructions. A function may have fewer counters than the profile as a whole."
)


class RunProfile(BaseModel):
    """A profile in a run: the test it is for, and its UUID."""

    test: str = Field(description=_TEST, examples=[examples.TEST])
    uuid: str = Field(
        description="The profile's UUID, used by the other profile operations.",
        examples=[examples.PROFILE_UUID],
    )


class ProfileMetadata(BaseModel):
    """A profile's test, run and top-level counters. All counters are raw counts, not
    percentages."""

    uuid: str = Field(description="The profile's UUID.", examples=[examples.PROFILE_UUID])
    test: str = Field(description=_TEST, examples=[examples.TEST])
    run_uuid: str = Field(
        description="The UUID of the run the profile belongs to.", examples=[examples.RUN_UUID]
    )
    counters: dict[str, int] = Field(
        description=(
            "The profile's counters, keyed by counter name. They are totals for the whole profile, "
            "including functions it doesn't list. Unlike the other counters, these are integers."
        ),
        examples=[examples.PROFILE_COUNTERS],
    )
    disassembly_format: str = Field(
        description=_DISASSEMBLY_FORMAT, examples=[examples.DISASSEMBLY_FORMAT]
    )


class ProfileFunction(BaseModel):
    """One function of a profile, without its instructions."""

    name: str = Field(description="The function's name.", examples=[examples.FUNCTION])
    counters: dict[str, float] = Field(
        description=(
            f"{_FUNCTION_COUNTERS} To get a percentage of the profile, divide by the profile's "
            "counter of the same name."
        ),
        examples=[examples.FUNCTION_COUNTERS],
    )
    length: int = Field(description="The number of instructions in the function.")


class Instruction(BaseModel):
    """One instruction of a function."""

    address: int = Field(
        description="The instruction's address. Can't be negative.", examples=[4096]
    )
    counters: dict[str, float] = Field(
        description=(
            "The counts measured at this instruction, keyed by counter name. They can't be "
            "negative. All instructions of a function must have the same counters, and each must "
            "also be one of the profile's counters."
        ),
        examples=[examples.INSTRUCTION_COUNTERS],
    )
    text: str = Field(
        description="The disassembled instruction.", examples=[examples.INSTRUCTION_TEXT]
    )


class FunctionDisassembly(BaseModel):
    """One function of a profile, with its instructions."""

    name: str = Field(description="The function's name.", examples=[examples.FUNCTION])
    counters: dict[str, float] = Field(
        description=_FUNCTION_COUNTERS, examples=[examples.FUNCTION_COUNTERS]
    )
    disassembly_format: str = Field(
        description=_DISASSEMBLY_FORMAT, examples=[examples.DISASSEMBLY_FORMAT]
    )
    instructions: list[Instruction] = Field(description=_INSTRUCTIONS)


class DocumentFunction(BaseModel):
    """One function in a profile document: its name and its instructions. The function's own
    counters aren't included, since they are just the sums over its instructions."""

    name: str = Field(
        description="The function's name. Can't be empty, and must be unique.",
        examples=[examples.FUNCTION],
    )
    instructions: list[Instruction] = Field(description=_INSTRUCTIONS)


# Describes the response for I8 only: the endpoint encodes the document itself.
class ProfileDocument(BaseModel):
    """A complete profile. This is also the format of a test's `profile` in a run submission,
    where it is gzip-compressed and then base64-encoded.

    All counters are raw counts, not percentages.
    """

    disassembly_format: str = Field(
        description=_DISASSEMBLY_FORMAT, examples=[examples.DISASSEMBLY_FORMAT]
    )
    counters: dict[str, int] = Field(
        description=(
            "The profile's counters, keyed by counter name. They are totals for the whole profile, "
            "including functions it doesn't list, and can't be negative."
        ),
        examples=[examples.PROFILE_COUNTERS],
    )
    functions: list[DocumentFunction] = Field(
        description=(
            "The profile's functions. When returned by the API, they are sorted by name, which may "
            "differ from the order they were submitted in."
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


# Unpaginated: a run holds at most one profile per test it measured, so the response is bounded by
# the run itself (I2).
@run_profiles_router.get(
    "/{uuid}/profiles",
    dependencies=[require_scope(Scope.READ)],
    summary="List a run's profiles",
    responses=suite_responses(not_found=NO_RUN),
)
def list_run_profiles(
    testsuite: SuiteName, uuid: RunKey, engine: EngineDep, registry: RegistryDep
) -> Items[RunProfile]:
    """The run's profiles: which tests have one, and each profile's UUID, sorted by test name. A
    run has at most one profile per test."""
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
    testsuite: SuiteName, uuid: ProfileKey, engine: EngineDep, registry: RegistryDep
) -> ProfileMetadata:
    """Get a profile's test, run and top-level counters."""
    with engine.connect() as connection, suite_scope(registry, connection, testsuite) as suite:
        return Profiles(suite).metadata(connection, uuid)


# Unpaginated, since O7 caps a profile's functions.
@router.get(
    "/{uuid}/functions",
    dependencies=[require_scope(Scope.READ)],
    summary="List a profile's functions",
    responses=suite_responses(not_found=_NO_PROFILE),
)
def list_profile_functions(
    testsuite: SuiteName, uuid: ProfileKey, engine: EngineDep, registry: RegistryDep
) -> Items[ProfileFunction]:
    """The functions in a profile, with their counters but without their instructions, sorted by
    name."""
    with engine.connect() as connection, suite_scope(registry, connection, testsuite) as suite:
        return Items(items=Profiles(suite).functions(connection, uuid))


@router.get(
    "/{uuid}/disassembly",
    dependencies=[require_scope(Scope.READ)],
    summary="Get a function's disassembly",
    responses=suite_responses(not_found=_NO_FUNCTION),
)
def get_profile_disassembly(
    testsuite: SuiteName,
    uuid: ProfileKey,
    function: Annotated[
        str,
        Query(
            description=(
                "The function's name, as returned by the function list. Returns 404 if the profile "
                "has no such function."
            )
        ),
    ],
    engine: EngineDep,
    registry: RegistryDep,
) -> FunctionDisassembly:
    """One function of a profile, with the counters measured at each instruction. The function is
    passed as a query parameter because its name can contain '/'."""
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
    summary="Get a complete profile",
    response_model=ProfileDocument,
    responses=suite_responses(not_found=_NO_PROFILE),
)
def get_profile_document(
    testsuite: SuiteName, uuid: ProfileKey, engine: EngineDep, registry: RegistryDep
) -> Response:
    """The complete profile in a single response.

    To copy a profile to another run or instance, gzip-compress and base64-encode this document
    and submit it as a test's `profile`. The result may be larger than what was originally
    submitted, so a profile close to the size limits may exceed them when copied.
    """
    with engine.connect() as connection, suite_scope(registry, connection, testsuite) as suite:
        disassembly_format, counters, functions = Profiles(suite).document(connection, uuid)

    # As for the disassembly, the connection is released before anything is decompressed. Encoded
    # with msgspec rather than through the response model, for the reason `suites.profile_document`
    # parses with it: a profile can hold hundreds of thousands of instructions. A memoryview is sent
    # as it is, where `bytes` would copy a document of up to O7's 32 MiB.
    document = memoryview(document_json(disassembly_format, counters, functions))
    return Response(document, media_type="application/json")

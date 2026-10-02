"""Profiles: instruction-level counter data for one test in one run (endpoints.md, Profiles).

Read-only. A profile is submitted inside a run as a JSON document, which the server validates and
stores as a `{suite}.profile` row and a `{suite}.profile_function` row per function (D5, D12). Three
of these endpoints address a profile by its own UUID and one lists a run's, which is the bridge the
client crosses: it knows a run and a test name and needs the UUID the other three take (see
`client/profiles.md`).

Two things here follow from the design docs rather than from convenience.

**A function's instructions stay out of the default result set** (D5). SQLAlchemy Core selects the
columns it is asked for, so that obligation falls on each query rather than on the table, and only
the disassembly names `instructions`, for the one function it serves. Everything else a profile
holds is small and stored as it is served, so the other three endpoints decompress nothing.

**A function is named in the `function=` query parameter, never in the path** (R1). The name is
whatever the producer recorded, and one that demangles records an `operator/` overload as
`std::operator/(...)`, so it can contain `/` -- which a path segment cannot carry, since `%2F` is
decoded before routing. That is also why a test is named in `test=`.
"""

from __future__ import annotations

from typing import Annotated, Any

from fastapi import APIRouter, Query
from pydantic import BaseModel, Field
from sqlalchemy import Connection, Row, Select, Table, select

from lnt_v5.auth import require_scope
from lnt_v5.db import EngineDep
from lnt_v5.errors import ApiError, ErrorCode
from lnt_v5.responses import Items
from lnt_v5.routes.runs import NO_RUN, RUNS_PATH, run_id
from lnt_v5.routes.suites import SUITES_PATH
from lnt_v5.scopes import Scope
from lnt_v5.suites.entities import UuidKey
from lnt_v5.suites.profile_document import instructions
from lnt_v5.suites.registry import RegistryDep, Suite
from lnt_v5.suites.scope import SUITE_NOT_FOUND, suite_responses, suite_scope

PROFILES_PATH = f"{SUITES_PATH}/{{testsuite}}/profiles"
RUN_PROFILES_PATH = f"{RUNS_PATH}/{{uuid}}/profiles"

router = APIRouter(prefix=PROFILES_PATH, tags=["Profiles"])

# The one route that hangs off a run rather than off `/profiles`. A router of its own because its
# prefix is the runs', and it is tagged with the profiles so that R8's document groups it where
# endpoints.md specifies it -- the same arrangement `runs.machine_runs_router` makes.
run_profiles_router = APIRouter(prefix=RUNS_PATH, tags=["Profiles"])

# Every operation here reaches the suite's own tables, so every one can answer both of the failures
# `suite_scope` produces; each widens the wording with the cases it adds of its own.
_NO_PROFILE = f"{SUITE_NOT_FOUND} Or no profile in it has that UUID."
_NO_FUNCTION = f"{_NO_PROFILE} Or the profile holds no function of that name."

# Field descriptions more than one response model carries.
_TEST = "The name of the test this profile was measured for."
_DISASSEMBLY_FORMAT = "How the instruction text was produced, for example `llvm-objdump`."


class RunProfile(BaseModel):
    """A profile as a run's listing carries it: what it measured, and how to ask for it."""

    test: str = Field(description=_TEST)
    uuid: str = Field(
        description="Identifies the profile. Server-generated (R1); the profile data endpoints "
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
    """One function of a profile, as the function list carries it."""

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
            "The function's counters, keyed by counter name: the same sums the function list "
            "carries."
        )
    )
    disassembly_format: str = Field(description=_DISASSEMBLY_FORMAT)
    instructions: list[Instruction] = Field(
        description=(
            "The function's instructions, in the order the profile records them. A field of this "
            "response rather than a list endpoint's body, so it keeps its own name (R2)."
        )
    )


class Profiles:
    """The queries the profile endpoints are built from, and how to read one of their rows back.

    Only `disassembly` names a function's `instructions`; that is D5's rule rather than an
    optimization -- see the module docstring.
    """

    def __init__(self, suite: Suite) -> None:
        self.schema = suite.schema
        self.table: Table = suite.tables.profile
        self._function: Table = suite.tables.profile_function
        self._test: Table = suite.tables.test
        self._run: Table = suite.tables.run

    def of_run(self, run: int) -> Select[Any]:
        """Every profile attached to one run, by test name (endpoints.md).

        Ordered by name where `GET /runs/{uuid}/samples` deliberately is not, and the difference is
        the size of the result. That list pages over the tens of thousands of samples a run holds,
        so ordering it by a column no index offers would cost a sort of the whole run on every
        page; this one is bounded by the tests of a run that carry a profile, and the client renders
        it straight into a dropdown (`client/profiles.md`, "Test").
        """
        return (
            select(self._test.c.name, self.table.c.uuid)
            .select_from(self.table.join(self._test, self._test.c.id == self.table.c.test_id))
            .where(self.table.c.run_id == run)
            .order_by(self._test.c.name)
        )

    def read(self, row: Row[Any]) -> RunProfile:
        # By column object rather than by name, the convention everywhere a row spans two tables:
        # `Row._mapping` keyed by a column cannot pick the wrong one of a pair sharing a name.
        return RunProfile(
            test=row._mapping[self._test.c.name], uuid=row._mapping[self.table.c.uuid]
        )

    def metadata(self, connection: Connection, uuid: str) -> ProfileMetadata:
        """One profile's metadata, or the 404 for a UUID nothing holds.

        The two joined columns are what R4 makes the response carry: a reference to another entity
        is that entity's identifier, so the test's name and the run's UUID rather than the ids D5
        stores.
        """
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
        """Every function of one profile, in no particular order, or the 404 for a missing UUID."""
        profile = self._id(connection, uuid)
        rows = connection.execute(
            select(self._function.c.name, self._function.c.counters, self._function.c.length).where(
                self._function.c.profile_id == profile
            )
        )
        return [
            ProfileFunction(name=name, counters=counters, length=length)
            for name, counters, length in rows
        ]

    def disassembly(
        self, connection: Connection, uuid: str, name: str
    ) -> tuple[str, dict[str, float], bytes]:
        """One function's disassembly format, counters and stored instructions, or the 404 for a
        profile or a function that is not there."""
        profile = connection.execute(
            select(self.table.c.id, self.table.c.disassembly_format).where(
                self.table.c.uuid == uuid
            )
        ).one_or_none()
        if profile is None:
            raise self.missing(uuid)
        row = connection.execute(
            select(self._function.c.counters, self._function.c.instructions).where(
                self._function.c.profile_id == profile.id, self._function.c.name == name
            )
        ).one_or_none()
        if row is None:
            raise ApiError(
                ErrorCode.NOT_FOUND,
                f"Profile '{uuid}' in test suite '{self.schema.name}' holds no function named "
                f"'{name}'",
            )
        return profile.disassembly_format, row.counters, row.instructions

    def _id(self, connection: Connection, uuid: str) -> int:
        found = connection.execute(
            select(self.table.c.id).where(self.table.c.uuid == uuid)
        ).scalar_one_or_none()
        if found is None:
            raise self.missing(uuid)
        return int(found)

    def missing(self, uuid: str) -> ApiError:
        """The 404 for a profile that is not there, worded in one place for all its callers."""
        return ApiError(
            ErrorCode.NOT_FOUND, f"No profile '{uuid}' in test suite '{self.schema.name}'"
        )


def _hotness(function: ProfileFunction) -> tuple[float, str]:
    """The function list's order (endpoints.md): hottest first, ties broken by name.

    The sum across a function's counters is a default rather than a physical quantity -- adding
    cycles to branch misses means nothing -- and endpoints.md says so: the client re-sorts by
    whichever single counter the user picked. What the sum has to be is *total*, so that the list
    comes back in the same order every time, which is what the name tiebreaker adds.
    """
    return (-sum(function.counters.values()), function.name)


@run_profiles_router.get(
    "/{uuid}/profiles",
    dependencies=[require_scope(Scope.READ)],
    summary="List a run's profiles",
    responses=suite_responses(not_found=NO_RUN),
)
def list_run_profiles(
    testsuite: str, uuid: UuidKey, engine: EngineDep, registry: RegistryDep
) -> Items[RunProfile]:
    """Which tests of one run have a profile, and the UUID of each (R2).

    Unpaginated: a run holds at most one profile per test it measured, so the list is bounded by
    the run itself.
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
    """What a profile is of, and its top-level counters (endpoints.md)."""
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
    """Every function the profile measured, hottest first (R2, endpoints.md).

    Unpaginated: D12 caps a profile's functions, and the client renders all of them into one
    combobox (`client/profiles.md`, "Function Selector"). Sorted here rather than in SQL, since
    the order is a sum over a JSONB object's values.
    """
    with engine.connect() as connection, suite_scope(registry, connection, testsuite) as suite:
        functions = Profiles(suite).functions(connection, uuid)
    return Items(items=sorted(functions, key=_hotness))


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
                "The name of the function, exactly as the function list gives it. 404 if the "
                "profile holds no function of that name."
            )
        ),
    ],
    engine: EngineDep,
    registry: RegistryDep,
) -> FunctionDisassembly:
    """One function's disassembly and the counters measured along it (endpoints.md).

    The one endpoint that decompresses anything, and only the function it serves; D12's caps on a
    submitted profile are what keep that bounded.

    The connection is given back before decompressing. Holding a pooled connection -- and the open
    transaction that pins the vacuum horizon -- across it would be the anti-pattern D13 names for
    submission, on the one read that would really pay for it.
    """
    with engine.connect() as connection, suite_scope(registry, connection, testsuite) as suite:
        disassembly_format, counters, stored = Profiles(suite).disassembly(
            connection, uuid, function
        )

    return FunctionDisassembly(
        name=function,
        counters=counters,
        disassembly_format=disassembly_format,
        instructions=[
            Instruction(address=address, counters=values, text=text)
            for address, values, text in instructions(stored)
        ],
    )

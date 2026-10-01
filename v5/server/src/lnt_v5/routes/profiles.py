"""Profiles: instruction-level counter data for one test in one run (endpoints.md, Profiles).

Read-only. A profile is submitted inside a run as a JSON document, which the server validates and
stores in the binary format `profile_format` describes (D12), so these four endpoints are the only
thing that reads one. Three of them address a profile by its own UUID and one lists a run's, which
is the bridge the client crosses: it knows a run and a test name and needs the UUID the other three
take (see `client/profiles.md`).

Three things here follow from the design docs rather than from convenience.

**The blob stays out of the default result set** (D5, D12). SQLAlchemy Core selects the columns it
is asked for, so that obligation falls on each query rather than on the table, and only the three
queries that actually serve the profile's contents name `data`. The listing does not: a run may
carry a profile per test, and `select(profile)` there would pull tens of megabytes off the disk to
render a list of names.

**Reading a profile costs one parse, and as little decompression as the endpoint needs.** The
format's index is uncompressed and its per-instruction data is not (`profile_format`), so the
metadata and function-list endpoints never decompress anything and only a request for one
function's disassembly pays for it. Nothing is cached between requests: a parse is cheap next to
the round trip that fetched the blob, and a cache keyed by blobs would be the largest thing in the
process.

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

from lnt_v5 import profile_format
from lnt_v5.auth import require_scope
from lnt_v5.db import EngineDep
from lnt_v5.errors import ApiError, ErrorCode
from lnt_v5.responses import Items
from lnt_v5.routes.runs import NO_RUN, RUNS_PATH, run_id
from lnt_v5.routes.suites import SUITES_PATH
from lnt_v5.scopes import Scope
from lnt_v5.suites.entities import UuidKey
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


class RunProfile(BaseModel):
    """A profile as a run's listing carries it: what it measured, and how to ask for it."""

    test: str = Field(description="The name of the test this profile was measured for.")
    uuid: str = Field(
        description="Identifies the profile. Server-generated (R1); the profile data endpoints "
        "take it."
    )


class ProfileMetadata(BaseModel):
    """What a profile is of, and the counters it measured as a whole."""

    uuid: str = Field(description="Identifies the profile.")
    test: str = Field(description="The name of the test this profile was measured for.")
    run_uuid: str = Field(description="The UUID of the run this profile belongs to.")
    counters: dict[str, int] = Field(
        description=(
            "The profile's top-level counters, keyed by counter name. Raw totals for the whole "
            "profile, and integers -- unlike every other counter here, which is a float."
        )
    )
    disassembly_format: str = Field(
        description="How the instruction text was produced, for example `llvm-objdump`."
    )


class ProfileFunction(BaseModel):
    """One function of a profile, as the function list carries it."""

    name: str = Field(description="The function's name, as the profile's producer recorded it.")
    counters: dict[str, float] = Field(
        description=(
            "The function's counters, keyed by counter name: each the sum of that counter over the "
            "function's instructions. Raw counts kept to single precision, not percentages: a "
            "client that wants a share of the profile computes it against the top-level counters. "
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
            "The counts measured at this instruction, keyed by counter name. Raw counts kept to "
            "single precision, not percentages, and the same counters the function carries."
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
    disassembly_format: str = Field(
        description="How the instruction text was produced, for example `llvm-objdump`."
    )
    instructions: list[Instruction] = Field(
        description=(
            "The function's instructions, in the order the profile records them. A field of this "
            "response rather than a list endpoint's body, so it keeps its own name (R2)."
        )
    )


class Profiles:
    """The queries the profile endpoints are built from, and how to read one of their rows back.

    Three of them name `data` because they serve what is in it; the listing must not, and that is
    D5's rule rather than an optimization -- see the module docstring.
    """

    def __init__(self, suite: Suite) -> None:
        self.schema = suite.schema
        self.table: Table = suite.tables.profile
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

    def described(self, connection: Connection, uuid: str) -> tuple[str, str, bytes]:
        """One profile's test name, run UUID and blob, or the 404 for a UUID nothing holds.

        The two joined columns are what R4 makes the metadata response carry: a reference to
        another entity is that entity's identifier, so the test's name and the run's UUID rather
        than the ids D5 stores.
        """
        row = connection.execute(
            select(self._test.c.name, self._run.c.uuid, self.table.c.data)
            .select_from(
                self.table.join(self._test, self._test.c.id == self.table.c.test_id).join(
                    self._run, self._run.c.id == self.table.c.run_id
                )
            )
            .where(self.table.c.uuid == uuid)
        ).one_or_none()
        if row is None:
            raise self.missing(uuid)
        return (
            row._mapping[self._test.c.name],
            row._mapping[self._run.c.uuid],
            row._mapping[self.table.c.data],
        )

    def blob(self, connection: Connection, uuid: str) -> bytes:
        """One profile's stored bytes, for the two endpoints that serve nothing else about it."""
        row = connection.execute(
            select(self.table.c.data).where(self.table.c.uuid == uuid)
        ).one_or_none()
        if row is None:
            raise self.missing(uuid)
        data: bytes = row._mapping[self.table.c.data]
        return data

    def missing(self, uuid: str) -> ApiError:
        """The 404 for a profile that is not there, worded in one place for all its callers."""
        return ApiError(
            ErrorCode.NOT_FOUND, f"No profile '{uuid}' in test suite '{self.schema.name}'"
        )


def _hotness(function: profile_format.Function) -> tuple[float, str]:
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
    the run itself. It opens no blob; see the module docstring.
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
    """What a profile is of, and its top-level counters (endpoints.md).

    Reads the index alone: the top-level counters live in an uncompressed section, so answering
    this costs no decompression at all.
    """
    with engine.connect() as connection, suite_scope(registry, connection, testsuite) as suite:
        test, run, data = Profiles(suite).described(connection, uuid)

    profile = profile_format.read_profile(data)
    return ProfileMetadata(
        uuid=uuid,
        test=test,
        run_uuid=run,
        counters=dict(profile.counters),
        disassembly_format=profile.disassembly_format,
    )


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

    Unpaginated: the list is bounded by the functions of one binary, and the client renders all of
    it into one combobox (`client/profiles.md`, "Function Selector"). Like the metadata endpoint
    this reads the index alone -- a function's aggregate counters and its instruction count are
    both in it, which is the whole reason the format keeps an index.
    """
    with engine.connect() as connection, suite_scope(registry, connection, testsuite) as suite:
        data = Profiles(suite).blob(connection, uuid)

    profile = profile_format.read_profile(data)
    return Items(
        items=[
            ProfileFunction(
                name=function.name, counters=dict(function.counters), length=function.length
            )
            for function in sorted(profile.functions.values(), key=_hotness)
        ]
    )


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

    The one endpoint that decompresses, and it decompresses the whole profile's per-instruction
    sections to serve one function of it -- the format stores them as four streams rather than one
    per function, so there is nothing smaller to expand. D12's caps on a submitted profile are what
    keep that bounded.

    The connection is given back before any of that runs. Expanding a large profile and building
    its instructions is the most expensive thing any read in this API does, and holding a pooled
    connection -- and the open transaction that pins the vacuum horizon -- across it would be the
    anti-pattern D13 names for submission, on the one read that would really pay for it.
    """
    with engine.connect() as connection, suite_scope(registry, connection, testsuite) as suite:
        data = Profiles(suite).blob(connection, uuid)
        name = suite.schema.name

    profile = profile_format.read_profile(data)
    measured = profile.functions.get(function)
    if measured is None:
        raise ApiError(
            ErrorCode.NOT_FOUND,
            f"Profile '{uuid}' in test suite '{name}' holds no function named '{function}'",
        )
    return FunctionDisassembly(
        name=function,
        counters=dict(measured.counters),
        disassembly_format=profile.disassembly_format,
        instructions=[
            Instruction(
                address=instruction.address,
                counters=dict(instruction.counters),
                text=instruction.text,
            )
            for instruction in profile.instructions(function)
        ],
    )

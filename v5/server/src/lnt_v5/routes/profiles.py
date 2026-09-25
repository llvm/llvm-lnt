"""Profiles: instruction-level counter data for one test in one run (endpoints.md, Profiles).

Read-only. A profile is produced elsewhere, submitted inside a run (D12) and stored verbatim, so
these four endpoints are the only thing that looks inside one. Three of them address a profile by
its own UUID and one lists a run's, which is the bridge the client crosses: it knows a run and a
test name and needs the UUID the other three take (see `client/profiles.md`).

Four things here follow from the design docs rather than from convenience.

**The blob stays out of the default result set** (D5, D12). SQLAlchemy Core selects the columns it
is asked for, so that obligation falls on each query rather than on the table, and only the three
queries that actually serve the profile's contents name `data`. The listing does not: a run may
carry a profile per test, and `select(profile)` there would pull tens of megabytes off the disk to
render a list of names.

**Reading a profile costs one parse, and as little decompression as the endpoint needs.** The
format's index is uncompressed and its per-instruction data is not (`profile_format`), so the
metadata and function-list endpoints never decompress anything and only a request for one
function's disassembly pays for it. Nothing is cached between requests: a parse is cheap next to
the round trip that fetched the blob, and a cache keyed by a 50 MB blob would be the largest thing
in the process.

**A blob the server stored and cannot read is a 500** (R4, which names exactly this case). It is
not the caller's mistake -- the request was well-formed and named a profile that exists -- so the
message says what is wrong with the blob rather than what the caller should do differently. A
function name the profile does not hold is the other thing entirely, and is a 404, answered by
asking the index whether it holds the name rather than by catching anything: the two failures are
then told apart by which question was asked, not by which exception a lookup happened to raise.

**A function name spans the remainder of its path** (`{fn_name:path}`). R1 keeps natural keys
containing `/` out of paths, and a function name can certainly contain one: the name is whatever
the producer recorded, and a producer that demangles -- v4's importer runs `objdump -C` -- records
an `operator/` overload as `std::operator/(...)`. What rescues it here, and did not rescue a test
name, is position: the name is the *last* segment of its path, so a greedy segment can take all of
it and there is nothing after it to collide with. `/` and `%2F` are interchangeable in it, since
the server decodes before routing and the greedy segment captures the result either way -- with the
residual exceptions R1 records, which no symbol a compiler emits can hit.
"""

from __future__ import annotations

import logging
from typing import Annotated, Any

from fastapi import APIRouter, Path
from pydantic import BaseModel, Field
from sqlalchemy import Connection, Row, Select, Table, select

from lnt_v5 import profile_format
from lnt_v5.auth import require_scope
from lnt_v5.db import EngineDep
from lnt_v5.errors import ApiError, ErrorCode, ErrorEnvelope
from lnt_v5.responses import Items
from lnt_v5.routes.runs import NO_RUN, RUNS_PATH, run_id
from lnt_v5.routes.suites import SUITES_PATH
from lnt_v5.scopes import Scope
from lnt_v5.suites.entities import UuidPath
from lnt_v5.suites.registry import RegistryDep, Suite
from lnt_v5.suites.scope import SUITE_NOT_FOUND, suite_responses, suite_scope

logger = logging.getLogger(__name__)

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

# R4's 500, which endpoints.md specifies for these three endpoints and which they therefore have to
# declare. Unlike the generic handler's 500 this one is specified behaviour: a blob is accepted at
# submission without being parsed (D12), so a profile the server holds and cannot read is a state
# the API has to have an answer for.
_UNREADABLE = "The stored profile blob cannot be deserialized."


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
            "The counter values aggregated over the whole function, keyed by counter name. Raw "
            "values, not percentages: a client that wants a share of the profile computes it "
            "against the top-level counters. A function carries only the counters it was measured "
            "with, which may be fewer than the profile has."
        )
    )
    length: int = Field(description="How many instructions the function's disassembly holds.")


class Instruction(BaseModel):
    """One instruction of a function's disassembly."""

    address: int = Field(description="The instruction's address.")
    counters: dict[str, float] = Field(
        description=(
            "The counter values measured at this instruction, keyed by counter name. Raw values, "
            "not percentages, and the same counters the function carries."
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
            "The counter values aggregated over the whole function, keyed by counter name. The "
            "same raw values the function list carries."
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


FunctionName = Annotated[
    str,
    Path(
        description=(
            "The function's name, spanning the rest of the path. A demangled C++ name may contain "
            "`/` -- `std::operator/(...)` -- so this segment deliberately does not stop at one; "
            "`/` and `%2F` are equivalent in it."
        )
    ),
]


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


def _parse(data: bytes, uuid: str) -> profile_format.Profile:
    """The profile a stored blob holds, or R4's `internal_error` for one that cannot be read."""
    try:
        return profile_format.read_profile(data)
    except profile_format.ProfileError as error:
        raise _unreadable(uuid, error) from error


def _unreadable(uuid: str, error: profile_format.ProfileError) -> ApiError:
    """R4's 500 for a stored blob that will not parse, logged on the way out.

    Logged because this is the one 500 that reports a durable fact about the data rather than a
    transient fault, and nothing else would record it: R4's envelope carries the reader's message
    to the caller, but the caller is not who has to fix it. The generic 500 reaches the log through
    Starlette's error middleware; an `ApiError` does not, so it is logged here.

    Shared by the two places a blob is read, which are the parse and the decompression it defers.
    """
    logger.warning("Profile '%s' cannot be read: %s", uuid, error)
    return ApiError(ErrorCode.INTERNAL_ERROR, f"Profile '{uuid}' cannot be read: {error}")


def _hotness(function: profile_format.Function) -> tuple[float, str]:
    """The function list's order (endpoints.md): hottest first, ties broken by name.

    The sum across a function's counters is a default rather than a physical quantity -- adding
    cycles to branch misses means nothing -- and endpoints.md says so: the client re-sorts by
    whichever single counter the user picked. What the sum has to be is *total*, so that the list
    comes back in the same order every time, which is what the name tiebreaker adds.
    """
    return (-sum(function.counters.values()), function.name)


def _profile_responses(not_found: str) -> dict[int | str, dict[str, Any]]:
    """The failures a profile data endpoint can answer: `suite_scope`'s two, and R4's 500."""
    return {
        **suite_responses(not_found=not_found),
        500: {"model": ErrorEnvelope, "description": _UNREADABLE},
    }


@run_profiles_router.get(
    "/{uuid}/profiles",
    dependencies=[require_scope(Scope.READ)],
    summary="List a run's profiles",
    responses=suite_responses(not_found=NO_RUN),
)
def list_run_profiles(
    testsuite: str, uuid: UuidPath, engine: EngineDep, registry: RegistryDep
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
    responses=_profile_responses(_NO_PROFILE),
)
def get_profile(
    testsuite: str, uuid: UuidPath, engine: EngineDep, registry: RegistryDep
) -> ProfileMetadata:
    """What a profile is of, and its top-level counters (endpoints.md).

    Reads the index alone: the top-level counters live in an uncompressed section, so answering
    this costs no decompression at all.
    """
    with engine.connect() as connection, suite_scope(registry, connection, testsuite) as suite:
        test, run, data = Profiles(suite).described(connection, uuid)

    profile = _parse(data, uuid)
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
    responses=_profile_responses(_NO_PROFILE),
)
def list_profile_functions(
    testsuite: str, uuid: UuidPath, engine: EngineDep, registry: RegistryDep
) -> Items[ProfileFunction]:
    """Every function the profile measured, hottest first (R2, endpoints.md).

    Unpaginated: the list is bounded by the functions of one binary, and the client renders all of
    it into one combobox (`client/profiles.md`, "Function Selector"). Like the metadata endpoint
    this reads the index alone -- a function's aggregate counters and its instruction count are
    both in it, which is the whole reason the format keeps an index.
    """
    with engine.connect() as connection, suite_scope(registry, connection, testsuite) as suite:
        data = Profiles(suite).blob(connection, uuid)

    profile = _parse(data, uuid)
    return Items(
        items=[
            ProfileFunction(
                name=function.name, counters=dict(function.counters), length=function.length
            )
            for function in sorted(profile.functions.values(), key=_hotness)
        ]
    )


@router.get(
    "/{uuid}/functions/{fn_name:path}",
    dependencies=[require_scope(Scope.READ)],
    summary="Get a function's disassembly",
    responses=_profile_responses(_NO_FUNCTION),
)
def get_profile_function(
    testsuite: str,
    uuid: UuidPath,
    fn_name: FunctionName,
    engine: EngineDep,
    registry: RegistryDep,
) -> FunctionDisassembly:
    """One function's disassembly and the counters measured along it (endpoints.md).

    The one endpoint that decompresses, and it decompresses the whole profile's per-instruction
    sections to serve one function of it -- the format stores them as four streams rather than one
    per function, so there is nothing smaller to expand. `MAX_DECOMPRESSED_SIZE` and
    `MAX_INSTRUCTIONS` are what keep that bounded (D12); exceeding either is reported as
    corruption, because from here a blob that expands without limit is indistinguishable from one
    that is malformed.

    The connection is given back before any of that runs. Expanding a large profile and building
    its instructions is the most expensive thing any read in this API does, and holding a pooled
    connection -- and the open transaction that pins the vacuum horizon -- across it would be the
    anti-pattern D13 names for submission, on the one read that would really pay for it.
    """
    with engine.connect() as connection, suite_scope(registry, connection, testsuite) as suite:
        data = Profiles(suite).blob(connection, uuid)
        name = suite.schema.name

    profile = _parse(data, uuid)
    function = profile.functions.get(fn_name)
    if function is None:
        raise ApiError(
            ErrorCode.NOT_FOUND,
            f"Profile '{uuid}' in test suite '{name}' holds no function named '{fn_name}'",
        )
    try:
        instructions = profile.instructions(fn_name)
    except profile_format.ProfileError as error:
        raise _unreadable(uuid, error) from error

    return FunctionDisassembly(
        name=fn_name,
        counters=dict(function.counters),
        disassembly_format=profile.disassembly_format,
        instructions=[
            Instruction(
                address=instruction.address,
                counters=dict(instruction.counters),
                text=instruction.text,
            )
            for instruction in instructions
        ],
    )

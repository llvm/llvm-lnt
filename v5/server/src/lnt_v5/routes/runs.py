"""Runs: one measurement of one commit on one machine (E4).

Submission is the one write in the API that creates five kinds of row at once -- the machine, the
commit, the tests, the run and its samples and profiles -- and O8 makes all of it one transaction:
either 201 or nothing at all. So this module is mostly about order and about statement count. The
order is validate, then resolve the entities a run points at, then write the run and everything that
points at the run. The statement count is what keeps a submission carrying tens of thousands of
samples from costing tens of thousands of statements: the samples, the profiles and their functions
each go in one `bulk.unnest_insert`, the test names through `concurrency.resolve_names`, and the
coverage rows in the single statement `coverage.add` runs.

What this module deliberately does not own: reading the payload, which is `suites/submission.py`'s
(pure, and finished before anything is written), and creating a machine or a commit, which belongs
with those entities -- `routes/machines.py` and `routes/commits.py` already hold their tables, their
constraint names and the wording of every 409 they answer.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from datetime import datetime
from typing import Annotated, Any, Literal
from uuid import uuid4

from fastapi import APIRouter, Body, Path, Query, Response
from pydantic import BaseModel, Field
from sqlalchemy import (
    ColumnElement,
    Connection,
    Insert,
    Integer,
    Row,
    Select,
    Table,
    any_,
    bindparam,
    delete,
    insert,
    or_,
    select,
)
from sqlalchemy.dialects.postgresql import ARRAY

from lnt_v5 import examples
from lnt_v5.auth import require_scope
from lnt_v5.db import EngineDep, reporting_violation
from lnt_v5.errors import ApiError, ErrorCode
from lnt_v5.querying import (
    DEFAULT_LIMIT,
    TIMESTAMP_HINT,
    Cursor,
    Keyset,
    Limit,
    Resolved,
    SortKey,
    cursor_page,
    exclusive_range,
    sort_order,
    uuid_prefix,
)
from lnt_v5.responses import CursorPage
from lnt_v5.routes.commits import Commits, commit_search
from lnt_v5.routes.machines import NO_MACHINE_FILTERED, Machines, machine_id, machine_search
from lnt_v5.routes.suites import SUITES_PATH
from lnt_v5.scopes import Scope
from lnt_v5.suites import coverage, summaries
from lnt_v5.suites.bulk import unnest_insert
from lnt_v5.suites.concurrency import resolve_names
from lnt_v5.suites.entities import DatetimeValue, UuidKey, identifier, location_of
from lnt_v5.suites.registry import RegistryDep, Suite
from lnt_v5.suites.scope import (
    SUITE_SCHEMA_CHANGED,
    SuiteName,
    schema_changed,
    suite_responses,
    suite_scope,
)
from lnt_v5.suites.submission import RunSubmission, SubmittedTest, validate_submission
from lnt_v5.suites.tables import RUN_COMMIT_CONSTRAINT, RUN_MACHINE_CONSTRAINT, RUN_UUID_CONSTRAINT

RUNS_PATH = f"{SUITES_PATH}/{{testsuite}}/runs"

router = APIRouter(prefix=RUNS_PATH, tags=["Runs"])

# endpoints.md names these and no others. A literal rather than a free string, so I8's document
# enumerates them and an unknown one is a 400 before the endpoint runs.
RunSort = Literal["submitted_at", "-submitted_at", "measured_at", "-measured_at"]

# How many machines or commits a run search looks up the ids of (see `Runs.search`).
_MAX_RESOLVED = 10_000

# Every operation here reaches the suite's own tables, so every one can answer both of the failures
# `suite_scope` produces; each widens the wording with the cases it adds of its own.
NO_RUN = "The test suite or the run doesn't exist."

# The path segment naming a run. Shared with the samples and profiles of a run, which live below it.
RunKey = Annotated[UuidKey, Path(description="The run's UUID (not case-sensitive).")]

# Built from `examples.py`, like every example in I8's document.
_SUBMIT_EXAMPLES = {
    "run": {
        "summary": "A run with repeated measurements",
        "value": {
            "format_version": "5",
            "measured_at": examples.MEASURED_AT,
            "machine": {"name": examples.MACHINE, "fields": examples.MACHINE_VALUES},
            "commit": {
                "value": examples.COMMIT,
                "ordinal": examples.ORDINAL,
                "fields": examples.COMMIT_VALUES,
            },
            "run_parameters": examples.RUN_PARAMETERS,
            "tests": [
                {
                    "name": examples.TEST,
                    "samples": [
                        examples.SAMPLE_METRICS,
                        examples.SAMPLE_METRICS | {"execution_time": 3.291},
                        {"execution_time": 3.279},
                    ],
                },
                {
                    "name": examples.OTHER_TEST,
                    "samples": [
                        {"execution_time": 412038.7, "instructions": 1932456.0, "cycles": 1508732.0}
                    ],
                },
            ],
        },
    },
}

# The docstrings of the models and endpoints below are published, as the descriptions I8's document
# gives them, so they are written for API users.


# `machine` and `commit` are the referenced entity's identifier rather than a nested object, which
# is I4's rule for one entity referring to another: a page of runs is long, and a client that wants
# more than the identity resolves a page of commits in one call to `POST /commits/resolve`.
class Run(BaseModel):
    """A run: one set of results, for one machine at one commit."""

    uuid: str = Field(
        description=(
            "The run's UUID, either chosen by the submitter or generated by the server. Always in "
            "lowercase."
        ),
        examples=[examples.RUN_UUID],
    )
    machine: str = Field(
        description="The name of the machine the run was measured on.", examples=[examples.MACHINE]
    )
    commit: str = Field(
        description="The value of the commit the run measured.",
        examples=[examples.COMMIT],
    )
    submitted_at: datetime = Field(
        description="When the server received the run. Set by the server."
    )
    measured_at: datetime = Field(
        description=(
            "When the run's data was measured, as given in its submission. The same as "
            "`submitted_at` if the submission didn't say."
        ),
        examples=[examples.MEASURED_AT],
    )


# `run_parameters` is detail-only because it is unbounded and no list view renders it -- the same
# reason a regression's `notes` is, and the reason the list endpoint does not even select it.
class RunDetail(Run):
    """A run, with the extra information it was submitted with."""

    run_parameters: dict[str, Any] = Field(
        description="The `run_parameters` the run was submitted with. Empty if there were none.",
        examples=[examples.RUN_PARAMETERS],
    )


class Runs:
    """The query every run response is built from, and how to read one of its rows back.

    The join is what makes a run renderable on its own: D5 stores a machine and a commit id, and I4
    wants the machine's name and the commit's value, so every read of a run pays for both. Held here
    rather than written per endpoint so that the detail and the list built on it cannot drift apart
    on the columns they name -- the same arrangement as `Machines` and `Commits`.

    The internal `id` rides along with the rest. It is never rendered -- I1 keeps auto-increment ids
    out of the API entirely -- but it is the unique tiebreaker O5 requires under every cursor, and
    the whole of the order the list takes when the caller asks for no sort.
    """

    def __init__(self, suite: Suite) -> None:
        self.suite = suite
        self.schema = suite.schema
        self.table: Table = suite.tables.run
        self._machine: Table = suite.tables.machine
        self._commit: Table = suite.tables.commit
        self._profile: Table = suite.tables.profile

    def select(self) -> Select[Any]:
        """The list query, deliberately without the unbounded `run_parameters`; `one` adds it."""
        return select(
            self.table.c.id,
            self.table.c.uuid,
            self._machine.c.name,
            self._commit.c.commit,
            self.table.c.submitted_at,
            self.table.c.measured_at,
        ).select_from(
            self.table.join(self._machine, self._machine.c.id == self.table.c.machine_id).join(
                self._commit, self._commit.c.id == self.table.c.commit_id
            )
        )

    def keyset(self, sort: RunSort | None) -> Keyset:
        """O5's ordering for a run list: the caller's sort, then the internal tiebreaker.

        Neither timestamp is unique -- nothing stops two runs being accepted, or measured, in the
        same instant, and the list pages -- so neither can be the whole order on its own. With no
        `sort` the tiebreaker is the whole order, which is the arbitrary but deterministic one O5
        allows.
        """
        if sort is None:
            return Keyset(tiebreaker=self.table.c.id)
        name, descending = sort_order(sort)
        return Keyset(SortKey(self.table.c[name], descending), tiebreaker=self.table.c.id)

    def search(self, connection: Connection, term: str) -> Resolved:
        """O4's `?search=` for a run list: its machine, its commit, or its UUID by prefix.

        The machine and commit predicates are those of `GET /machines?search=` and
        `GET /commits?search=`. Under an OR, PostgreSQL can use no index for a subquery, so the
        list would walk the whole run table whenever fewer runs match than fill a page -- the usual
        case for a commit or a UUID. It is therefore executed with the ids of the matching machines
        and commits looked up first, which lets PostgreSQL answer every branch from an index (D5's
        `(machine_id, measured_at)` and `commit_id`, and the one on `uuid`).

        That relies on the statement being planned with those ids, which a generic plan would not
        be: psycopg prepares a statement only once it has run several times on one connection, and
        forgets it when a transaction is rolled back, which is how this read-only request ends.

        A term that matches more than `_MAX_RESOLVED` machines or commits (a character or two, as
        typed) is executed as it stands instead, rather than with an array of most of the table's
        ids: so many runs then match that walking them in order fills a page at once.
        """
        machines = select(self._machine.c.id).where(machine_search(self.suite, term))
        commits = select(self._commit.c.id).where(commit_search(self.suite, term))

        def matching(machine_ids: Any, commit_ids: Any) -> ColumnElement[bool]:
            return or_(
                self.table.c.machine_id == any_(machine_ids),
                self.table.c.commit_id == any_(commit_ids),
                uuid_prefix(self.table.c.uuid, term),
            )

        stands_for = matching(machines.scalar_subquery(), commits.scalar_subquery())
        machine_ids = connection.scalars(machines.limit(_MAX_RESOLVED + 1)).all()
        commit_ids = connection.scalars(commits.limit(_MAX_RESOLVED + 1)).all()
        if max(len(machine_ids), len(commit_ids)) > _MAX_RESOLVED:
            return Resolved(stands_for=stands_for, executed=stands_for)
        return Resolved(
            stands_for=stands_for,
            executed=matching(
                bindparam(None, machine_ids, type_=ARRAY(Integer)),
                bindparam(None, commit_ids, type_=ARRAY(Integer)),
            ),
        )

    def has_profile(self) -> ColumnElement[bool]:
        """Whether this run carries profile data. D5's unique `(run_id, test_id)` indexes it."""
        return (
            select(1)
            .select_from(self._profile)
            .where(self._profile.c.run_id == self.table.c.id)
            .exists()
        )

    def commit_is(self, value: str) -> ColumnElement[bool]:
        """I3's `commit=`, over the join `select` already makes."""
        return self._commit.c.commit == value

    def read(self, row: Row[Any]) -> Run:
        # Not validated, like `Commits.read`: the model's validators are the rules for what a
        # request may write, and a stored row that breaks one still has to be served.
        return Run.model_construct(**self._attributes(row))

    def read_detail(self, row: Row[Any]) -> RunDetail:
        return RunDetail.model_construct(
            **self._attributes(row),
            run_parameters=row._mapping[self.table.c.run_parameters],
        )

    def _attributes(self, row: Row[Any]) -> dict[str, Any]:
        return {
            "uuid": row._mapping[self.table.c.uuid],
            "machine": row._mapping[self._machine.c.name],
            "commit": row._mapping[self._commit.c.commit],
            "submitted_at": row._mapping[self.table.c.submitted_at],
            "measured_at": row._mapping[self.table.c.measured_at],
        }

    def one(self, connection: Connection, uuid: str) -> RunDetail:
        row = connection.execute(
            self.select().add_columns(self.table.c.run_parameters).where(self.table.c.uuid == uuid)
        ).one_or_none()
        if row is None:
            raise self.missing(uuid)
        return self.read_detail(row)

    def missing(self, uuid: str) -> ApiError:
        """The 404 for a run that is not there, worded in one place for all its callers."""
        return _missing(self.schema.name, uuid)

    def create(
        self,
        connection: Connection,
        uuid: str,
        machine_id: int,
        commit_id: int,
        parameters: dict[str, Any],
        *,
        measured_at: datetime | None = None,
    ) -> int:
        """Insert the run row, or answer I4's `duplicate` for a UUID already used (O1).

        Or I4's `retry`, if the machine or the commit the submission resolved has been deleted since
        (O8): by its DELETE route or by O10's sweep, which takes the entity's row lock only after
        this transaction resolved it. Resending creates it again.

        `submitted_at` is deliberately not written: D5 gives the column a `now()` default, so the
        value comes from the database's clock rather than from this process, and concurrent workers
        agree on the ordering it defines. A `measured_at` the client omitted is left to the same
        default, so it equals `submitted_at` exactly. Both are read back through `select`
        afterwards.
        """
        taken = f"A run '{uuid}' already exists in test suite '{self.schema.name}'"

        def deleted(noun: str) -> str:
            return (
                f"The {noun} of this run was deleted from test suite '{self.schema.name}' while "
                "the run was being stored. Retry."
            )

        with (
            reporting_violation(RUN_UUID_CONSTRAINT, ErrorCode.DUPLICATE, taken),
            reporting_violation(RUN_MACHINE_CONSTRAINT, ErrorCode.RETRY, deleted("machine")),
            reporting_violation(RUN_COMMIT_CONSTRAINT, ErrorCode.RETRY, deleted("commit")),
        ):
            return int(
                connection.execute(
                    insert(self.table)
                    .values(
                        uuid=uuid,
                        machine_id=machine_id,
                        commit_id=commit_id,
                        run_parameters=parameters,
                        **({} if measured_at is None else {"measured_at": measured_at}),
                    )
                    .returning(self.table.c.id)
                ).scalar_one()
            )

    def add_samples(
        self,
        connection: Connection,
        run_id: int,
        tests: Sequence[SubmittedTest],
        ids: Mapping[str, int],
    ) -> None:
        """Every sample row the submission stands for, in one statement (O1).

        One statement rather than one per row because a submission legitimately carries tens of
        thousands of samples. Each is numbered by its position among its test's samples, which is
        what tells a test's repetitions apart in the key (D5).
        """
        samples = [sample for test in tests for sample in test.samples]
        if not samples:
            return
        connection.execute(
            self.suite.derived(_sample_insert),
            {
                "run_id": run_id,
                "test_id": [ids[test.name] for test in tests for _ in test.samples],
                "repetition": [index for test in tests for index in range(len(test.samples))],
                # Every sample carries every declared metric (see `suites/submission.py`).
                **{
                    metric.name: [sample[metric.name] for sample in samples]
                    for metric in self.schema.metrics
                },
            },
        )

    def add_profiles(
        self,
        connection: Connection,
        run_id: int,
        tests: Sequence[SubmittedTest],
        ids: Mapping[str, int],
    ) -> None:
        """The profile row of every run+test the submission carried one for, then their functions'
        rows, in one statement each (D5, O7).

        The UUID is minted here and never taken from the submission: I1 lets a client choose a
        run's UUID and a regression's, and no other. `created_at` is left to D5's column default,
        for the same reason `submitted_at` is.
        """
        profiles = {ids[test.name]: test.profile for test in tests if test.profile is not None}
        if not profiles:
            return
        # Matched back by test rather than by position: a run holds one profile per test (D5).
        inserted = connection.execute(
            self.suite.derived(_profile_insert),
            {
                "run_id": run_id,
                "uuid": [str(uuid4()) for _ in profiles],
                "test_id": list(profiles),
                "disassembly_format": [profile.disassembly_format for profile in profiles.values()],
                "counters": [profile.counters for profile in profiles.values()],
            },
        )
        profile_ids = dict(inserted.tuples().all())
        functions = [
            (profile_ids[test_id], function)
            for test_id, profile in profiles.items()
            for function in profile.functions
        ]
        if not functions:
            return
        connection.execute(
            self.suite.derived(_function_insert),
            {
                "profile_id": [profile_id for profile_id, _ in functions],
                "name": [function.name for _, function in functions],
                "counters": [function.counters for _, function in functions],
                "length": [function.length for _, function in functions],
                "instructions": [function.instructions for _, function in functions],
            },
        )


# The statements `Runs` writes a submission with, built once per suite (see `Suite.derived`).


def _sample_insert(suite: Suite) -> Insert:
    metrics = [metric.name for metric in suite.schema.metrics]
    return unnest_insert(
        suite.tables.sample, ["test_id", "repetition", *metrics], constants=["run_id"]
    )


def _profile_insert(suite: Suite) -> Insert:
    profile = suite.tables.profile
    return unnest_insert(
        profile, ["uuid", "test_id", "disassembly_format", "counters"], constants=["run_id"]
    ).returning(profile.c.test_id, profile.c.id)


def _function_insert(suite: Suite) -> Insert:
    return unnest_insert(
        suite.tables.profile_function, ["profile_id", "name", "counters", "length", "instructions"]
    )


def _missing(testsuite: str, uuid: str) -> ApiError:
    """The 404 for a run no suite holds, shared by the run routes and by its sub-resources."""
    return ApiError(ErrorCode.NOT_FOUND, f"No run '{uuid}' in test suite '{testsuite}'")


def run_id(connection: Connection, suite: Suite, uuid: str) -> int:
    """The id of the run a sub-resource hangs off, or the 404 for one that is not there.

    What `/runs/{uuid}/samples` and `/runs/{uuid}/profiles` anchor on: both filter on `run_id`, and
    reading the whole run to get it would select a two-table join and a JSONB blob to throw all of
    it away. The counterpart of `machines.machine_id`.
    """
    run = suite.tables.run
    return identifier(
        connection, run.c.uuid, uuid, lambda missed: _missing(suite.schema.name, missed)
    )


# I3's asymmetry between the two entity filters is deliberate and is visible here: an unknown
# `machine=` is a 404, because a caller that misspells a machine name wants to hear about it,
# whereas an unknown `commit=` is an empty page, because a commit the suite has never seen is an
# ordinary answer to "what ran at this revision".
@router.get(
    "",
    dependencies=[require_scope(Scope.READ)],
    summary="List runs",
    responses=suite_responses(not_found=NO_MACHINE_FILTERED),
)
def list_runs(
    testsuite: SuiteName,
    engine: EngineDep,
    registry: RegistryDep,
    cursor: Cursor = None,
    search: Annotated[
        str | None,
        Query(
            description=(
                "Only return runs whose machine (its name or any searchable field) or commit (its "
                "value, its tag or any searchable field) contains this text, or whose UUID starts "
                "with it. Not case-sensitive."
            )
        ),
    ] = None,
    machine: Annotated[
        str | None,
        Query(
            description=(
                "Only return runs on this machine. Returns 404 if the machine doesn't exist."
            )
        ),
    ] = None,
    commit: Annotated[
        str | None,
        Query(
            description=(
                "Only return runs of this commit. If the commit doesn't exist, the result is empty."
            )
        ),
    ] = None,
    submitted_after: Annotated[
        DatetimeValue | None,
        Query(
            description=f"Only return runs submitted after this time (exclusive). {TIMESTAMP_HINT}"
        ),
    ] = None,
    submitted_before: Annotated[
        DatetimeValue | None,
        Query(
            description=f"Only return runs submitted before this time (exclusive). {TIMESTAMP_HINT}"
        ),
    ] = None,
    measured_after: Annotated[
        DatetimeValue | None,
        Query(
            description=f"Only return runs measured after this time (exclusive). {TIMESTAMP_HINT}"
        ),
    ] = None,
    measured_before: Annotated[
        DatetimeValue | None,
        Query(
            description=f"Only return runs measured before this time (exclusive). {TIMESTAMP_HINT}"
        ),
    ] = None,
    has_profiles: Annotated[
        bool | None,
        Query(
            description=(
                "Only return runs that have (`true`) or don't have (`false`) profiles. Leave out "
                "to return both."
            )
        ),
    ] = None,
    sort: Annotated[
        RunSort | None,
        Query(
            description=(
                "Sort by submission time (`submitted_at`) or by measurement time (`measured_at`), "
                "oldest first, or newest first with a leading `-` (`-submitted_at`). Without it, "
                "the order is unspecified but stable, which is the fastest way to page through all "
                "runs."
            )
        ),
    ] = None,
    limit: Limit = DEFAULT_LIMIT,
) -> CursorPage[Run]:
    """The runs in the suite, one page at a time. To get a run's measurements, use
    `GET /api/suites/{testsuite}/runs/{uuid}/samples`."""
    with engine.connect() as connection, suite_scope(registry, connection, testsuite) as suite:
        runs = Runs(suite)
        conditions = [
            *exclusive_range(runs.table.c.submitted_at, submitted_after, submitted_before),
            *exclusive_range(runs.table.c.measured_at, measured_after, measured_before),
        ]
        if machine is not None:
            # By id rather than by the joined name, so the filter lands on the leading column of
            # D5's `(machine_id, measured_at)` index -- and so an unknown name is I3's 404.
            conditions.append(runs.table.c.machine_id == machine_id(connection, suite, machine))
        if commit is not None:
            conditions.append(runs.commit_is(commit))
        if has_profiles is not None:
            profiled = runs.has_profile()
            conditions.append(profiled if has_profiles else ~profiled)
        return cursor_page(
            connection,
            runs.select().where(*conditions),
            runs.keyset(sort),
            limit,
            cursor,
            runs.read,
            # An empty term matches every run (O4), so it filters nothing.
            resolved=runs.search(connection, search) if search else None,
        )


# Everything it writes is one transaction, because O8 makes a submission atomic from the caller's
# point of view: a machine created on the way to a contradicted ordinal must not survive the
# rejection. Reading the payload is deliberately not part of it; see below.
#
# The order is the one that does the least work before it can fail, and holds the least while doing
# it. `validate_submission` is pure and rejects a payload that cannot be stored before a single row
# is written; the machine and the commit come next, because the run row cannot be inserted without
# their ids; and the samples and profiles come last, because they cannot be inserted without the
# run's.
@router.post(
    "",
    status_code=201,
    dependencies=[require_scope(Scope.SUBMIT)],
    summary="Submit a run",
    responses=suite_responses(
        conflict=(
            "`duplicate`: a run with this UUID already exists. `conflict`: the submission "
            "contradicts what is stored for its machine or commit, or another commit already has "
            f"its ordinal. {SUITE_SCHEMA_CHANGED} The same `retry` is returned if the run's "
            "machine or commit was deleted while the run was being stored; sending it again "
            "creates them."
        )
    ),
)
def submit_run(
    testsuite: SuiteName,
    body: Annotated[RunSubmission, Body(openapi_examples=_SUBMIT_EXAMPLES)],
    engine: EngineDep,
    registry: RegistryDep,
    response: Response,
) -> RunDetail:
    """Submit the results of a run. The response's `Location` header points to the new run.

    The machine, the commit and the tests are created if they don't exist yet. Either the whole
    submission is saved or, if it is rejected, none of it is.
    """
    # Validation is pure, so it is deliberately outside the write transaction. For a submission
    # carrying tens of thousands of samples and tens of megabytes of base64 profile it is real
    # work, and doing it inside `engine.begin()` would hold one of the pool's connections and an
    # `idle in transaction` backend -- which pins the xmin horizon against VACUUM -- for all of it.
    with engine.connect() as connection, suite_scope(registry, connection, testsuite) as suite:
        validated_against = suite
    validated = validate_submission(validated_against.schema, body)
    # Pure too, and real work for a large submission, so likewise kept out of the transaction.
    run_summaries = summaries.summarize(validated_against.schema.metrics, validated.tests)

    # The suite is resolved a second time, and that is not a redundancy: D2 requires the freshness
    # check to be the first statement of the unit of work, and the write has to use the suite the
    # *write* transaction resolved. The payload was typed against the first resolution, though, so
    # a schema someone changed in between is answered with D2's retryable 409 rather than written:
    # a removed metric would otherwise be dropped silently, and a removed field would be a 500.
    with engine.begin() as connection, suite_scope(registry, connection, testsuite) as suite:
        if suite.schema_json != validated_against.schema_json:
            raise schema_changed(testsuite)
        runs = Runs(suite)

        # The machine before the commit, and that order is load-bearing rather than incidental.
        # Each of these can take a row lock -- on the row it inserts, and on an existing row whose
        # NULL metadata it fills in (see `entities.create_or_reconcile`) -- so two submissions
        # naming the same machine and the same commit would deadlock if they took the two in
        # opposite orders, and PostgreSQL would abort one of them on a request that did nothing
        # wrong. Order alone is not enough, though: the run insert below takes key-share locks on
        # both rows again through its foreign keys, which is why a fill must never lock a row
        # strongly enough to conflict with that (see `entities._locked_values`, and O8).
        machine_id = Machines(suite).get_or_create(connection, validated.machine)
        commit_id = Commits(suite).get_or_create(connection, validated.commit)
        run_id = runs.create(
            connection,
            validated.uuid,
            machine_id,
            commit_id,
            validated.run_parameters,
            measured_at=validated.measured_at,
        )

        # Every test name in one round trip rather than one each (O8), which is what keeps a
        # submission naming tens of thousands of tests affordable.
        names = [test.name for test in validated.tests]
        tests = resolve_names(connection, suite.tables.test, names)
        runs.add_samples(connection, run_id, validated.tests, tests)
        runs.add_profiles(connection, run_id, validated.tests, tests)
        summaries.add(connection, suite, run_id, run_summaries)
        # Last, so that the coverage rows this adds to -- which submissions for the same machine
        # contend on -- are locked for as short a time as the transaction allows.
        coverage.add(connection, suite, machine_id, validated.tests, tests)

        # Read back rather than assembled from the submission: `submitted_at` is the database's,
        # and this is the same reader the detail endpoint uses, so the two cannot disagree.
        created = runs.one(connection, validated.uuid)

    response.headers["Location"] = location_of(RUNS_PATH, testsuite, validated.uuid)
    return created


@router.get(
    "/{uuid}",
    dependencies=[require_scope(Scope.READ)],
    summary="Get a run",
    responses=suite_responses(not_found=NO_RUN),
)
def get_run(
    testsuite: SuiteName, uuid: RunKey, engine: EngineDep, registry: RegistryDep
) -> RunDetail:
    """Get a run."""
    with engine.connect() as connection, suite_scope(registry, connection, testsuite) as suite:
        return Runs(suite).one(connection, uuid)


@router.delete(
    "/{uuid}",
    status_code=204,
    dependencies=[require_scope(Scope.MANAGE)],
    summary="Delete a run",
    responses=suite_responses(not_found=NO_RUN),
)
def delete_run(
    testsuite: SuiteName, uuid: RunKey, engine: EngineDep, registry: RegistryDep
) -> None:
    """Delete a run, along with its samples and profiles."""
    # One statement: D5 gives `{suite}.sample.run_id` and `{suite}.profile.run_id` an
    # `ON DELETE CASCADE`. The tests the samples named are deliberately left behind -- nothing
    # deletes a test (D5).
    with engine.begin() as connection, suite_scope(registry, connection, testsuite) as suite:
        runs = Runs(suite)
        removed = connection.execute(delete(runs.table).where(runs.table.c.uuid == uuid))
        if removed.rowcount == 0:
            raise runs.missing(uuid)

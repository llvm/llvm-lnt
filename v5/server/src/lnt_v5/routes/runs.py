"""Runs: one measurement of one commit on one machine (E4).

Submission is the one write in the API that creates five kinds of row at once -- the machine, the
commit, the tests, the run and its samples and profiles -- and O8 makes all of it one transaction:
either 201 or nothing at all. So this module is mostly about order and about statement count. The
order is validate, then resolve the entities a run points at, then write the run and everything that
points at the run. The statement count is what keeps a submission carrying tens of thousands of
samples from costing tens of thousands of statements: the samples go in one executemany, the
profiles in another, and the test names through `concurrency.resolve_names`.

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

from fastapi import APIRouter, Query, Response
from pydantic import BaseModel, Field
from sqlalchemy import (
    ColumnElement,
    Connection,
    Row,
    Select,
    Table,
    delete,
    insert,
    select,
)

from lnt_v5.auth import require_scope
from lnt_v5.db import EngineDep, reporting_violation
from lnt_v5.errors import ApiError, ErrorCode
from lnt_v5.querying import (
    DEFAULT_LIMIT,
    Cursor,
    Keyset,
    Limit,
    SortKey,
    cursor_page,
    exclusive_range,
    sort_order,
)
from lnt_v5.responses import CursorPage
from lnt_v5.routes.commits import Commits
from lnt_v5.routes.machines import NO_MACHINE_FILTERED, Machines, machine_id, machine_search
from lnt_v5.routes.suites import SUITES_PATH
from lnt_v5.scopes import Scope
from lnt_v5.suites import coverage, summaries
from lnt_v5.suites.concurrency import resolve_names
from lnt_v5.suites.entities import DatetimeValue, UuidKey, identifier, location_of
from lnt_v5.suites.registry import RegistryDep, Suite
from lnt_v5.suites.scope import (
    SUITE_NOT_FOUND,
    SUITE_SCHEMA_CHANGED,
    schema_changed,
    suite_responses,
    suite_scope,
)
from lnt_v5.suites.submission import RunSubmission, SubmittedTest, validate_submission
from lnt_v5.suites.tables import RUN_UUID_CONSTRAINT

RUNS_PATH = f"{SUITES_PATH}/{{testsuite}}/runs"

router = APIRouter(prefix=RUNS_PATH, tags=["Runs"])

# endpoints.md names these two and no others. A literal rather than a free string, so I8's document
# enumerates them and an unknown one is a 400 before the endpoint runs.
RunSort = Literal["submitted_at", "-submitted_at"]

# What `after=` and `before=` both tell a client about the timestamp they take.
_TIMESTAMP = (
    "An ISO 8601 timestamp. One without an offset is read as UTC; a '+' in an offset must be "
    "sent as %2B, since a query string decodes a bare '+' to a space."
)

# Every operation here reaches the suite's own tables, so every one can answer both of the failures
# `suite_scope` produces; each widens the wording with the cases it adds of its own.
NO_RUN = f"{SUITE_NOT_FOUND} Or no run in it has that UUID."


class Run(BaseModel):
    """A run as a list endpoint returns it (I4).

    `machine` and `commit` are the referenced entity's identifier rather than a nested object, which
    is I4's rule for one entity referring to another: a page of runs is long, and a client that
    wants more than the identity resolves a page of commits in one call to `POST /commits/resolve`.
    """

    uuid: str = Field(
        description=(
            "Identifies the run: the UUID the submission supplied, normalized to lowercase, or one "
            "the server generated."
        )
    )
    machine: str = Field(description="The name of the machine this run was measured on.")
    commit: str = Field(description="The identity string of the commit this run belongs to.")
    submitted_at: datetime = Field(
        description=(
            "When this run was submitted: the time its submission supplied, or else the time the "
            "server accepted it (D5)."
        )
    )


class RunDetail(Run):
    """A run as the detail and create responses carry it: a list item, plus the blob.

    `run_parameters` is detail-only because it is unbounded and no list view renders it -- the same
    reason a regression's `notes` is, and the reason the list endpoint does not even select it.
    """

    run_parameters: dict[str, Any] = Field(
        description=(
            "The free-form blob the submission supplied, or an empty object if it supplied none. "
            "Written once at submission and never updated."
        )
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
        self._sample: Table = suite.tables.sample
        self._profile: Table = suite.tables.profile
        self._profile_function: Table = suite.tables.profile_function

    def select(self) -> Select[Any]:
        """The list query, deliberately without the unbounded `run_parameters`; `one` adds it."""
        return select(
            self.table.c.id,
            self.table.c.uuid,
            self._machine.c.name,
            self._commit.c.commit,
            self.table.c.submitted_at,
        ).select_from(
            self.table.join(self._machine, self._machine.c.id == self.table.c.machine_id).join(
                self._commit, self._commit.c.id == self.table.c.commit_id
            )
        )

    def keyset(self, sort: RunSort | None) -> Keyset:
        """O5's ordering for a run list: the caller's sort, then the internal tiebreaker.

        `submitted_at` is not unique -- nothing stops two runs being accepted in the same instant,
        and the list pages -- so it cannot be the whole order on its own. With no `sort` the
        tiebreaker is the whole order, which is the arbitrary but deterministic one O5 allows.
        """
        if sort is None:
            return Keyset(tiebreaker=self.table.c.id)
        _, descending = sort_order(sort)
        return Keyset(SortKey(self.table.c.submitted_at, descending), tiebreaker=self.table.c.id)

    def search(self, term: str) -> ColumnElement[bool]:
        """O4's `?search=` for a run list: the machine predicate, applied through the run's machine.

        Literally the same predicate as `GET /machines?search=`, which is what O4 asks for -- the
        join `select` already makes is what puts the machine's columns in scope for it.
        """
        return machine_search(self.suite, term)

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
        submitted_at: datetime | None,
    ) -> int:
        """Insert the run row, or answer I4's `duplicate` for a UUID already used (O1).

        `submitted_at` is written only when the submission supplied one. Otherwise D5's `now()`
        default fills it in, so the value comes from the database's clock rather than from this
        process, and concurrent workers agree on the ordering it defines. Either way it is read
        back through `select` afterwards.
        """
        values: dict[str, Any] = {
            "uuid": uuid,
            "machine_id": machine_id,
            "commit_id": commit_id,
            "run_parameters": parameters,
        }
        if submitted_at is not None:
            values["submitted_at"] = submitted_at
        taken = f"A run '{uuid}' already exists in test suite '{self.schema.name}'"
        with reporting_violation(RUN_UUID_CONSTRAINT, ErrorCode.DUPLICATE, taken):
            return int(
                connection.execute(
                    insert(self.table).values(values).returning(self.table.c.id)
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
        thousands of samples. That is only safe because every mapping in `test.samples` already
        carries the identical key set -- see `suites/submission.py`, which establishes it -- since
        SQLAlchemy Core compiles an executemany from the first mapping and binds the rest to those
        same columns. Nothing is added here beyond the two ids that are not the payload's to know.
        """
        rows = [
            {"run_id": run_id, "test_id": ids[test.name], **sample}
            for test in tests
            for sample in test.samples
        ]
        if rows:
            connection.execute(insert(self._sample), rows)

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
            insert(self._profile).returning(self._profile.c.test_id, self._profile.c.id),
            [
                {
                    "uuid": str(uuid4()),
                    "run_id": run_id,
                    "test_id": test_id,
                    "disassembly_format": profile.disassembly_format,
                    "counters": profile.counters,
                }
                for test_id, profile in profiles.items()
            ],
        )
        profile_ids = dict(inserted.tuples().all())
        functions = [
            {
                "profile_id": profile_ids[test_id],
                "name": function.name,
                "counters": function.counters,
                "length": function.length,
                "instructions": function.instructions,
            }
            for test_id, profile in profiles.items()
            for function in profile.functions
        ]
        if functions:
            connection.execute(insert(self._profile_function), functions)


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


@router.get(
    "",
    dependencies=[require_scope(Scope.READ)],
    summary="List runs",
    responses=suite_responses(not_found=NO_MACHINE_FILTERED),
)
def list_runs(
    testsuite: str,
    engine: EngineDep,
    registry: RegistryDep,
    cursor: Cursor = None,
    search: Annotated[
        str | None,
        Query(
            description=(
                "Case-insensitive substring match against the run's machine: its name or any "
                "searchable machine field. The same match `GET /machines?search=` performs."
            )
        ),
    ] = None,
    machine: Annotated[
        str | None,
        Query(description="Keep only runs measured on this machine. 404 if there is no such one."),
    ] = None,
    commit: Annotated[
        str | None,
        Query(
            description=(
                "Keep only runs belonging to this commit. A value no commit has matches nothing, "
                "rather than being an error."
            )
        ),
    ] = None,
    after: Annotated[
        DatetimeValue | None,
        Query(description=f"Keep only runs submitted strictly after this instant. {_TIMESTAMP}"),
    ] = None,
    before: Annotated[
        DatetimeValue | None,
        Query(description=f"Keep only runs submitted strictly before this instant. {_TIMESTAMP}"),
    ] = None,
    has_profiles: Annotated[
        bool | None,
        Query(
            description=(
                "Keep only runs that carry profile data, or only those that carry none. Omit for "
                "both."
            )
        ),
    ] = None,
    sort: Annotated[
        RunSort | None,
        Query(
            description=(
                "Order by submission time, ascending (oldest first) or descending. Omit for an "
                "arbitrary but stable order, which is the cheapest way to page through every run."
            )
        ),
    ] = None,
    limit: Limit = DEFAULT_LIMIT,
) -> CursorPage[Run]:
    """Every run in the suite, filtered, ordered and cursor-paginated (I2, I3, O4, O5).

    I3's asymmetry between the two entity filters is deliberate and is visible here: an unknown
    `machine=` is a 404, because a caller that misspells a machine name wants to hear about it,
    whereas an unknown `commit=` is an empty page, because a commit the suite has never seen is an
    ordinary answer to "what ran at this revision".
    """
    with engine.connect() as connection, suite_scope(registry, connection, testsuite) as suite:
        runs = Runs(suite)
        conditions = exclusive_range(runs.table.c.submitted_at, after, before)
        if search is not None:
            conditions.append(runs.search(search))
        if machine is not None:
            # By id rather than by the joined name, so the filter lands on the leading column of
            # D5's `(machine_id, submitted_at)` index -- and so an unknown name is I3's 404.
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
        )


@router.post(
    "",
    status_code=201,
    dependencies=[require_scope(Scope.SUBMIT)],
    summary="Submit a run",
    responses=suite_responses(
        conflict=(
            "`duplicate`: a run with that UUID already exists. `conflict`: the submission "
            "contradicts stored machine or commit metadata, or the ordinal it supplies is held by "
            f"another commit. {SUITE_SCHEMA_CHANGED}"
        )
    ),
)
def submit_run(
    testsuite: str,
    body: RunSubmission,
    engine: EngineDep,
    registry: RegistryDep,
    response: Response,
) -> RunDetail:
    """Store a run, its samples, profiles and summaries, creating what it names (O1, O2, O7-O9).

    Everything it writes is one transaction, because O8 makes a submission atomic from the
    caller's point of view: a machine created on the way to a contradicted ordinal must not survive
    the rejection. Reading the payload is deliberately not part of it; see below.

    The order is the one that does the least work before it can fail, and holds the least while
    doing it. `validate_submission` is pure and rejects a payload that cannot be stored before a
    single row is written; the machine and the commit come next, because the run row cannot be
    inserted without their ids; and the samples and profiles come last, because they cannot be
    inserted without the run's.
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
        # opposite orders, and PostgreSQL would kill one of them with a 500 on a request that did
        # nothing wrong. Order alone is not enough, though: the run insert below takes key-share
        # locks on both rows again through its foreign keys, which is why a fill must never lock
        # a row strongly enough to conflict with that (see `entities._locked_values`, and O8).
        machine_id = Machines(suite).get_or_create(connection, validated.machine)
        commit_id = Commits(suite).get_or_create(connection, validated.commit)
        run_id = runs.create(
            connection,
            validated.uuid,
            machine_id,
            commit_id,
            validated.run_parameters,
            submitted_at=validated.submitted_at,
        )

        # Every test name in one round trip rather than one each (O8), which is what keeps a
        # submission naming tens of thousands of tests affordable.
        names = [test.name for test in validated.tests]
        tests = resolve_names(connection, suite.tables.test, names)
        runs.add_samples(connection, run_id, validated.tests, tests)
        runs.add_profiles(connection, run_id, validated.tests, tests)
        summaries.add(connection, suite, run_id, run_summaries)
        # Last, so the coverage rows -- which submissions for the same machine contend on -- are
        # held for as short a time as the transaction allows.
        coverage.add(connection, suite, machine_id, validated.tests, tests)

        # Read back rather than assembled from the submission: `submitted_at` may be the
        # database's, and this is the same reader the detail endpoint uses, so the two cannot
        # disagree.
        created = runs.one(connection, validated.uuid)

    response.headers["Location"] = location_of(RUNS_PATH, testsuite, validated.uuid)
    return created


@router.get(
    "/{uuid}",
    dependencies=[require_scope(Scope.READ)],
    summary="Get a run",
    responses=suite_responses(not_found=NO_RUN),
)
def get_run(testsuite: str, uuid: UuidKey, engine: EngineDep, registry: RegistryDep) -> RunDetail:
    """One run, in the same shape submission returns -- a list item plus `run_parameters`."""
    with engine.connect() as connection, suite_scope(registry, connection, testsuite) as suite:
        return Runs(suite).one(connection, uuid)


@router.delete(
    "/{uuid}",
    status_code=204,
    dependencies=[require_scope(Scope.MANAGE)],
    summary="Delete a run",
    responses=suite_responses(not_found=NO_RUN),
)
def delete_run(testsuite: str, uuid: UuidKey, engine: EngineDep, registry: RegistryDep) -> None:
    """Delete a run, its samples and its profiles (D5).

    One statement: D5 gives `{suite}.sample.run_id` and `{suite}.profile.run_id` an
    `ON DELETE CASCADE`. The tests the samples named are deliberately left behind -- nothing deletes
    a test (D5).
    """
    with engine.begin() as connection, suite_scope(registry, connection, testsuite) as suite:
        runs = Runs(suite)
        removed = connection.execute(delete(runs.table).where(runs.table.c.uuid == uuid))
        if removed.rowcount == 0:
            raise runs.missing(uuid)

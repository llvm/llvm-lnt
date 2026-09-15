"""Runs: one measurement of one commit on one machine (endpoints.md, Runs).

Submission is the one write in the API that creates five kinds of row at once -- the machine, the
commit, the tests, the run and its samples and profiles -- and D13 makes all of it one transaction:
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
from typing import Any
from uuid import uuid4

from fastapi import APIRouter, Response
from pydantic import BaseModel, Field
from sqlalchemy import Connection, Row, Select, Table, delete, insert, select

from lnt_v5.auth import require_scope
from lnt_v5.db import EngineDep, reporting_violation
from lnt_v5.errors import ApiError, ErrorCode
from lnt_v5.routes.commits import Commits
from lnt_v5.routes.machines import Machines
from lnt_v5.routes.suites import SUITES_PATH
from lnt_v5.scopes import Scope
from lnt_v5.suites.concurrency import resolve_names
from lnt_v5.suites.entities import location_of
from lnt_v5.suites.registry import RegistryDep, Suite
from lnt_v5.suites.scope import SUITE_NOT_FOUND, SUITE_SCHEMA_CHANGED, suite_responses, suite_scope
from lnt_v5.suites.submission import (
    RunSubmission,
    RunUuidPath,
    SubmittedTest,
    validate_submission,
)
from lnt_v5.suites.tables import RUN_UUID_CONSTRAINT

RUNS_PATH = f"{SUITES_PATH}/{{testsuite}}/runs"

router = APIRouter(prefix=RUNS_PATH, tags=["Runs"])

# Every operation here reaches the suite's own tables, so every one can answer both of the failures
# `suite_scope` produces; each widens the wording with the cases it adds of its own.
_NO_RUN = f"{SUITE_NOT_FOUND} Or no run in it has that UUID."


class Run(BaseModel):
    """A run as the detail and create responses carry it (R4).

    `machine` and `commit` are the referenced entity's identifier rather than a nested object, which
    is R4's rule for one entity referring to another: a run list is long, and a client that wants
    more than the identity resolves a page of commits in one call to `POST /commits/resolve`.
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
            "When the server accepted this run. Recorded by the server from the database's clock; "
            "a submission cannot supply it (D6)."
        )
    )
    run_parameters: dict[str, Any] = Field(
        description=(
            "The free-form blob the submission supplied, or an empty object if it supplied none. "
            "Written once at submission and never updated."
        )
    )


class Runs:
    """The query every run response is built from, and how to read one of its rows back.

    The join is what makes a run renderable on its own: D5 stores a machine and a commit id, and R4
    wants the machine's name and the commit's value, so every read of a run pays for both. Held here
    rather than written per endpoint so that the detail and the lists built on it cannot drift apart
    on the columns they name -- the same arrangement as `Machines` and `Commits`.
    """

    def __init__(self, suite: Suite) -> None:
        self.schema = suite.schema
        self.table: Table = suite.tables.run
        self._machine: Table = suite.tables.machine
        self._commit: Table = suite.tables.commit
        self._sample: Table = suite.tables.sample
        self._profile: Table = suite.tables.profile

    def select(self) -> Select[Any]:
        return select(
            self.table.c.uuid,
            self._machine.c.name,
            self._commit.c.commit,
            self.table.c.submitted_at,
            self.table.c.run_parameters,
        ).select_from(
            self.table.join(self._machine, self._machine.c.id == self.table.c.machine_id).join(
                self._commit, self._commit.c.id == self.table.c.commit_id
            )
        )

    def read(self, row: Row[Any]) -> Run:
        return Run(
            uuid=row._mapping[self.table.c.uuid],
            machine=row._mapping[self._machine.c.name],
            commit=row._mapping[self._commit.c.commit],
            submitted_at=row._mapping[self.table.c.submitted_at],
            run_parameters=row._mapping[self.table.c.run_parameters],
        )

    def one(self, connection: Connection, uuid: str) -> Run:
        row = connection.execute(self.select().where(self.table.c.uuid == uuid)).one_or_none()
        if row is None:
            raise self.missing(uuid)
        return self.read(row)

    def missing(self, uuid: str) -> ApiError:
        """The 404 for a run that is not there, worded in one place for both its callers."""
        return ApiError(ErrorCode.NOT_FOUND, f"No run '{uuid}' in test suite '{self.schema.name}'")

    def create(
        self,
        connection: Connection,
        uuid: str,
        machine_id: int,
        commit_id: int,
        parameters: dict[str, Any],
    ) -> int:
        """Insert the run row, or answer R4's `duplicate` for a UUID already used (D6).

        `submitted_at` is deliberately not written: D5 gives the column a `now()` default, so the
        value comes from the database's clock rather than from this process, and concurrent workers
        agree on the ordering it defines. It is read back through `select` afterwards.
        """
        taken = f"A run '{uuid}' already exists in test suite '{self.schema.name}'"
        with reporting_violation(RUN_UUID_CONSTRAINT, ErrorCode.DUPLICATE, taken):
            return int(
                connection.execute(
                    insert(self.table)
                    .values(
                        uuid=uuid,
                        machine_id=machine_id,
                        commit_id=commit_id,
                        run_parameters=parameters,
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
        """Every sample row the submission stands for, in one statement (D6).

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
        """One profile row per run+test the submission carried one for, in one statement (D12).

        The UUID is minted here and never taken from the submission: R1 makes a run's UUID the one
        a client may choose, and every other UUID in the API server-generated. `created_at` is left
        to D5's column default, for the same reason `submitted_at` is.
        """
        rows = [
            {
                "uuid": str(uuid4()),
                "run_id": run_id,
                "test_id": ids[test.name],
                "data": test.profile,
            }
            for test in tests
            if test.profile is not None
        ]
        if rows:
            connection.execute(insert(self._profile), rows)


@router.post(
    "",
    status_code=201,
    dependencies=[require_scope(Scope.SUBMIT)],
    summary="Submit a run",
    responses=suite_responses(
        conflict=(
            "A run with that UUID already exists, the submission contradicts stored machine or "
            f"commit metadata, or the ordinal it supplies is taken. {SUITE_SCHEMA_CHANGED}"
        )
    ),
)
def submit_run(
    testsuite: str,
    body: RunSubmission,
    engine: EngineDep,
    registry: RegistryDep,
    response: Response,
) -> Run:
    """Store a run, its samples and its profiles, creating what it names (D6, D7, D12, D13).

    Everything it writes is one transaction, because D13 makes a submission atomic from the
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
        schema = suite.schema
    validated = validate_submission(schema, body)

    # The suite is resolved a second time, and that is not a redundancy: D2 requires the freshness
    # check to be the first statement of the unit of work, and the write has to use the suite the
    # *write* transaction resolved. A schema someone changed in between is answered by `suite_scope`
    # as a retryable 409, which is exactly D2's "a stale reader is answered rather than silently
    # wrong".
    with engine.begin() as connection, suite_scope(registry, connection, testsuite) as suite:
        runs = Runs(suite)

        # The machine before the commit, and that order is load-bearing rather than incidental.
        # Each of these can take a row lock -- on the row it inserts, and on an existing row whose
        # NULL metadata it fills in (see `entities.create_or_reconcile`) -- so two submissions
        # naming the same machine and the same commit would deadlock if they took the two in
        # opposite orders, and PostgreSQL would kill one of them with a 500 on a request that did
        # nothing wrong. Every submission goes through here, so every submission takes them in this
        # order; D13 requires exactly that, of these rows as of the test names below.
        machine_id = Machines(suite).get_or_create(connection, validated.machine)
        commit_id = Commits(suite).get_or_create(connection, validated.commit)
        run_id = runs.create(
            connection, validated.uuid, machine_id, commit_id, validated.run_parameters
        )

        # Every test name in one round trip rather than one each (D13), which is what keeps a
        # submission naming tens of thousands of tests affordable.
        names = [test.name for test in validated.tests]
        tests = resolve_names(connection, suite.tables.test, names)
        runs.add_samples(connection, run_id, validated.tests, tests)
        runs.add_profiles(connection, run_id, validated.tests, tests)

        # Read back rather than assembled from the submission: `submitted_at` is the database's,
        # and this is the same reader the detail endpoint uses, so the two cannot disagree.
        created = runs.one(connection, validated.uuid)

    response.headers["Location"] = location_of(RUNS_PATH, testsuite, validated.uuid)
    return created


@router.get(
    "/{uuid}",
    dependencies=[require_scope(Scope.READ)],
    summary="Get a run",
    responses=suite_responses(not_found=_NO_RUN),
)
def get_run(testsuite: str, uuid: RunUuidPath, engine: EngineDep, registry: RegistryDep) -> Run:
    """One run, in the same shape submission returns."""
    with engine.connect() as connection, suite_scope(registry, connection, testsuite) as suite:
        return Runs(suite).one(connection, uuid)


@router.delete(
    "/{uuid}",
    status_code=204,
    dependencies=[require_scope(Scope.MANAGE)],
    summary="Delete a run",
    responses=suite_responses(not_found=_NO_RUN),
)
def delete_run(testsuite: str, uuid: RunUuidPath, engine: EngineDep, registry: RegistryDep) -> None:
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

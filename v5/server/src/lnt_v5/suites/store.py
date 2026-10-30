"""Writing a suite or a project: the locks changes serialize on, and the counter that announces
them (D2).

Separate from `registry.py`, which is strictly a read-path cache. A write must not derive what it is
changing from that cache -- the cache is allowed to lag a commit, so two concurrent changes taken
from it would each discard the other's while still applying their own column changes. `locked_suite`
is what a write reads instead.
"""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass

from sqlalchemy import Connection, Engine, insert, select, text, update
from sqlalchemy.exc import DBAPIError

from lnt_v5.db import is_lock_unavailable
from lnt_v5.errors import ApiError, ErrorCode
from lnt_v5.suites import migrations
from lnt_v5.suites import tables as suite_tables
from lnt_v5.suites.schema import SuiteSchema
from lnt_v5.tables import SCHEMA_VERSION_ID, project, schema, schema_version

# What tables.py's NAMING_CONVENTION names the unique constraint on `schema(project_id, name)`, and
# so the constraint a suite name repeated within a project trips; the one on `project.name`, which a
# repeated project name trips; and the foreign key from `schema` to `project`, which deleting a
# project that still has suites trips. Written out because they are fixed, and checked against what
# PostgreSQL reports by `test_registry.py` -- the same arrangement as `keys.PREFIX_CONSTRAINT`, and
# for the same reason: a convention change must fail a test rather than silently turn a 409 into a
# 500.
SCHEMA_NAME_CONSTRAINT = "uq_schema_project_id_name"
PROJECT_NAME_CONSTRAINT = "uq_project_name"
SCHEMA_PROJECT_CONSTRAINT = "fk_schema_project_id_project"

# How long a schema change waits for the locks it needs before giving up. Long enough to outlast an
# ordinary query holding the table, and deliberately well under `db.POOL_SIZE`'s companion
# `pool_timeout` (10s): a wait longer than that would start failing unrelated requests waiting for a
# connection rather than failing this one. Changing either without the other reintroduces the pool
# exhaustion this exists to prevent.
LOCK_TIMEOUT = "3s"


def normalized_json(suite: SuiteSchema) -> str:
    """The text D5 stores: the normalized schema, not the request body as submitted.

    One function, so that what is written, what is compared against it, and what the registry reads
    back can never be three spellings of the same idea.
    """
    return suite.model_dump_json()


def full_name(project: str, suite: str) -> str:
    """How people and logs name a suite outside its project's context (D7): `project/suite`."""
    return f"{project}/{suite}"


@dataclass(frozen=True)
class StoredSuite:
    """A suite as its `schema` row records it (D5): its identity, its project's name and its own,
    its schema, and the namespace of its tables.

    What a write reads under the suite's lock (see `locked_suite`), and what a per-suite migration
    step is told about the suite it migrates (see `migrations.py`). The name is the row's, rather
    than the copy in the schema, since the row is what a write addresses.
    """

    id: int
    project: str
    name: str
    schema: SuiteSchema
    namespace: str

    @property
    def full_name(self) -> str:
        return full_name(self.project, self.name)


def bump(connection: Connection) -> None:
    """Tell every other worker that the suites have changed (D2).

    Must run in the same transaction as the change itself, so that a rolled-back write leaves the
    counter untouched and nobody reloads for nothing.
    """
    connection.execute(
        update(schema_version)
        .where(schema_version.c.id == SCHEMA_VERSION_ID)
        .values(version=schema_version.c.version + 1)
    )


def add_suite(connection: Connection, project_name: str, suite: SuiteSchema) -> None:
    """Store a new suite in the project `project_name` and create its tables, announcing it to every
    worker (D2, D5).

    The project's row is locked first, against its deletion, until the caller's transaction ends:
    either the project is gone already, and this is a 404, or its deletion waits and then finds the
    suite, and is refused (D2). The suite's row next: it is the lock every writer of this suite
    contends on, so two callers racing to create one name serialize here and the loser fails on its
    unique name rather than leaving a half-built namespace. It is also the order the other writes
    take their locks in. Choosing the namespace takes no lock, and gives each caller a namespace of
    its own.

    The tables are created with this build's latest structure, so the suite is recorded at the
    latest migration version (D6).
    """
    project_id = connection.execute(
        select(project.c.id)
        .where(project.c.name == project_name)
        .with_for_update(read=True, key_share=True)
    ).scalar_one_or_none()
    if project_id is None:
        raise project_not_found(project_name)
    namespace = suite_tables.new_namespace(connection)
    connection.execute(
        insert(schema).values(
            project_id=project_id,
            name=suite.name,
            namespace=namespace,
            schema_json=normalized_json(suite),
            migration_version=migrations.head(),
        )
    )
    suite_tables.create(connection, suite, namespace, full_name(project_name, suite.name))
    bump(connection)


def project_not_found(name: str) -> ApiError:
    return ApiError(ErrorCode.NOT_FOUND, f"Project '{name}' not found")


def suite_not_found(project_name: str, name: str) -> ApiError:
    return ApiError(ErrorCode.NOT_FOUND, f"Test suite '{full_name(project_name, name)}' not found")


def locked_suite(connection: Connection, project_name: str, name: str) -> StoredSuite:
    """The stored schema of a suite the caller is about to change, with its row locked.

    Two things at once, and both matter. The row lock serializes every change to this suite, so a
    second one waits here rather than deriving its own change from a schema the first has already
    superseded. And the schema comes from *this* read rather than from the registry, because the
    registry may be a commit behind -- a change computed against a stale base would drop whatever
    the previous change added while still applying its own DDL, leaving the tables and the stored
    schema permanently disagreeing.

    Only the suite's row is locked, not its project's, which a change to the project's display name
    can then go on changing meanwhile.

    Raises 404 if there is no such suite, which is also what makes a change racing a delete answer
    404 rather than succeeding against a row that is no longer there.
    """
    row = connection.execute(
        select(schema.c.id, schema.c.schema_json, schema.c.namespace)
        .select_from(schema.join(project))
        .where(project.c.name == project_name, schema.c.name == name)
        .with_for_update(of=schema)
    ).one_or_none()
    if row is None:
        raise suite_not_found(project_name, name)
    return StoredSuite(
        row.id, project_name, name, SuiteSchema.model_validate_json(row.schema_json), row.namespace
    )


@contextmanager
def suite_write(engine: Engine, project_name: str, name: str) -> Iterator[Connection]:
    """One transaction that changes, creates or deletes the suite `name` of project `project_name`.

    Every write path goes through here, so the three obligations that come with changing a suite are
    the helper's rather than each endpoint's:

    - One transaction, so the column changes, the stored schema and the counter bump commit together
      or not at all (D2: "a schema change is atomic").
    - A bounded wait. Every schema change needs `ACCESS EXCLUSIVE` on the suite's tables, which
      conflicts with any reader -- and a *waiting* request for it queues ahead of new readers, so an
      unbounded wait behind one long query stalls every later request for that suite across every
      worker, each holding a pooled connection. That exhausts the pool and takes `/healthz` down
      with it, since it shares the engine. `SET LOCAL`, so the setting cannot leak onto a pooled
      connection.
    - A lock it could not take reported as a retryable 409 rather than a 500. Nothing is wrong with
      the request; it arrived while the suite was busy.

    A caller that has its own errors to translate wraps this, rather than repeating any of the
    above: an `IntegrityError` is a `DBAPIError` too, so it passes through here untouched.
    """
    with _bounded_write(engine, f"Test suite '{full_name(project_name, name)}'") as connection:
        yield connection


@contextmanager
def project_write(engine: Engine, name: str) -> Iterator[Connection]:
    """One transaction that changes or deletes the project `name`, with the same bounded wait for
    its locks as `suite_write`, which D2 asks of a project's display-name change and deletion."""
    with _bounded_write(engine, f"Project '{name}'") as connection:
        yield connection


@contextmanager
def _bounded_write(engine: Engine, subject: str) -> Iterator[Connection]:
    """A transaction whose locks are waited for only `LOCK_TIMEOUT`, a lock it could not take
    reported as a retryable 409 naming `subject` (see `suite_write`)."""
    try:
        with engine.begin() as connection:
            connection.execute(text(f"SET LOCAL lock_timeout = '{LOCK_TIMEOUT}'"))
            yield connection
    except DBAPIError as error:
        if not is_lock_unavailable(error):
            raise
        raise ApiError(
            ErrorCode.RETRY,
            f"{subject} is busy: the change could not take the locks it needs. Retry.",
        ) from error

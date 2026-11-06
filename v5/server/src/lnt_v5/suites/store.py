"""Writing a suite or a project: the locks changes serialize on, and the counter that announces
them (D2).

Separate from `registry.py`, which is strictly a read-path cache. A write must not derive what it is
changing from that cache -- the cache is allowed to lag a commit, so two concurrent changes taken
from it would each discard the other's while still applying their own column changes. `locked_suite`
is what a write reads instead.
"""

from __future__ import annotations

from collections.abc import Iterator, Sequence
from contextlib import contextmanager
from dataclasses import dataclass
from typing import NamedTuple

from sqlalchemy import Connection, Engine, Table, bindparam, case, insert, select, text, update
from sqlalchemy.exc import DBAPIError

from lnt_v5.db import is_lock_unavailable
from lnt_v5.errors import ApiError, ErrorCode
from lnt_v5.ordering import check_order
from lnt_v5.suites import migrations
from lnt_v5.suites import tables as suite_tables
from lnt_v5.suites.schema import SuiteSchema
from lnt_v5.tables import (
    SCHEMA_VERSION_ID,
    project,
    schema,
    schema_position_sequence,
    schema_version,
)

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
    suite, and is refused (E13). The suite's row next: it is the lock every writer of this suite
    contends on, so two callers racing to create one name serialize here and the loser fails on its
    unique name rather than leaving a half-built namespace. It is also the order the other writes
    take their locks in. Choosing the namespace takes no lock, and gives each caller a namespace of
    its own.

    The tables are created with this build's latest structure, so the suite is recorded at the
    latest migration version (D6). Its position is the column's default, which puts it last in its
    project (D7).
    """
    project_id = locked_projects(connection, {project_name}).get(project_name)
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
    suite_tables.create(connection, suite, namespace)
    bump(connection)


def locked_projects(connection: Connection, names: set[str]) -> dict[str, int]:
    """The ids of the projects named `names` that exist, by name, each locked against being renamed
    or deleted until the caller's transaction ends.

    Projects are locked before suites, by every writer that locks both (see `locked_suite`). A
    move locks the suite's project and its destination together this way before it locks the
    suite, which keeps the destination from being deleted meanwhile, as `add_suite` keeps the
    project it creates a suite in. FOR KEY SHARE, which a change to a project's display name does
    not wait for.
    """
    rows = connection.execute(
        select(project.c.name, project.c.id)
        .where(project.c.name.in_(names))
        .with_for_update(read=True, key_share=True)
    )
    return {row.name: row.id for row in rows}


def move_suite(
    connection: Connection, stored: StoredSuite, project_id: int, name: str
) -> SuiteSchema:
    """Rename the suite `stored` to `name`, in the project whose id is `project_id`, which may be
    another project than its own, and return its schema under its new name (D7).

    Only names change, and a suite moved to another project goes last there: the suite keeps its
    namespace and its tables. `stored` must come from `locked_suite`, once `locked_projects` has
    locked both projects.
    """
    renamed = stored.schema.model_copy(update={"name": name})
    moved = schema.c.project_id != project_id
    connection.execute(
        update(schema)
        .where(schema.c.id == stored.id)
        .values(
            project_id=project_id,
            name=name,
            schema_json=normalized_json(renamed),
            position=case((moved, schema_position_sequence.next_value()), else_=schema.c.position),
        )
    )
    bump(connection)
    return renamed


class Member(NamedTuple):
    """A project, or a suite of a project, as a reorder reads it: its row, name and position."""

    id: int
    name: str
    position: int


def locked_projects_in_order(connection: Connection) -> list[Member]:
    """Every project, locked against being renamed, deleted, changed or reordered until the
    caller's transaction ends, to reorder them (E13).

    FOR NO KEY UPDATE, which writing to a suite and creating a key do not wait for, since they take
    their projects FOR KEY SHARE (see `locked_projects`), in the order of the ids, which two
    reorders therefore lock the rows in alike. Nothing keeps a project from being created meanwhile,
    which then stays after the projects this reads (see `tables.py`).

    The members and their positions come from this one locking statement. A second read would take
    a snapshot of its own, find a project created since, and refuse an order without it. A project
    renamed or deleted while this waited for its row comes back renamed or not at all, so an order
    naming it as it was is refused.
    """
    rows = connection.execute(
        select(project.c.id, project.c.name, project.c.position)
        .order_by(project.c.id)
        .with_for_update(key_share=True)
    )
    return [Member(*row) for row in rows]


def locked_suites_in_order(connection: Connection, project_name: str) -> list[Member]:
    """Every suite of the project `project_name`, to reorder them (E10), with the project locked
    against any change to its suites until the caller's transaction ends.

    The project's row FOR UPDATE: every write to a suite, its creation and a move into or out of
    the project included, takes it FOR KEY SHARE first (see `locked_projects`), so none can change
    what this reads before the reorder commits. Raises 404 if there is no such project.
    """
    project_id = connection.execute(
        select(project.c.id).where(project.c.name == project_name).with_for_update()
    ).scalar_one_or_none()
    if project_id is None:
        raise project_not_found(project_name)
    # From the table rather than the registry: a suite whose stored schema the registry cannot
    # parse is left out of the listing, but is still one of the project's suites, which the order
    # must name. The 400 refusing an order without it names it.
    rows = connection.execute(
        select(schema.c.id, schema.c.name, schema.c.position).where(
            schema.c.project_id == project_id
        )
    )
    return [Member(*row) for row in rows]


def reorder(
    connection: Connection, table: Table, members: Sequence[Member], order: list[str], what: str
) -> None:
    """Put `members`, rows of `table`, in the order of their names in `order`, and announce it to
    every worker (D2, D7). `what` names them in the error refusing an order that does not name each
    of them exactly once (I3).

    The members' own positions are handed out again, in the new order (see `tables.py`). An order
    that is the current one changes nothing.
    """
    current = sorted(members, key=lambda member: (member.position, member.id))
    names = [member.name for member in current]
    check_order(names, order, f"The order must name each of {what} exactly once")
    if names == order:
        return
    ids = {member.name: member.id for member in members}
    connection.execute(
        update(table)
        .where(table.c.id == bindparam("member_id"))
        .values(position=bindparam("new_position")),
        [
            {"member_id": ids[name], "new_position": member.position}
            for name, member in zip(order, current, strict=True)
        ],
    )
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

    The project's row is locked first, FOR KEY SHARE, the order every writer that locks both takes
    them in (see `locked_projects`). That keeps the suite from being changed through a project name
    that a concurrent rename of the project has just retired: once the rename commits, the name
    finds nothing. A change to the project's display name does not wait for it.

    Raises 404 if there is no such suite, which is also what makes a change racing a delete or a
    rename answer 404 rather than succeeding against a row that is no longer there.
    """
    project_id = locked_projects(connection, {project_name}).get(project_name)
    if project_id is None:
        raise suite_not_found(project_name, name)
    row = connection.execute(
        select(schema.c.id, schema.c.schema_json, schema.c.namespace)
        .where(schema.c.project_id == project_id, schema.c.name == name)
        .with_for_update()
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
    """One transaction that changes or deletes the project `name`, or reorders its suites, with the
    same bounded wait for its locks as `suite_write` (D2)."""
    with _bounded_write(engine, f"Project '{name}'") as connection:
        yield connection


@contextmanager
def projects_write(engine: Engine) -> Iterator[Connection]:
    """One transaction that reorders the projects, with the same bounded wait for its locks as
    `suite_write` (D2)."""
    with _bounded_write(engine, "The order of the projects") as connection:
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

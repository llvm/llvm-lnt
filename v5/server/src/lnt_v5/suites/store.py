"""Writing a suite: the lock every change serializes on, and the counter that announces it (D2).

Separate from `registry.py`, which is strictly a read-path cache. A write must not derive what it is
changing from that cache -- the cache is allowed to lag a commit, so two concurrent changes taken
from it would each discard the other's while still applying their own column changes. `locked_suite`
is what a write reads instead.
"""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager

from sqlalchemy import Connection, Engine, select, text, update
from sqlalchemy.exc import DBAPIError

from lnt_v5.db import is_lock_unavailable
from lnt_v5.errors import ApiError, ErrorCode
from lnt_v5.suites.schema import SuiteSchema
from lnt_v5.tables import SCHEMA_VERSION_ID, schema, schema_version

# What tables.py's NAMING_CONVENTION names `schema`'s primary key, and so the constraint a repeated
# suite name trips. Written out because it is fixed, and checked against what PostgreSQL reports by
# `test_registry.py` -- the same arrangement as `keys.PREFIX_CONSTRAINT`, and for the same reason: a
# convention change must fail a test rather than silently turn a 409 into a 500.
SCHEMA_NAME_CONSTRAINT = "pk_schema"

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


def locked_suite(connection: Connection, name: str) -> SuiteSchema:
    """The stored schema of a suite the caller is about to change, with its row locked.

    Two things at once, and both matter. The row lock serializes every change to this suite, so a
    second one waits here rather than deriving its own change from a schema the first has already
    superseded. And the schema comes from *this* read rather than from the registry, because the
    registry may be a commit behind -- a change computed against a stale base would drop whatever
    the previous change added while still applying its own DDL, leaving the tables and the stored
    schema permanently disagreeing.

    Raises 404 if there is no such suite, which is also what makes a change racing a delete answer
    404 rather than succeeding against a row that is no longer there.
    """
    row = connection.execute(
        select(schema.c.schema_json).where(schema.c.name == name).with_for_update()
    ).one_or_none()
    if row is None:
        raise ApiError(ErrorCode.NOT_FOUND, f"Test suite '{name}' not found")
    return SuiteSchema.model_validate_json(row.schema_json)


@contextmanager
def suite_write(engine: Engine, name: str) -> Iterator[Connection]:
    """One transaction that changes one suite.

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
    try:
        with engine.begin() as connection:
            connection.execute(text(f"SET LOCAL lock_timeout = '{LOCK_TIMEOUT}'"))
            yield connection
    except DBAPIError as error:
        if not is_lock_unavailable(error):
            raise
        raise ApiError(
            ErrorCode.CONFLICT,
            f"Test suite '{name}' is busy: the change could not take the locks it needs. Retry.",
        ) from error

"""Database access: the engine, how an endpoint reaches it, and reading Postgres' errors.

The engine is built by an explicit factory call rather than at import, so that importing the
application does not require a reachable database (or even a populated environment), and so that
each worker builds its own. uvicorn spawns its workers rather than forking, so each one imports
this module fresh and no connection is ever inherited across a process boundary.
"""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from typing import Annotated, Any

from fastapi import Depends, Request
from psycopg.errors import (
    DeadlockDetected,
    DuplicateSchema,
    LockNotAvailable,
    UndefinedColumn,
    UndefinedTable,
    UniqueViolation,
)
from sqlalchemy import Engine, create_engine
from sqlalchemy.exc import DBAPIError, IntegrityError

from .config import Settings
from .errors import ApiError, ErrorCode

# Per-worker pool bounds. The live connection count is
# `WEB_CONCURRENCY x (POOL_SIZE + MAX_OVERFLOW)`, which has to stay well inside the database's
# max_connections.
POOL_SIZE = 5
MAX_OVERFLOW = 5


def _connect_args(settings: Settings) -> dict[str, Any]:
    args: dict[str, Any] = {
        "connect_timeout": 5,
        # libpq already enables keepalives, but only probes after the OS idle timeout, which can
        # be too long.
        "keepalives_idle": 30,
        # psycopg returns `timestamptz` values in the session's timezone, so this is what decides
        # the tzinfo every timestamp reaches the application with. D5 requires responses to
        # serialize timestamps with a `Z` suffix, and pydantic writes `Z` only for a datetime that
        # is actually UTC -- anything else gets a numeric offset. Postgres containers and RDS both
        # happen to default to UTC, but that is their configuration rather than ours, so pin it
        # here and make it a property of the connection.
        "options": "-c timezone=UTC",
    }
    if settings.database_ssl_ca:
        # `sslrootcert` alone is not enough: libpq defaults to sslmode=prefer, which will happily
        # accept an unverified -- or plaintext -- connection while ignoring the CA entirely.
        args["sslrootcert"] = settings.database_ssl_ca
        args["sslmode"] = "verify-full"
    return args


def make_engine(settings: Settings) -> Engine:
    """The engine, shared by API requests and by the `GET /healthz` probe."""
    return create_engine(
        settings.sqlalchemy_url,
        pool_size=POOL_SIZE,
        max_overflow=MAX_OVERFLOW,
        pool_timeout=10,
        pool_recycle=1800,
        pool_pre_ping=True,
        # Pinned rather than left to the server's configuration, because the suite registry's
        # freshness protocol depends on it (D2). At REPEATABLE READ a transaction's snapshot is
        # frozen at its first statement, so one that read anything before checking the schema
        # version could never observe another worker's bump within that request -- and every
        # concurrent bump would fail serialization instead of simply serializing. A role- or
        # parameter-group-level default would otherwise change this behaviour invisibly.
        isolation_level="READ COMMITTED",
        connect_args=_connect_args(settings),
    )


def get_engine(request: Request) -> Engine:
    """The engine for this instance.

    Deliberately an ordinary function rather than a generator: a generator dependency is torn down
    through FastAPI's exit stack, which it closes only *after* the response has been sent. Anything
    that needs to influence the status -- a COMMIT above all -- therefore cannot live there. Handing
    over the engine instead keeps the unit of work inside the endpoint, where an exception is still
    an ordinary 500.
    """
    engine: Engine = request.app.state.engine
    return engine


# What an endpoint writes to reach the database:
#
#     def endpoint(db: EngineDep) -> Thing:
#         with db.begin() as connection:
#             ...
#         return thing
#
# The block is the unit of work: it commits on the way out, rolls back if the body raises, and
# returns the connection to the pool before the response is built -- so a failing COMMIT becomes a
# 500 rather than a success the caller would believe, and no connection is held across
# serialization.
EngineDep = Annotated[Engine, Depends(get_engine)]


def unique_violation_constraint(error: DBAPIError) -> str | None:
    """The name of the unique constraint an error tripped, or None if that is not what it was.

    Attributing a violation is how a caller decides what to do about it: D13's get-or-create
    retries, while a run submission has to answer `duplicate` for a repeated UUID but
    `ordinal_conflict` for a taken ordinal (R4). The name is only dependable because every
    constraint has one we chose; see NAMING_CONVENTION in tables.py.
    """
    if not isinstance(error.orig, UniqueViolation):
        return None
    return error.orig.diag.constraint_name


@contextmanager
def reporting_violation(constraint: str, code: ErrorCode, message: str) -> Iterator[None]:
    """Report one named unique constraint's violation as an R4 error, re-raising anything else.

    The `!=` guard is the load-bearing half, and the half a hand-written copy leaves out: without
    it, an unrelated integrity failure inside the same statement would be reported as this
    constraint's 409 and the caller would retry forever against a different problem.

    The code is the caller's because R4 gives different 409s to different constraints -- a repeated
    machine name is `duplicate`, a taken ordinal is `ordinal_conflict`.
    """
    try:
        yield
    except IntegrityError as error:
        if unique_violation_constraint(error) != constraint:
            raise
        raise ApiError(code, message) from error


def is_undefined_table(error: DBAPIError) -> bool:
    """Whether an error means the table is not there, i.e. the database was never migrated.

    Deliberately narrower than `is_missing_relation` below, and not expressed in terms of it: the
    two ask different questions, and the answer to this one must not widen because the answer to
    that one did.
    """
    return isinstance(error.orig, UndefinedTable)


def is_missing_relation(error: DBAPIError) -> bool:
    """Whether an error means the table or column the statement named is not there.

    D2's stale reader: between a worker's version check and its next query another worker can
    remove a field, or the whole suite, so a request can reach a column that no longer exists.
    That window cannot be closed cheaply and does not have to be -- but the caller has to be able
    to tell it from a genuine fault, because the schema changed underneath the request and
    retrying will succeed (409, not 500).
    """
    return isinstance(error.orig, UndefinedTable | UndefinedColumn)


def is_duplicate_schema(error: DBAPIError) -> bool:
    """Whether an error means the namespace already exists.

    `POST /api/suites` reaches this when the `schema` row is absent but a namespace of that name is
    present -- the two are written in one transaction, so it takes an out-of-band change to get
    there. endpoints.md answers 409 for it, which needs telling this from a genuine server fault.
    """
    return isinstance(error.orig, DuplicateSchema)


def is_lock_unavailable(error: DBAPIError) -> bool:
    """Whether an error means the statement gave up waiting for a lock, rather than failed.

    Both cases a schema change can hit: `lock_timeout` expiring while an in-flight query holds the
    table, and the deadlock detector picking this transaction as its victim. Neither says anything
    is wrong with the request, so both answer 409 rather than 500 -- retrying is what a caller
    should do.
    """
    return isinstance(error.orig, LockNotAvailable | DeadlockDetected)

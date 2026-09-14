"""Database access: the engine, how an endpoint reaches it, and reading Postgres' errors.

The engine is built by an explicit factory call rather than at import, so that importing the
application does not require a reachable database (or even a populated environment), and so that
each worker builds its own. uvicorn spawns its workers rather than forking, so each one imports
this module fresh and no connection is ever inherited across a process boundary.
"""

from __future__ import annotations

from typing import Annotated, Any

from fastapi import Depends, Request
from psycopg.errors import UndefinedTable, UniqueViolation
from sqlalchemy import Engine, create_engine
from sqlalchemy.exc import DBAPIError

from .config import Settings

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


def is_undefined_table(error: DBAPIError) -> bool:
    """Whether an error means the table is not there, i.e. the database was never migrated."""
    return isinstance(error.orig, UndefinedTable)

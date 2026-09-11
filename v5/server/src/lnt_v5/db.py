"""Database engine construction.

The engine is built by an explicit factory call rather than at import, so that importing the
application does not require a reachable database (or even a populated environment), and so that
each worker builds its own. uvicorn spawns its workers rather than forking, so each one imports
this module fresh and no connection is ever inherited across a process boundary.
"""

from __future__ import annotations

from typing import Any

from sqlalchemy import Engine, create_engine

from .config import Settings

# Per-worker pool bounds. The live connection count is
# `WEB_CONCURRENCY x (POOL_SIZE + MAX_OVERFLOW)`, which has to stay well inside the database's
# max_connections.
POOL_SIZE = 5
MAX_OVERFLOW = 5


def _connect_args(settings: Settings) -> dict[str, Any]:
    args: dict[str, Any] = {
        "connect_timeout": 5,
        # libpq already enables keepalives, but only probes after the OS idle timeout, which can be too long.
        "keepalives_idle": 30,
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

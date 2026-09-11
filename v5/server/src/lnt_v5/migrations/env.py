"""Alembic's entry point.

Everything of substance lives in `lnt_v5.migrate`, which the server calls directly. This module
is the thin script Alembic itself executes, and it is deliberately not importable: the call at
the bottom runs migrations as a side effect.
"""

from __future__ import annotations

from alembic import context
from sqlalchemy import Connection

from lnt_v5.config import get_settings
from lnt_v5.db import make_engine
from lnt_v5.tables import metadata


def _run_migrations(connection: Connection) -> None:
    # `include_schemas` is deliberately left at its default of False, which confines
    # autogenerate to the default namespace. That is what keeps it away from the per-suite tables
    # (D14): they live in a schema per suite, are defined by data rather than by code, and would
    # otherwise be reflected, found in no metadata, and proposed for deletion. No filter of our own
    # is needed for that; `test_migrations.py` asserts the property rather than the mechanism.
    context.configure(
        connection=connection,
        target_metadata=metadata,
        compare_type=True,
    )
    with context.begin_transaction():
        context.run_migrations()


def run() -> None:
    if context.is_offline_mode():
        # `--sql` would be a reasonable thing to support, but nothing uses it: migrations are
        # applied by the server against a live database (D14). Refusing plainly beats emitting a
        # script from a code path no test covers.
        raise RuntimeError("Offline migrations are not supported; run against a live database.")

    # `lnt-v5 server migrate` hands us a connection it already holds the migration lock on. The
    # standalone `alembic` CLI, used to autogenerate revisions during development, does not.
    connection: Connection | None = context.config.attributes.get("connection")
    if connection is not None:
        _run_migrations(connection)
        return

    engine = make_engine(get_settings())
    try:
        with engine.connect() as own_connection:
            _run_migrations(own_connection)
    finally:
        engine.dispose()


run()

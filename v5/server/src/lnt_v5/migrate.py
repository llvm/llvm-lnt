"""Bringing a database up to the structure the code expects (D6).

This applies two kinds of migrations, in this order. First, Alembic migrates the global tables,
using the revisions in `migrations/`. Then the tables of every existing suite are migrated with the
steps in `suites/migrations.py`, one transaction per suite.

Neither adds nor removes a suite's dynamic columns. Those come from the suite's schema, and the
suite endpoints create and drop them at runtime.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from alembic import command
from alembic.config import Config
from alembic.operations import Operations
from alembic.runtime.migration import MigrationContext
from alembic.script import ScriptDirectory
from pydantic import ValidationError
from sqlalchemy import Connection, Engine, select, text, update

from lnt_v5.suites import migrations
from lnt_v5.suites.schema import SuiteSchema
from lnt_v5.tables import schema

# Inside the package rather than beside it, because the Dockerfile copies only `server/src` and
# installs the result into site-packages -- migrations left outside would simply not exist in the
# image, where the server needs them at startup.
MIGRATIONS_DIR = Path(__file__).resolve().parent / "migrations"

# An arbitrary but fixed key for Postgres' advisory locks, spelling "LNT5". Every process that
# applies migrations takes it first, so that two of them cannot run the same DDL at the same time --
# for example, two servers starting against the same database, or an operator running
# `lnt-v5 server migrate` while a server starts.
MIGRATION_LOCK_KEY = 0x4C4E5435


class MigrationError(Exception):
    """Raised when this build must not serve the database, for a reason an operator can fix.

    This is not a database error: the data was read without problems, but what it says rules out
    serving it.
    """


@dataclass(frozen=True)
class MigrationResult:
    """Which revision the global tables were at and are at now, and which suites were migrated."""

    before: str | None
    after: str | None
    suites_migrated: tuple[str, ...]

    @property
    def global_tables_migrated(self) -> bool:
        return self.before != self.after

    @property
    def applied(self) -> bool:
        return self.global_tables_migrated or bool(self.suites_migrated)


def alembic_config() -> Config:
    """The configuration the server migrates with, pointed at the packaged revisions.

    Built here rather than read from alembic.ini, which is a developer convenience for
    autogenerating revisions and is not shipped in the image.
    """
    config = Config()
    config.set_main_option("script_location", str(MIGRATIONS_DIR))
    return config


def current_revision(connection: Connection) -> str | None:
    """The revision a database is at, or None if it has never been migrated."""
    return MigrationContext.configure(connection).get_current_revision()


def head_revision() -> str | None:
    """The newest revision this build carries."""
    return ScriptDirectory.from_config(alembic_config()).get_current_head()


def upgrade_to_head(engine: Engine) -> MigrationResult:
    """Apply every outstanding change, or do nothing if there are none.

    Safe to call concurrently and safe to call repeatedly: the advisory lock serializes callers,
    and whichever one arrives second finds the work already done.

    The lock is held by the session rather than by a single transaction, because the work spans
    several transactions: one for the global tables, then one per suite. If a suite fails to
    migrate, the suites before it stay migrated. Every transaction runs on the same connection as
    the lock, so the lock is released when the work is done and can't be left behind on another
    connection.
    """
    with engine.connect() as connection:
        connection.execute(text("SELECT pg_advisory_lock(:key)"), {"key": MIGRATION_LOCK_KEY})
        connection.commit()
        try:
            before, after = _upgrade_global_tables(connection)
            migrated = _upgrade_suites(connection)
        finally:
            # Roll back any transaction a failure left open, since the unlock can't run inside it.
            connection.rollback()
            connection.execute(text("SELECT pg_advisory_unlock(:key)"), {"key": MIGRATION_LOCK_KEY})
            connection.commit()

    return MigrationResult(before=before, after=after, suites_migrated=migrated)


def _upgrade_global_tables(connection: Connection) -> tuple[str | None, str | None]:
    """Apply every outstanding Alembic revision, and report the revisions before and after.

    One transaction around every revision. Postgres has transactional DDL, so a migration that fails
    halfway leaves nothing behind. Alembic notices the connection is already in a transaction and
    leaves the commit to us.
    """
    config = alembic_config()
    known = {script.revision for script in ScriptDirectory.from_config(config).walk_revisions()}
    with connection.begin():
        before = current_revision(connection)
        if before is not None and before not in known:
            raise MigrationError(
                f"the database is at revision {before}, which this build does not know. A newer "
                "build has migrated it; run that build instead"
            )
        config.attributes["connection"] = connection
        command.upgrade(config, "head")
        after = current_revision(connection)
    return before, after


def _upgrade_suites(connection: Connection) -> tuple[str, ...]:
    """Migrate the tables of every suite that is behind, and return the names of those suites.

    Every suite is checked before any of them is migrated, so that if this build has to refuse the
    database, it does so before changing anything.
    """
    head = migrations.head()
    with connection.begin():
        rows = connection.execute(
            select(schema.c.name, schema.c.migration_version, schema.c.schema_json).order_by(
                schema.c.name
            )
        ).all()

    for name, version, schema_json in rows:
        if version > head:
            raise MigrationError(
                f"test suite '{name}' is at migration version {version}, but this build only knows "
                f"up to version {head}. A newer build has migrated it; run that build instead"
            )
        if version < head:
            try:
                SuiteSchema.model_validate_json(schema_json)
            except ValidationError as error:
                # The registry skips a suite it cannot parse and serves the others, but here we
                # have to stop: the steps need the schema, and if we skipped the suite, it would be
                # served without its migrations once someone fixed the row.
                raise MigrationError(
                    f"test suite '{name}' cannot be migrated, because its stored schema is "
                    f"invalid: {error}"
                ) from error

    migrated: list[str] = []
    for name, version, _ in rows:
        if version < head and _upgrade_suite(connection, name, head):
            migrated.append(name)
    return tuple(migrated)


def _upgrade_suite(connection: Connection, name: str, head: int) -> bool:
    """Run one suite's outstanding steps in a single transaction. Returns whether any steps ran.

    Like every change to a suite (see `store.py`), this first locks the suite's `schema` row, so
    that a running server can't change or drop the suite while its tables are being migrated. It
    waits for the lock as long as necessary: unlike a request, nothing else is waiting for this
    connection. The steps use the row as read under the lock.
    """
    with connection.begin():
        row = connection.execute(
            select(schema.c.schema_json, schema.c.migration_version)
            .where(schema.c.name == name)
            .with_for_update()
        ).one_or_none()
        if row is None or row.migration_version >= head:
            # Only possible if a running server deleted the suite since the first pass, or deleted
            # it and created it again at the latest version.
            return False

        suite = SuiteSchema.model_validate_json(row.schema_json)
        operations = Operations(MigrationContext.configure(connection))
        for step in migrations.STEPS[row.migration_version : head]:
            step(operations, suite)
        connection.execute(
            update(schema).where(schema.c.name == name).values(migration_version=head)
        )
    return True

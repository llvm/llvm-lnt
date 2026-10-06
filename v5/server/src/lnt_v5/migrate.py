"""Bringing a database up to the structure the code expects (D6).

Two sequences of changes are applied here, in this order. The global tables are migrated by
Alembic, from the revisions in `migrations/`. Then the built-in structure of every existing suite is
brought forward by the steps in `suites/migrations.py`, each suite in a transaction of its own.

Neither touches a suite's dynamic columns, which are defined by data -- the suite's schema -- and
are created and altered at runtime by the suite endpoints instead.
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
# applies migrations takes it first, so that two of them -- two servers starting against one
# database, or an operator running `lnt-v5 server migrate` while a server starts -- cannot run the
# same DDL concurrently.
MIGRATION_LOCK_KEY = 0x4C4E5435


class MigrationError(Exception):
    """A database this build must not serve, for a reason an operator can act on.

    Not a database error: everything here was read successfully, and what was read is the problem.
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

    The lock is a session-level one, held on one connection across several transactions -- the
    global migration's, then one per suite -- rather than tied to a single transaction, so that a
    suite that fails to migrate leaves the suites before it migrated. Every transaction runs on that
    same connection, so the lock cannot outlive the work by being stranded on another one.
    """
    with engine.connect() as connection:
        connection.execute(text("SELECT pg_advisory_lock(:key)"), {"key": MIGRATION_LOCK_KEY})
        connection.commit()
        try:
            before, after = _upgrade_global_tables(connection)
            migrated = _upgrade_suites(connection)
        finally:
            # A no-op unless a failure left a transaction open, which the unlock cannot run inside.
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
                f"the database is at revision {before}, which this build does not know: it was "
                "migrated by a newer build, which is the one to run"
            )
        config.attributes["connection"] = connection
        command.upgrade(config, "head")
        after = current_revision(connection)
    return before, after


def _upgrade_suites(connection: Connection) -> tuple[str, ...]:
    """Bring every suite's built-in structure forward to this build's, and name the ones that moved.

    Every suite is checked before any is migrated, so that a database this build must refuse is
    refused as it was found rather than after part of it has been migrated anyway.
    """
    head = migrations.head()
    with connection.begin():
        positions = connection.execute(
            select(schema.c.name, schema.c.structure_version).order_by(schema.c.name)
        ).all()

    for name, version in positions:
        if version > head:
            raise MigrationError(
                f"test suite '{name}' is at structure version {version}, but this build only knows "
                f"up to version {head}: it was migrated by a newer build, which is the one to run"
            )
    migrated: list[str] = []
    for name, version in positions:
        if version < head and _upgrade_suite(connection, name, head):
            migrated.append(name)
    return tuple(migrated)


def _upgrade_suite(connection: Connection, name: str, head: int) -> bool:
    """Run one suite's outstanding steps in one transaction, and say whether it still existed.

    The suite's `schema` row is locked first, as every change to a suite does (see `store.py`), so
    that a server already running cannot change or drop the suite while its tables are rebuilt. It
    waits as long as that takes: unlike a request, nothing is waiting on this to free a connection.
    """
    with connection.begin():
        row = connection.execute(
            select(schema.c.schema_json, schema.c.structure_version)
            .where(schema.c.name == name)
            .with_for_update()
        ).one_or_none()
        if row is None:
            # Deleted since the versions were read, which only a running server can do.
            return False

        try:
            suite = SuiteSchema.model_validate_json(row.schema_json)
        except ValidationError as error:
            # Unlike the registry, which skips a suite it cannot parse and serves the rest, this
            # has to stop: the steps need the schema, and a suite left behind would fail later.
            raise MigrationError(
                f"test suite '{name}' cannot be migrated, because its stored schema is invalid: "
                f"{error}"
            ) from error

        operations = Operations(MigrationContext.configure(connection))
        for step in migrations.STEPS[row.structure_version : head]:
            step(operations, suite)
        connection.execute(
            update(schema).where(schema.c.name == name).values(structure_version=head)
        )
    return True

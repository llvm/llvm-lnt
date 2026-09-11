"""Bringing a database up to the structure the code expects (D14).

Only the global tables are managed here. Per-suite tables are created and altered at runtime from
a suite's schema, which is a different mechanism for a different reason: those tables are defined
by data, so no revision written in advance could describe them.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from alembic import command
from alembic.config import Config
from alembic.runtime.migration import MigrationContext
from alembic.script import ScriptDirectory
from sqlalchemy import Connection, Engine, text

# Inside the package rather than beside it, because the Dockerfile copies only `server/src` and
# installs the result into site-packages -- migrations left outside would simply not exist in the
# image, where the server needs them at startup.
MIGRATIONS_DIR = Path(__file__).resolve().parent / "migrations"

# An arbitrary but fixed key for Postgres' advisory locks, spelling "LNT5". Every process that
# applies migrations takes it first, so two servers starting at once cannot run the same DDL
# concurrently -- which is not hypothetical: a deploy replaces the EC2 instance, and the outgoing
# and incoming ones overlap.
MIGRATION_LOCK_KEY = 0x4C4E5435


@dataclass(frozen=True)
class MigrationResult:
    """Which revision the database was at, and which it is at now."""

    before: str | None
    after: str | None

    @property
    def applied(self) -> bool:
        return self.before != self.after


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
    """Apply every outstanding migration, or do nothing if there are none.

    Safe to call concurrently and safe to call repeatedly: the advisory lock serializes callers,
    and whichever one arrives second finds the work already done.
    """
    # One transaction around the lock and every revision. Postgres has transactional DDL, so a
    # migration that fails halfway leaves nothing behind, and `pg_advisory_xact_lock` is released
    # by the same commit or rollback -- no unlock to get wrong, and no second connection whose only
    # job is to hold a session-scoped lock. Alembic notices the connection is already in a
    # transaction and leaves the commit to us.
    with engine.begin() as connection:
        connection.execute(text("SELECT pg_advisory_xact_lock(:key)"), {"key": MIGRATION_LOCK_KEY})
        before = current_revision(connection)
        config = alembic_config()
        config.attributes["connection"] = connection
        command.upgrade(config, "head")
        after = current_revision(connection)

    return MigrationResult(before=before, after=after)

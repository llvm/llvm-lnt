"""The global tables (D5): the constraints they carry and the defaults they apply."""

from __future__ import annotations

from collections.abc import Callable
from datetime import UTC, datetime

import pytest
from sqlalchemy import Connection, insert, select, text
from sqlalchemy.exc import IntegrityError

from lnt_v5.keys import PREFIX_CONSTRAINT
from lnt_v5.scopes import Scope
from lnt_v5.tables import api_key, metadata, schema, schema_version


def constraints_on(connection: Connection, table: str) -> set[str]:
    return set(
        connection.execute(
            text("SELECT conname FROM pg_constraint WHERE conrelid = CAST(:table AS regclass)"),
            {"table": table},
        ).scalars()
    )


def indexes_on(connection: Connection, table: str) -> set[str]:
    """Index names, which `pg_constraint` does not hold -- a plain index is not a constraint."""
    return set(
        connection.execute(
            text("SELECT indexname FROM pg_indexes WHERE tablename = :table"),
            {"table": table},
        ).scalars()
    )


class TestNamingConvention:
    def test_names_every_constraint_rather_than_letting_postgres_invent_one(
        self, db: Connection
    ) -> None:
        assert {
            "pk_api_key",
            "uq_api_key_prefix",
            "uq_api_key_key_hash",
            "ck_api_key_scope",
        } <= constraints_on(db, "api_key")

    def test_gives_the_prefix_constraint_the_name_keys_py_retries_on(self, db: Connection) -> None:
        # create_key tells a prefix collision, which it retries, from any other integrity error,
        # which it re-raises -- by the constraint's name, which it writes out. Changing the
        # convention has to fail here rather than silently make that a re-raise.
        assert PREFIX_CONSTRAINT in constraints_on(db, "api_key")

    def test_every_composed_name_reaches_the_database_intact(self, db: Connection) -> None:
        """No name is long enough to be truncated on the way in (D14).

        Postgres truncates an identifier over 63 bytes with a warning rather than an error, so a
        composed name that overflows is not the name a violation is reported under: attribution
        would still find a constraint, still read a name, and silently never match. Comparing every
        name against what Postgres stored is what rules that out -- and it is the reason the names
        written out elsewhere in the codebase are safe to write out.

        Indexes are compared alongside constraints because `ix_...` is the longest template the
        convention has, and a plain index does not appear in `pg_constraint`.

        This covers the global tables, the ones this metadata describes. Per-suite tables adopt the
        same convention but are built at runtime from a suite's schema, so whatever creates them
        owes an equivalent check; see NAMING_CONVENTION in tables.py.
        """
        for table in metadata.sorted_tables:
            stored = constraints_on(db, table.name) | indexes_on(db, table.name)
            composed = {
                str(constraint.name)
                for constraint in table.constraints
                if constraint.name is not None
            } | {str(index.name) for index in table.indexes if index.name is not None}
            assert composed <= stored, f"{table.name}: {sorted(composed - stored)} did not survive"


class TestSchemaVersion:
    def test_holds_exactly_one_row(self, db: Connection) -> None:
        # D5 promises the row is there and addressable at a fixed id, so nothing may add another.
        with pytest.raises(IntegrityError), db.begin_nested():
            db.execute(insert(schema_version).values(id=2, version=0))

    def test_can_be_bumped(self, db: Connection) -> None:
        db.execute(text("UPDATE schema_version SET version = version + 1"))

        assert db.execute(select(schema_version.c.version)).scalar_one() == 1


class TestApiKey:
    def test_rejects_a_reused_prefix(self, db: Connection, insert_key: Callable[..., None]) -> None:
        # D5: a prefix is the API's handle on a key, so it must never name two of them.
        insert_key()

        with pytest.raises(IntegrityError), db.begin_nested():
            insert_key(key_hash="b" * 64)

    def test_rejects_a_reused_hash(self, db: Connection, insert_key: Callable[..., None]) -> None:
        insert_key()

        with pytest.raises(IntegrityError), db.begin_nested():
            insert_key(prefix="ffffffff")

    @pytest.mark.parametrize("scope", list(Scope))
    def test_accepts_every_scope_r5_defines(
        self, insert_key: Callable[..., None], scope: Scope
    ) -> None:
        insert_key(
            scope=scope.value,
            prefix=scope.value[:8].ljust(8, "0"),
            key_hash=scope.value.ljust(64, "0"),
        )

    @pytest.mark.parametrize("scope", ["", "root", "READ", "superuser"])
    def test_rejects_a_scope_outside_that_set(
        self, db: Connection, insert_key: Callable[..., None], scope: str
    ) -> None:
        # Cheap insurance against a bug minting a key that authenticates as something nobody
        # intended; the scope is validated before we get here, so this only ever fires on one.
        with pytest.raises(IntegrityError), db.begin_nested():
            insert_key(scope=scope)

    def test_starts_active_and_never_used(
        self, db: Connection, insert_key: Callable[..., None]
    ) -> None:
        insert_key()

        row = db.execute(
            select(api_key.c.is_active, api_key.c.last_used_at, api_key.c.created_at)
        ).one()

        assert row.is_active is True
        assert row.last_used_at is None
        assert row.created_at is not None


class TestTimestamps:
    def test_are_timezone_aware_and_in_utc(self, db: Connection) -> None:
        # D5's convention for every timestamp column in the instance. A naive datetime here
        # would silently be interpreted in whatever the reader's local zone happens to be.
        before = datetime.now(UTC)
        db.execute(insert(schema).values(name="nts", schema_json="{}"))

        created_at = db.execute(select(schema.c.created_at)).scalar_one()

        assert created_at.tzinfo is not None
        assert created_at.utcoffset() == UTC.utcoffset(None)
        # The default is the database's clock, not the application's, so that concurrent workers
        # agree on ordering. Both clocks are the same machine here, so this only sanity-checks it.
        assert abs((created_at - before).total_seconds()) < 60

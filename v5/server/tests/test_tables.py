"""The global tables (D5): the constraints they carry and the defaults they apply."""

from __future__ import annotations

from collections.abc import Callable
from datetime import UTC, datetime

import pytest
from sqlalchemy import Connection, Engine, insert, inspect, select, text
from sqlalchemy.exc import IntegrityError

from introspection import assert_names_survived, stored_names
from lnt_v5.keys import PREFIX_CONSTRAINT
from lnt_v5.scopes import UNRESTRICTABLE_SCOPES, Scope
from lnt_v5.tables import api_key, api_key_restriction, metadata, schema, schema_version


class TestNamingConvention:
    def test_names_every_constraint_rather_than_letting_postgres_invent_one(
        self, db_engine: Engine
    ) -> None:
        assert {
            "pk_api_key",
            "uq_api_key_prefix",
            "uq_api_key_key_hash",
            "ck_api_key_scope",
            "ck_api_key_restricted",
        } <= stored_names(inspect(db_engine))["api_key"]

    def test_gives_the_prefix_constraint_the_name_keys_py_retries_on(
        self, db_engine: Engine
    ) -> None:
        # create_key tells a prefix collision, which it retries, from any other integrity error,
        # which it re-raises -- by the constraint's name, which it writes out. Changing the
        # convention has to fail here rather than silently make that a re-raise.
        assert PREFIX_CONSTRAINT in stored_names(inspect(db_engine))["api_key"]

    def test_every_composed_name_reaches_the_database_intact(self, db_engine: Engine) -> None:
        """The global tables' half of the identifier-limit check (D4); see `assert_names_survived`.

        Per-suite tables adopt the same convention but are built at runtime from a suite's schema,
        so they are checked separately, in `test_suite_tables.py`.
        """
        assert_names_survived(inspect(db_engine), metadata, schema=None)


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
    def test_accepts_every_scope(self, insert_key: Callable[..., None], scope: Scope) -> None:
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

    @pytest.mark.parametrize("scope", sorted(set(Scope) - set(UNRESTRICTABLE_SCOPES)))
    def test_can_restrict_a_restrictable_scope(
        self, insert_key: Callable[..., None], scope: Scope
    ) -> None:
        insert_key(scope=scope.value, restricted=True)

    @pytest.mark.parametrize("scope", UNRESTRICTABLE_SCOPES)
    def test_cannot_restrict_another_scope(
        self, db: Connection, insert_key: Callable[..., None], scope: Scope
    ) -> None:
        # Alembic does not compare check constraints, so this is what shows that the migration
        # created this one. `create_key` checks it first.
        with pytest.raises(IntegrityError), db.begin_nested():
            insert_key(scope=scope.value, restricted=True)

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


class TestApiKeyRestriction:
    @pytest.fixture
    def ids(self, db: Connection, insert_key: Callable[..., None]) -> tuple[int, int]:
        """The ids of a restricted key and of a suite."""
        insert_key(scope=Scope.SUBMIT.value, restricted=True)
        suite = db.execute(
            insert(schema)
            .values(name="nts", namespace="nts", schema_json="{}", migration_version=0)
            .returning(schema.c.id)
        ).scalar_one()
        return db.execute(select(api_key.c.id)).scalar_one(), suite

    def test_lists_a_suite_once_per_key(self, db: Connection, ids: tuple[int, int]) -> None:
        key, suite = ids
        db.execute(insert(api_key_restriction).values(api_key_id=key, suite_id=suite))

        with pytest.raises(IntegrityError), db.begin_nested():
            db.execute(insert(api_key_restriction).values(api_key_id=key, suite_id=suite))

    def test_goes_with_its_suite(self, db: Connection, ids: tuple[int, int]) -> None:
        key, suite = ids
        db.execute(insert(api_key_restriction).values(api_key_id=key, suite_id=suite))

        db.execute(schema.delete())

        assert db.execute(select(api_key_restriction)).all() == []


class TestTimestamps:
    def test_are_timezone_aware_and_in_utc(self, db: Connection) -> None:
        # D5's convention for every timestamp column in the instance. A naive datetime here
        # would silently be interpreted in whatever the reader's local zone happens to be.
        before = datetime.now(UTC)
        db.execute(
            insert(schema).values(
                name="nts", namespace="nts", schema_json="{}", migration_version=0
            )
        )

        created_at = db.execute(select(schema.c.created_at)).scalar_one()

        assert created_at.tzinfo is not None
        assert created_at.utcoffset() == UTC.utcoffset(None)
        # The default is the database's clock, not the application's, so that concurrent workers
        # agree on ordering. Both clocks are the same machine here, so this only sanity-checks it.
        assert abs((created_at - before).total_seconds()) < 60

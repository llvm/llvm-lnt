"""Bringing the built-in structure of existing suites forward (D6).

The mechanism is exercised with stand-in steps, since this build has none of its own yet. The
snapshot tests are what hold the real steps, and `suites/tables.py`, to each other.
"""

from __future__ import annotations

from collections.abc import Callable, Sequence

import pytest
import sqlalchemy as sa
from alembic.operations import Operations
from fastapi.testclient import TestClient
from sqlalchemy import Engine, create_engine, insert, select, text
from sqlalchemy.pool import NullPool

from introspection import column_names, structure_of
from lnt_v5.migrate import MIGRATION_LOCK_KEY, MigrationError, upgrade_to_head
from lnt_v5.routes.suites import SUITES_PATH
from lnt_v5.suites import migrations
from lnt_v5.suites import tables as suite_tables
from lnt_v5.suites.migrations import Step
from lnt_v5.suites.schema import SuiteSchema
from lnt_v5.suites.store import normalized_json
from lnt_v5.tables import schema
from suite_structure import reference_schema, replay, snapshot_versions

UseSteps = Callable[[Sequence[Step]], None]


@pytest.fixture
def use_steps(monkeypatch: pytest.MonkeyPatch) -> UseSteps:
    """Replace this build's steps for the duration of a test."""

    def use(steps: Sequence[Step]) -> None:
        monkeypatch.setattr(migrations, "STEPS", tuple(steps))

    return use


def suite_named(name: str) -> SuiteSchema:
    return reference_schema().model_copy(update={"name": name})


def store_suite(engine: Engine, suite: SuiteSchema, version: int) -> None:
    """A suite recorded at `version`, as an earlier build would have left it."""
    with engine.begin() as connection:
        connection.execute(
            insert(schema).values(
                name=suite.name, schema_json=normalized_json(suite), structure_version=version
            )
        )
        suite_tables.create(connection, suite)


def version_of(engine: Engine, name: str) -> int:
    with engine.connect() as connection:
        return int(
            connection.execute(
                select(schema.c.structure_version).where(schema.c.name == name)
            ).scalar_one()
        )


def adding_machine_column(column: str, calls: list[tuple[str, str]] | None = None) -> Step:
    """A stand-in step that adds a column to `{suite}.machine`, recording that it ran."""

    def step(op: Operations, suite: SuiteSchema) -> None:
        if calls is not None:
            calls.append((suite.name, column))
        op.add_column("machine", sa.Column(column, sa.Text()), schema=suite.name)

    return step


class TestUpgrade:
    def test_runs_the_outstanding_steps_in_order_and_records_the_version(
        self, db_engine: Engine, use_steps: UseSteps
    ) -> None:
        store_suite(db_engine, suite_named("nts"), version=0)
        calls: list[tuple[str, str]] = []
        use_steps([adding_machine_column("first", calls), adding_machine_column("second", calls)])

        result = upgrade_to_head(db_engine)

        assert calls == [("nts", "first"), ("nts", "second")]
        assert version_of(db_engine, "nts") == 2
        assert column_names(db_engine, "nts", "machine")[-2:] == ["first", "second"]
        assert result.suites_migrated == ("nts",)
        assert result.structure_version == 2
        assert result.applied

    def test_runs_only_the_steps_a_suite_has_not_had(
        self, db_engine: Engine, use_steps: UseSteps
    ) -> None:
        store_suite(db_engine, suite_named("nts"), version=1)
        calls: list[tuple[str, str]] = []
        use_steps([adding_machine_column("first", calls), adding_machine_column("second", calls)])

        upgrade_to_head(db_engine)

        assert calls == [("nts", "second")]
        assert version_of(db_engine, "nts") == 2

    def test_gives_each_step_the_suites_own_schema(
        self, db_engine: Engine, use_steps: UseSteps
    ) -> None:
        # Some built-in structure is per-metric (`test_coverage`), so a step has to know the suite's
        # metrics -- the stored ones, not some other suite's.
        stored = suite_named("nts").model_copy(update={"metrics": suite_named("nts").metrics[:1]})
        store_suite(db_engine, stored, version=0)
        seen: list[SuiteSchema] = []
        use_steps([lambda op, suite: seen.append(suite)])

        upgrade_to_head(db_engine)

        assert seen == [stored]

    def test_does_nothing_the_second_time(self, db_engine: Engine, use_steps: UseSteps) -> None:
        # `server run` migrates on every start, so the common case is having nothing to do.
        store_suite(db_engine, suite_named("nts"), version=0)
        calls: list[tuple[str, str]] = []
        use_steps([adding_machine_column("first", calls)])
        upgrade_to_head(db_engine)

        result = upgrade_to_head(db_engine)

        assert calls == [("nts", "first")]
        assert result.suites_migrated == ()
        assert not result.applied

    def test_a_failing_suite_is_left_as_it_was_and_earlier_ones_stay_migrated(
        self, db_engine: Engine, use_steps: UseSteps
    ) -> None:
        store_suite(db_engine, suite_named("a"), version=0)
        store_suite(db_engine, suite_named("b"), version=0)

        def failing_on_b(op: Operations, suite: SuiteSchema) -> None:
            op.add_column("machine", sa.Column("added", sa.Text()), schema=suite.name)
            if suite.name == "b":
                raise RuntimeError("the step failed")

        use_steps([failing_on_b])

        with pytest.raises(RuntimeError, match="the step failed"):
            upgrade_to_head(db_engine)

        # Suites are migrated in name order, each in a transaction of its own.
        assert version_of(db_engine, "a") == 1
        assert "added" in column_names(db_engine, "a", "machine")
        assert version_of(db_engine, "b") == 0
        assert "added" not in column_names(db_engine, "b", "machine")

    def test_refuses_a_suite_a_newer_build_migrated_before_migrating_any(
        self, db_engine: Engine, use_steps: UseSteps
    ) -> None:
        store_suite(db_engine, suite_named("a"), version=0)
        store_suite(db_engine, suite_named("b"), version=2)
        calls: list[tuple[str, str]] = []
        use_steps([adding_machine_column("first", calls)])

        with pytest.raises(MigrationError, match="'b' is at structure version 2"):
            upgrade_to_head(db_engine)

        assert calls == []
        assert version_of(db_engine, "a") == 0

    def test_refuses_a_suite_whose_stored_schema_is_invalid(
        self, db_engine: Engine, use_steps: UseSteps
    ) -> None:
        with db_engine.begin() as connection:
            connection.execute(
                insert(schema).values(
                    name="bad", schema_json='{"name": "bad", "nonsense": 1}', structure_version=0
                )
            )
        use_steps([adding_machine_column("first")])

        with pytest.raises(MigrationError, match=r"'bad'.*stored schema is invalid"):
            upgrade_to_head(db_engine)

    def test_releases_the_lock_when_it_fails(
        self, db_engine: Engine, migrated_database_url: str, use_steps: UseSteps
    ) -> None:
        # The lock is held across transactions, so a failure in one of them must not strand it on
        # the pooled connection, where it would hang every later migration until a restart.
        store_suite(db_engine, suite_named("nts"), version=5)

        with pytest.raises(MigrationError):
            upgrade_to_head(db_engine)

        other = create_engine(migrated_database_url, poolclass=NullPool)
        try:
            with other.connect() as connection:
                taken = connection.execute(
                    text("SELECT pg_try_advisory_lock(:key)"), {"key": MIGRATION_LOCK_KEY}
                ).scalar_one()
                connection.execute(
                    text("SELECT pg_advisory_unlock(:key)"), {"key": MIGRATION_LOCK_KEY}
                )
        finally:
            other.dispose()
        assert taken

    def test_a_suite_is_created_at_the_latest_version(
        self,
        db_engine: Engine,
        use_steps: UseSteps,
        api_client: TestClient,
        manage: dict[str, str],
    ) -> None:
        # Its tables come from `suites/tables.py`, which already describes the latest structure, so
        # replaying any step onto them would apply it twice.
        calls: list[tuple[str, str]] = []
        use_steps([adding_machine_column("first", calls), adding_machine_column("second", calls)])

        response = api_client.post(SUITES_PATH, json={"name": "nts"}, headers=manage)
        assert response.status_code == 201, response.text

        assert version_of(db_engine, "nts") == 2
        assert upgrade_to_head(db_engine).suites_migrated == ()
        assert calls == []


class TestSnapshots:
    """The structure of the reference suite at every version (see `suite_structure.py`)."""

    def test_every_version_has_a_snapshot(self) -> None:
        assert snapshot_versions() == list(range(migrations.head() + 1)), (
            "every version needs exactly one snapshot; see tests/suite_structure.py"
        )

    def test_the_latest_snapshot_is_what_the_code_creates(self, db_engine: Engine) -> None:
        """The test that fails when `suites/tables.py` changes without a step.

        If it fails, the built-in structure no longer matches the latest snapshot. Existing suites
        have the snapshot's structure, so they need a step in `suites/migrations.py` that brings
        them to the new one, and the new version needs a snapshot of its own. Rewriting the
        snapshot instead would leave every existing suite behind.
        """
        with db_engine.begin() as connection:
            replay(connection, migrations.head())
        snapshotted = structure_of(db_engine, "reference")

        assert snapshotted == fresh_structure(db_engine), (
            "the built-in structure in suites/tables.py no longer matches the latest snapshot: "
            "it needs a step in suites/migrations.py and a new snapshot (see this test's docstring)"
        )

    @pytest.mark.parametrize("version", range(migrations.head()))
    def test_migrating_an_older_snapshot_yields_what_the_code_creates(
        self, db_engine: Engine, version: int
    ) -> None:
        # D6: a suite brought forward is indistinguishable from one created by the same build.
        with db_engine.begin() as connection:
            replay(connection, version)
            connection.execute(
                insert(schema).values(
                    name="reference",
                    schema_json=normalized_json(reference_schema()),
                    structure_version=version,
                )
            )
        upgrade_to_head(db_engine)
        migrated = structure_of(db_engine, "reference")

        assert migrated == fresh_structure(db_engine)

    def test_a_step_brings_a_suite_forward_to_what_the_code_creates(
        self, db_engine: Engine, use_steps: UseSteps
    ) -> None:
        """The comparison above, exercised end to end on a change this codebase actually made.

        `regression.created_at` and its index were added to `suites/tables.py` after suites already
        existed. Had any been deployed, this is the step they would have needed. Until this build
        has real steps, it is also what shows the comparison can tell an old suite from a new one.
        """
        with db_engine.begin() as connection:
            store_suite_without_regression_created_at(connection)
        old = structure_of(db_engine, "reference")

        def add_regression_created_at(op: Operations, suite: SuiteSchema) -> None:
            op.add_column(
                "regression",
                sa.Column(
                    "created_at",
                    sa.DateTime(timezone=True),
                    server_default=sa.text("now()"),
                    nullable=False,
                ),
                schema=suite.name,
            )
            op.create_index(
                "ix_regression_created_at_id",
                "regression",
                ["created_at", "id"],
                schema=suite.name,
            )

        use_steps([add_regression_created_at])
        upgrade_to_head(db_engine)
        migrated = structure_of(db_engine, "reference")

        fresh = fresh_structure(db_engine)
        assert old != fresh
        assert migrated == fresh


def store_suite_without_regression_created_at(connection: sa.Connection) -> None:
    """The reference suite at version 0 of a sequence whose first step adds the column."""
    connection.execute(
        insert(schema).values(
            name="reference",
            schema_json=normalized_json(reference_schema()),
            structure_version=0,
        )
    )
    suite_tables.create(connection, reference_schema())
    connection.execute(text("ALTER TABLE reference.regression DROP COLUMN created_at"))


def fresh_structure(engine: Engine) -> dict[str, list[tuple[object, ...]]]:
    """What this build creates the reference suite with, after dropping whatever was there.

    The comparison is made in the same namespace, since PostgreSQL renders a foreign key with its
    target's namespace.
    """
    with engine.begin() as connection:
        connection.execute(text("DROP SCHEMA IF EXISTS reference CASCADE"))
        suite_tables.create(connection, reference_schema())
    return structure_of(engine, "reference")

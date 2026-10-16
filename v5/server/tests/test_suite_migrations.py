"""Migrating the tables of existing suites (D6).

The mechanism is tested with stand-in steps, so that its tests do not depend on what the real ones
do. The snapshot tests check that the real steps and `suites/tables.py` agree.
"""

from __future__ import annotations

from collections.abc import Callable
from datetime import UTC, datetime
from typing import Any

import pytest
import sqlalchemy as sa
from alembic.operations import Operations
from sqlalchemy import Connection, Engine, create_engine, insert, select, text
from sqlalchemy.pool import NullPool

from conftest import store_suite
from introspection import column_names, structure_of
from lnt_v5.migrate import MIGRATION_LOCK_KEY, MigrationError, upgrade_to_head
from lnt_v5.suites import migrations
from lnt_v5.suites import tables as suite_tables
from lnt_v5.suites.migrations import Step
from lnt_v5.suites.schema import SuiteSchema
from lnt_v5.suites.store import normalized_json
from lnt_v5.suites.tables import SuiteTables
from lnt_v5.tables import schema
from migration_snapshots import reference_schema, replay, snapshot_versions


def suite_named(name: str) -> SuiteSchema:
    return reference_schema().model_copy(update={"name": name})


def version_of(engine: Engine, name: str) -> int:
    with engine.connect() as connection:
        return int(
            connection.execute(
                select(schema.c.migration_version).where(schema.c.name == name)
            ).scalar_one()
        )


def adding_machine_column(column: str, calls: list[tuple[str, str]]) -> Step:
    """A stand-in step that adds a column to `{suite}.machine`, recording that it ran."""

    def step(op: Operations, suite: SuiteSchema) -> None:
        calls.append((suite.name, column))
        op.add_column("machine", sa.Column(column, sa.Text()), schema=suite.name)

    return step


def migration_lock_is_free(database_url: str) -> bool:
    """Whether another session could take the migration lock right now.

    This uses an engine of its own. The lock belongs to a session, and the session holding it can
    take it again, so checking from a pooled connection could report a leftover lock as free.
    """
    engine = create_engine(database_url, poolclass=NullPool)
    try:
        with engine.connect() as connection:
            taken = bool(
                connection.execute(
                    text("SELECT pg_try_advisory_lock(:key)"), {"key": MIGRATION_LOCK_KEY}
                ).scalar_one()
            )
            if taken:
                connection.execute(
                    text("SELECT pg_advisory_unlock(:key)"), {"key": MIGRATION_LOCK_KEY}
                )
    finally:
        engine.dispose()
    return taken


def replay_reference(connection: Connection, version: int) -> None:
    """The reference suite as a suite at `version` is: its tables then, and its row in `schema`."""
    replay(connection, version)
    connection.execute(
        insert(schema).values(
            name="reference",
            schema_json=normalized_json(reference_schema()),
            migration_version=version,
        )
    )


def seed_runs(connection: Connection, runs: list[dict[str, Any]]) -> None:
    """A machine and a commit in the reference suite, and a run of theirs per entry of `runs`, which
    holds that run's other columns."""
    connection.execute(text("INSERT INTO reference.machine (name) VALUES ('m')"))
    connection.execute(text("INSERT INTO reference.commit (commit) VALUES ('c')"))
    for index, columns in enumerate(runs):
        connection.execute(
            text(
                f"INSERT INTO reference.run (uuid, machine_id, commit_id, {', '.join(columns)}) "
                f"SELECT :uuid, machine.id, commit.id, {', '.join(f':{name}' for name in columns)} "
                "FROM reference.machine, reference.commit"
            ),
            {"uuid": f"{index}0000000-0000-4000-8000-000000000000", **columns},
        )


def fresh_structure(engine: Engine) -> dict[str, list[tuple[Any, ...]]]:
    """Replace the reference suite with a new one from this build, and return its structure.

    It uses the same namespace as the suite it is compared with, because PostgreSQL includes the
    target's namespace when it renders a foreign key.
    """
    with engine.begin() as connection:
        suite_tables.drop(connection, "reference")
        suite_tables.create(connection, reference_schema())
    return structure_of(engine, "reference")


class TestUpgrade:
    def test_runs_the_outstanding_steps_in_order_and_records_the_version(
        self, db_engine: Engine, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        store_suite(db_engine, suite_named("nts"), version=0)
        calls: list[tuple[str, str]] = []
        monkeypatch.setattr(
            migrations,
            "STEPS",
            (adding_machine_column("first", calls), adding_machine_column("second", calls)),
        )

        result = upgrade_to_head(db_engine)

        assert calls == [("nts", "first"), ("nts", "second")]
        assert version_of(db_engine, "nts") == 2
        assert column_names(db_engine, "nts", "machine")[-2:] == ["first", "second"]
        assert result.suites_migrated == ("nts",)
        assert result.applied

    def test_runs_only_the_steps_a_suite_has_not_had(
        self, db_engine: Engine, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        store_suite(db_engine, suite_named("nts"), version=1)
        calls: list[tuple[str, str]] = []
        monkeypatch.setattr(
            migrations,
            "STEPS",
            (adding_machine_column("first", calls), adding_machine_column("second", calls)),
        )

        upgrade_to_head(db_engine)

        assert calls == [("nts", "second")]
        assert version_of(db_engine, "nts") == 2

    def test_gives_each_step_the_suites_own_schema(
        self, db_engine: Engine, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # A step may need to change something for each metric (like the flags in `test_coverage`),
        # so it needs the suite's own metrics.
        nts = suite_named("nts")
        stored = nts.model_copy(update={"metrics": nts.metrics[:1]})
        store_suite(db_engine, stored, version=0)
        seen: list[SuiteSchema] = []
        monkeypatch.setattr(migrations, "STEPS", (lambda op, suite: seen.append(suite),))

        upgrade_to_head(db_engine)

        assert seen == [stored]

    def test_does_nothing_the_second_time(
        self, db_engine: Engine, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # `server run` migrates on every start, so the common case is having nothing to do.
        store_suite(db_engine, suite_named("nts"), version=0)
        calls: list[tuple[str, str]] = []
        monkeypatch.setattr(migrations, "STEPS", (adding_machine_column("first", calls),))
        upgrade_to_head(db_engine)

        result = upgrade_to_head(db_engine)

        assert calls == [("nts", "first")]
        assert result.suites_migrated == ()
        assert not result.applied

    def test_a_failing_suite_is_left_as_it_was_and_earlier_ones_stay_migrated(
        self, db_engine: Engine, migrated_database_url: str, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        store_suite(db_engine, suite_named("a"), version=0)
        store_suite(db_engine, suite_named("b"), version=0)

        def failing_on_b(op: Operations, suite: SuiteSchema) -> None:
            op.add_column("machine", sa.Column("added", sa.Text()), schema=suite.name)
            if suite.name == "b":
                raise RuntimeError("the step failed")

        monkeypatch.setattr(migrations, "STEPS", (failing_on_b,))

        with pytest.raises(RuntimeError, match="the step failed"):
            upgrade_to_head(db_engine)

        # Suites are migrated in name order, each in a transaction of its own.
        assert version_of(db_engine, "a") == 1
        assert "added" in column_names(db_engine, "a", "machine")
        assert version_of(db_engine, "b") == 0
        assert "added" not in column_names(db_engine, "b", "machine")
        # The step failed partway through a suite's transaction. That is the case the lock has to
        # survive, since it is held across transactions.
        assert migration_lock_is_free(migrated_database_url)

    def test_refuses_a_suite_a_newer_build_migrated_before_migrating_any(
        self, db_engine: Engine, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        store_suite(db_engine, suite_named("a"), version=0)
        store_suite(db_engine, suite_named("b"), version=2)
        calls: list[tuple[str, str]] = []
        monkeypatch.setattr(migrations, "STEPS", (adding_machine_column("first", calls),))

        with pytest.raises(MigrationError, match="'b' is at migration version 2"):
            upgrade_to_head(db_engine)

        assert calls == []
        assert version_of(db_engine, "a") == 0

    def test_refuses_a_suite_whose_stored_schema_is_invalid_before_migrating_any(
        self, db_engine: Engine, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # "a" sorts first, so it would already be migrated if the check were made one suite at a
        # time.
        store_suite(db_engine, suite_named("a"), version=0)
        with db_engine.begin() as connection:
            connection.execute(
                insert(schema).values(
                    name="bad", schema_json='{"name": "bad", "nonsense": 1}', migration_version=0
                )
            )
        calls: list[tuple[str, str]] = []
        monkeypatch.setattr(migrations, "STEPS", (adding_machine_column("first", calls),))

        with pytest.raises(MigrationError, match=r"'bad'.*stored schema is invalid"):
            upgrade_to_head(db_engine)

        assert calls == []
        assert version_of(db_engine, "a") == 0

    def test_releases_the_lock_when_it_fails(
        self, db_engine: Engine, migrated_database_url: str
    ) -> None:
        # The lock is held across transactions. A failure in one of them must not leave it held on
        # the pooled connection, where it would block every later migration until a restart. A
        # suite a newer build migrated is what makes it fail.
        store_suite(db_engine, suite_named("nts"), version=migrations.head() + 1)

        with pytest.raises(MigrationError):
            upgrade_to_head(db_engine)

        assert migration_lock_is_free(migrated_database_url)

    def test_a_suite_is_created_at_the_latest_version(
        self,
        db_engine: Engine,
        monkeypatch: pytest.MonkeyPatch,
        make_api_suite: Callable[[dict[str, Any]], SuiteTables],
    ) -> None:
        # Its tables come from `suites/tables.py`, which already has the latest structure, so
        # running any step on them would apply that step twice.
        calls: list[tuple[str, str]] = []
        monkeypatch.setattr(
            migrations,
            "STEPS",
            (adding_machine_column("first", calls), adding_machine_column("second", calls)),
        )

        make_api_suite({"name": "nts"})

        assert version_of(db_engine, "nts") == 2
        assert upgrade_to_head(db_engine).suites_migrated == ()
        assert calls == []


class TestSnapshots:
    """The structure of the reference suite at every version (see `migration_snapshots.py`)."""

    def test_every_version_has_a_snapshot(self) -> None:
        assert snapshot_versions() == list(range(migrations.head() + 1)), (
            "every version needs exactly one snapshot; see tests/migration_snapshots.py"
        )

    def test_the_latest_snapshot_is_what_the_code_creates(self, db_engine: Engine) -> None:
        """Fails when `suites/tables.py` changes without a new step.

        If it fails, `suites/tables.py` no longer matches the latest snapshot. Existing suites still
        have the snapshot's structure, so they need a step in `suites/migrations.py` that migrates
        them to the new one, and the new version needs its own snapshot. Rewriting the existing
        snapshot instead would leave every existing suite unmigrated.
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
        # D6: once migrated, a suite has the same structure as a new suite from the same build.
        with db_engine.begin() as connection:
            replay_reference(connection, version)
        upgrade_to_head(db_engine)
        migrated = structure_of(db_engine, "reference")

        assert migrated == fresh_structure(db_engine)

    def test_a_step_brings_a_suite_forward_to_what_the_code_creates(
        self, db_engine: Engine, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """The comparison above, tested end to end on a real change from this codebase's history.

        `regression.created_at` and its index were added to `suites/tables.py` after suites already
        existed. If any had been deployed, they would have needed this step. It also shows that the
        comparison can tell an old suite from a new one.
        """
        store_suite(db_engine, reference_schema(), version=0)
        with db_engine.begin() as connection:
            connection.execute(text("ALTER TABLE reference.regression DROP COLUMN created_at"))
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

        monkeypatch.setattr(migrations, "STEPS", (add_regression_created_at,))
        upgrade_to_head(db_engine)
        migrated = structure_of(db_engine, "reference")

        fresh = fresh_structure(db_engine)
        assert old != fresh
        assert migrated == fresh


class TestSteps:
    """What the real steps do to data, which the snapshots do not cover."""

    def test_measured_at_is_backfilled_with_each_runs_submitted_at(self, db_engine: Engine) -> None:
        # Version 3 (D5): existing runs say nothing about when they were measured, so they get
        # their own `submitted_at`. Several distinct values, so a constant would not pass.
        submitted = [datetime(2026, month, 1, 12, 0, tzinfo=UTC) for month in (1, 2, 3)]
        with db_engine.begin() as connection:
            replay_reference(connection, 2)
            seed_runs(connection, [{"submitted_at": moment} for moment in submitted])

        upgrade_to_head(db_engine)

        with db_engine.connect() as connection:
            measured = connection.scalars(
                text("SELECT measured_at FROM reference.run ORDER BY submitted_at")
            ).all()
        assert measured == submitted

    def test_run_summaries_are_pivoted_into_one_row_per_run_and_metric(
        self, db_engine: Engine
    ) -> None:
        # Version 4 (D5): every stored geomean lands in its aggregation's column, and an
        # aggregation that had no row is null. Two runs and two metrics, so a pivot that mixed up
        # its groups would not pass. Any positive aggregate implies a positive max, so every pair
        # has a max; the median and max alone are positive for samples like [-10, 1, 2].
        old = {
            (1, "execution_time"): {"median": 2.0, "mean": 2.5, "min": 1.0, "max": 4.0},
            (1, "code_size"): {"median": 1.0, "max": 2.0},
            (2, "execution_time"): {"median": 3.0, "mean": 3.0, "min": 3.0, "max": 3.0},
        }
        with db_engine.begin() as connection:
            replay_reference(connection, 3)
            seed_runs(connection, [{"id": 1}, {"id": 2}])
            connection.execute(
                text("INSERT INTO reference.metric (name) VALUES ('execution_time'), ('code_size')")
            )
            connection.execute(
                text(
                    "INSERT INTO reference.run_summary (run_id, metric_id, sample_agg, geomean) "
                    "SELECT :run, id, :aggregation, :geomean FROM reference.metric "
                    "WHERE name = :metric"
                ),
                [
                    {"run": run, "metric": metric, "aggregation": aggregation, "geomean": value}
                    for (run, metric), geomeans in old.items()
                    for aggregation, value in geomeans.items()
                ],
            )

        upgrade_to_head(db_engine)

        with db_engine.connect() as connection:
            rows = connection.execute(
                text(
                    "SELECT run_id, name, geomean_median, geomean_mean, geomean_min, geomean_max "
                    "FROM reference.run_summary JOIN reference.metric ON metric.id = metric_id"
                )
            ).all()
        assert {(run, metric): tuple(geomeans) for run, metric, *geomeans in rows} == {
            (run, metric): tuple(geomeans.get(name) for name in ("median", "mean", "min", "max"))
            for (run, metric), geomeans in old.items()
        }

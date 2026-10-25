"""Bringing a database up to the structure the code expects (D6)."""

from __future__ import annotations

import copy
import json
import threading
from typing import Any

import pytest
from alembic import command
from alembic.operations import Operations
from sqlalchemy import Engine, create_engine, inspect, text
from sqlalchemy.exc import IntegrityError

from conftest import store_suite
from introspection import column_names, schema_version_of
from lnt_v5.migrate import (
    MIGRATION_LOCK_KEY,
    MigrationError,
    alembic_config,
    current_revision,
    head_revision,
    upgrade_to_head,
)
from lnt_v5.suites import migrations
from lnt_v5.suites import tables as suite_tables
from lnt_v5.suites.schema import SuiteSchema
from lnt_v5.suites.store import normalized_json
from lnt_v5.tables import SCHEMA_VERSION_ID, metadata


def assert_no_pending_revision(engine: Engine) -> None:
    """Fail unless autogenerate would put nothing in a new revision against this database.

    Driven through `command.check`, which runs the project's own `env.py`, rather than by
    assembling a MigrationContext here. That configuration is the thing under test -- `compare_type`
    and, above all, the *absence* of `include_schemas` (D6) -- so a context built in the test would
    only compare against a copy of it and would pass whatever env.py actually said.

    Raises rather than returning a list, because Alembic's own error enumerates the operations it
    wanted to emit, which is exactly what a failure here needs to report.
    """
    with engine.connect() as connection:
        config = alembic_config()
        config.attributes["connection"] = connection
        command.check(config)


def upgrade_by_hand(engine: Engine, revision: str) -> None:
    """Migrate the global tables to `revision`, and no further."""
    with engine.begin() as connection:
        config = alembic_config()
        config.attributes["connection"] = connection
        command.upgrade(config, revision)


def downgrade_by_hand(engine: Engine, revision: str) -> None:
    """Migrate the global tables back to `revision`."""
    with engine.begin() as connection:
        config = alembic_config()
        config.attributes["connection"] = connection
        command.downgrade(config, revision)


class TestUpgrade:
    def test_creates_every_table_defined_in_code(self, empty_engine: Engine) -> None:
        upgrade_to_head(empty_engine)

        assert set(metadata.tables) <= set(inspect(empty_engine).get_table_names())

    def test_seeds_exactly_one_schema_version_row(self, empty_engine: Engine) -> None:
        upgrade_to_head(empty_engine)

        with empty_engine.connect() as connection:
            rows = connection.execute(text("SELECT id, version FROM schema_version")).all()

        # D5 lets every reader address this row directly, which is only safe because D6 has it
        # exist from the moment the database does.
        assert [tuple(row) for row in rows] == [(SCHEMA_VERSION_ID, 0)]

    def test_reports_the_revision_it_moved_to(self, empty_engine: Engine) -> None:
        result = upgrade_to_head(empty_engine)

        assert result.before is None
        assert result.after == head_revision()
        assert result.applied

    def test_does_nothing_the_second_time(self, empty_engine: Engine) -> None:
        # `server run` migrates on every start, so the common case is having nothing to do.
        upgrade_to_head(empty_engine)

        result = upgrade_to_head(empty_engine)

        assert not result.applied
        assert result.before == result.after == head_revision()

    def test_leaves_the_schema_and_the_code_in_agreement(self, empty_engine: Engine) -> None:
        # The one that catches a column added to tables.py with no matching revision, which
        # would otherwise only surface as a confusing failure in production.
        upgrade_to_head(empty_engine)

        assert_no_pending_revision(empty_engine)

    def test_would_not_propose_dropping_a_per_suite_table(self, empty_engine: Engine) -> None:
        """Autogenerate must never touch a suite's namespace (D6).

        Per-suite tables are defined by data, so nothing written in advance describes them; seen by
        autogenerate they would be reflected, matched against nothing, and proposed for deletion --
        every suite's data, dropped by a migration nobody meant to write. Alembic confines itself to
        the default namespace unless asked otherwise, so this asserts the property rather than any
        mechanism of ours -- and because it runs through env.py, switching that default on there
        fails here.

        Built through the real table builder rather than from stub tables, so the namespace carries
        everything a suite actually has -- dynamic columns, indexes, foreign keys, check constraints
        -- which is the shape autogenerate would have to ignore.
        """
        upgrade_to_head(empty_engine)
        suite = SuiteSchema.model_validate(
            {
                "name": "nts",
                "metrics": [{"name": "execution_time", "type": "real"}],
                "commit_fields": [{"name": "git_sha", "type": "text", "searchable": True}],
                "machine_fields": [{"name": "hardware", "type": "text"}],
            }
        )
        with empty_engine.begin() as connection:
            suite_tables.create(connection, suite)

        assert_no_pending_revision(empty_engine)

    def test_refuses_a_database_a_newer_build_migrated(self, empty_engine: Engine) -> None:
        # D6: never backwards. A revision this build doesn't know means a newer build has migrated
        # the database, so this build's code doesn't match the tables.
        upgrade_to_head(empty_engine)
        with empty_engine.begin() as connection:
            connection.execute(text("UPDATE alembic_version SET version_num = 'from_the_future'"))

        with pytest.raises(MigrationError, match="from_the_future"):
            upgrade_to_head(empty_engine)

    def test_records_existing_suites_at_the_first_migration_version(
        self, empty_engine: Engine
    ) -> None:
        """0002 adds `schema.migration_version`, and sets it to 0 for every existing suite.

        It then drops the default it used for that, so that creating a suite has to give the version
        explicitly. A suite created with the latest structure but recorded at 0 would later have
        every step applied again to tables that already have them.
        """
        upgrade_by_hand(empty_engine, "0001")
        with empty_engine.begin() as connection:
            connection.execute(text("INSERT INTO schema (name, schema_json) VALUES ('nts', '{}')"))
        # The global tables only: the suite above is a placeholder, with no tables to migrate.
        upgrade_by_hand(empty_engine, "0002")

        with empty_engine.connect() as connection:
            assert (
                connection.execute(
                    text("SELECT migration_version FROM schema WHERE name = 'nts'")
                ).scalar_one()
                == 0
            )
            with pytest.raises(IntegrityError):
                connection.execute(
                    text("INSERT INTO schema (name, schema_json) VALUES ('other', '{}')")
                )

    def test_downgrading_undoes_it(self, empty_engine: Engine) -> None:
        upgrade_to_head(empty_engine)

        with empty_engine.begin() as connection:
            # The server's own configuration, so a downgrade cannot be tested against a
            # differently-configured Alembic than the one that applied the upgrade.
            config = alembic_config()
            config.attributes["connection"] = connection
            command.downgrade(config, "base")

        with empty_engine.connect() as connection:
            assert current_revision(connection) is None
        assert not set(metadata.tables) & set(inspect(empty_engine).get_table_names())


def store_schema_json(engine: Engine, rows: dict[str, str]) -> None:
    """Store schema rows as they are, recorded at the latest suite migration version.

    At that version, the suite pass neither migrates the suites' tables, which these rows don't
    have, nor parses their schemas: only the global revisions read them.
    """
    with engine.begin() as connection:
        for name, schema_json in rows.items():
            connection.execute(
                text(
                    "INSERT INTO schema (name, schema_json, migration_version) "
                    "VALUES (:name, :schema_json, :version)"
                ),
                {"name": name, "schema_json": schema_json, "version": migrations.head()},
            )


def stored_schema_json(engine: Engine) -> dict[str, str]:
    with engine.connect() as connection:
        rows = connection.execute(text("SELECT name, schema_json FROM schema")).all()
    return {row.name: row.schema_json for row in rows}


def compact(document: Any) -> str:
    """`document` as the server writes it: compact, with non-ASCII characters unescaped."""
    return json.dumps(document, ensure_ascii=False, separators=(",", ":"))


# A schema stored by an earlier build, which accepted empty labels and labels holding a NUL. Stored
# as the standard library writes it rather than in the server's own form, so that a rewrite shows.
_DIRTY: dict[str, Any] = {
    "name": "dirty",
    "metrics": [
        {
            "name": "compile_time",
            "type": "real",
            "display_name": "",
            "unit": "sec\x00onds",
            "unit_abbrev": "\u00b5s",
            "bigger_is_better": False,
        }
    ],
    "commit_fields": [
        {"name": "sha", "type": "text", "display_name": "", "searchable": False, "display": False}
    ],
    "machine_fields": [
        {"name": "os", "type": "text", "display_name": "Système", "searchable": False},
        {"name": "cpu", "type": "text", "display_name": " ", "searchable": False},
    ],
}

_CLEAN = SuiteSchema.model_validate(
    {"name": "clean", "metrics": [{"name": "t", "type": "real", "display_name": "Time"}]}
)


class TestSchemaLabels:
    """0003 rewrites the labels D4 no longer accepts, empty or holding a NUL, to null."""

    def test_rewrites_them_and_nothing_else(self, empty_engine: Engine) -> None:
        upgrade_by_hand(empty_engine, "0002")
        store_schema_json(empty_engine, {"dirty": json.dumps(_DIRTY)})

        upgrade_by_hand(empty_engine, "0003")

        expected = copy.deepcopy(_DIRTY)
        expected["metrics"][0].update(display_name=None, unit=None)
        expected["commit_fields"][0]["display_name"] = None
        # Only what D4 rejects: a label made only of spaces is a label like any other. Compact,
        # with non-ASCII characters unescaped, like what the server writes.
        stored = stored_schema_json(empty_engine)["dirty"]
        assert stored == compact(expected)
        SuiteSchema.model_validate_json(stored)

    def test_bumps_the_schema_version_once_and_leaves_other_rows_alone(
        self, empty_engine: Engine
    ) -> None:
        upgrade_by_hand(empty_engine, "0002")
        second = {**_DIRTY, "name": "second"}
        clean = normalized_json(_CLEAN)
        store_schema_json(
            empty_engine,
            {"dirty": json.dumps(_DIRTY), "second": json.dumps(second), "clean": clean},
        )

        upgrade_by_hand(empty_engine, "0003")

        # D2: like any other change to a stored schema, however many rows it rewrites.
        assert schema_version_of(empty_engine) == 1
        assert stored_schema_json(empty_engine)["clean"] == clean

    def test_leaves_a_row_it_cannot_make_sense_of_untouched(self, empty_engine: Engine) -> None:
        rows = {
            "clean": normalized_json(_CLEAN),
            "not_json": "{",
            "not_an_object": "[]",
            "no_lists": '{"name": "no_lists"}',
            "not_a_list": '{"name": "not_a_list", "metrics": {"display_name": ""}}',
            "not_an_entry": '{"name": "not_an_entry", "metrics": [""]}',
            "not_a_string": '{"name": "not_a_string", "metrics": [{"name": "m", "unit": 5}]}',
        }
        upgrade_by_hand(empty_engine, "0002")
        store_schema_json(empty_engine, rows)

        upgrade_by_hand(empty_engine, "0003")

        assert stored_schema_json(empty_engine) == rows
        assert schema_version_of(empty_engine) == 0

    def test_runs_before_the_suites_are_migrated(
        self, empty_engine: Engine, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """The suite pass parses the schema of every suite it migrates (D6).

        An earlier label would make it refuse the whole database, unless the global revisions
        have already rewritten it.
        """
        seen: list[str | None] = []

        def step(op: Operations, suite: SuiteSchema) -> None:
            seen.append(suite.metrics[0].display_name)

        monkeypatch.setattr(migrations, "STEPS", (step,))
        upgrade_by_hand(empty_engine, "0002")
        store_suite(empty_engine, _CLEAN, version=0)
        with empty_engine.begin() as connection:
            stale = _CLEAN.model_dump(mode="json")
            stale["metrics"][0]["display_name"] = ""
            connection.execute(
                text("UPDATE schema SET schema_json = :schema_json WHERE name = 'clean'"),
                {"schema_json": json.dumps(stale)},
            )

        result = upgrade_to_head(empty_engine)

        assert result.suites_migrated == ("clean",)
        assert seen == [None]


def metric_0003(name: str, type: str) -> dict[str, Any]:
    """A metric as builds up to 0003 stored it, in the server's key order, with no `dashboard`."""
    return {
        "name": name,
        "type": type,
        "display_name": None,
        "unit": None,
        "unit_abbrev": None,
        "bigger_is_better": False,
    }


# A schema stored by a build that showed a card for every numeric metric on the Dashboard, with a
# metric of each type.
_BEFORE_DASHBOARD: dict[str, Any] = {
    "name": "before",
    "metrics": [
        metric_0003("execution_time", "real"),
        metric_0003("code_size", "integer"),
        metric_0003("hash", "text"),
        metric_0003("finished_at", "datetime"),
    ],
    "commit_fields": [
        {"name": "sha", "type": "text", "display_name": "Shà", "searchable": True, "display": True}
    ],
    "machine_fields": [{"name": "os", "type": "text", "display_name": None, "searchable": False}],
}


class TestMetricDashboard:
    """0004 sets `dashboard` on every stored metric, so the Dashboard keeps showing its cards."""

    def test_sets_it_on_every_metric_and_nothing_else(self, empty_engine: Engine) -> None:
        upgrade_by_hand(empty_engine, "0003")
        store_schema_json(empty_engine, {"before": compact(_BEFORE_DASHBOARD)})

        upgrade_to_head(empty_engine)

        expected = copy.deepcopy(_BEFORE_DASHBOARD)
        for metric, shown in zip(expected["metrics"], [True, True, False, False], strict=True):
            metric["dashboard"] = shown
        stored = stored_schema_json(empty_engine)["before"]
        assert stored == compact(expected)
        # Byte for byte what the server itself writes for that schema.
        assert stored == normalized_json(SuiteSchema.model_validate_json(stored))

    def test_bumps_the_schema_version_once_and_leaves_set_keys_alone(
        self, empty_engine: Engine
    ) -> None:
        second = {**_BEFORE_DASHBOARD, "name": "second"}
        # Never overwritten, even where it is not what this revision would have set.
        already = compact(
            {"name": "already", "metrics": [{**metric_0003("t", "real"), "dashboard": False}]}
        )
        upgrade_by_hand(empty_engine, "0003")
        store_schema_json(
            empty_engine,
            {
                "before": compact(_BEFORE_DASHBOARD),
                "second": compact(second),
                "already": already,
                "no_metrics": compact({"name": "no_metrics", "metrics": []}),
            },
        )

        upgrade_to_head(empty_engine)

        # D2: like any other change to a stored schema, however many rows it rewrites.
        assert schema_version_of(empty_engine) == 1
        stored = stored_schema_json(empty_engine)
        assert stored["already"] == already
        assert stored["no_metrics"] == compact({"name": "no_metrics", "metrics": []})

    def test_leaves_a_row_it_cannot_make_sense_of_untouched(self, empty_engine: Engine) -> None:
        rows = {
            "not_json": "{",
            "not_an_object": "[]",
            "no_lists": '{"name": "no_lists"}',
            "not_a_list": '{"name": "not_a_list", "metrics": {"type": "real"}}',
            "not_an_entry": '{"name": "not_an_entry", "metrics": ["real"]}',
            "no_type": '{"name": "no_type", "metrics": [{"name": "m"}]}',
            "unknown_type": '{"name": "unknown_type", "metrics": [{"name": "m", "type": "float"}]}',
            "not_a_type": '{"name": "not_a_type", "metrics": [{"name": "m", "type": ["real"]}]}',
        }
        upgrade_by_hand(empty_engine, "0003")
        store_schema_json(empty_engine, rows)

        upgrade_to_head(empty_engine)

        assert stored_schema_json(empty_engine) == rows
        assert schema_version_of(empty_engine) == 0

    def test_sets_it_on_each_metric_it_can_make_sense_of(self, empty_engine: Engine) -> None:
        # Entry by entry, as 0003 does: a malformed metric does not keep the others from being
        # rewritten, and is itself left as it is.
        metrics: list[Any] = [
            metric_0003("t", "real"),
            {"name": "m"},
            {"name": "f", "type": "float"},
            "x",
        ]
        upgrade_by_hand(empty_engine, "0003")
        store_schema_json(empty_engine, {"mixed": compact({"name": "mixed", "metrics": metrics})})

        upgrade_to_head(empty_engine)

        expected = [{**metrics[0], "dashboard": True}, *metrics[1:]]
        assert stored_schema_json(empty_engine)["mixed"] == compact(
            {"name": "mixed", "metrics": expected}
        )
        assert schema_version_of(empty_engine) == 1

    def test_downgrading_removes_it_and_nothing_else(self, empty_engine: Engine) -> None:
        upgrade_by_hand(empty_engine, "0003")
        store_schema_json(empty_engine, {"before": compact(_BEFORE_DASHBOARD)})
        upgrade_to_head(empty_engine)

        downgrade_by_hand(empty_engine, "0003")

        assert stored_schema_json(empty_engine) == {"before": compact(_BEFORE_DASHBOARD)}
        # Once on the way up, and once on the way down.
        assert schema_version_of(empty_engine) == 2


def insert_key_row(
    engine: Engine, prefix: str, scope: str, suites: list[str] | None = None
) -> None:
    columns = "prefix, key_hash, name, scope" + (", suites" if suites is not None else "")
    values = ":prefix, :hash, 'k', :scope" + (", :suites" if suites is not None else "")
    with engine.begin() as connection:
        connection.execute(
            text(f"INSERT INTO api_key ({columns}) VALUES ({values})"),
            {"prefix": prefix, "hash": prefix * 8, "scope": scope, "suites": suites},
        )


class TestApiKeySuites:
    """0005 adds `api_key.suites`, which restricts a key to some suites (I5)."""

    def test_leaves_every_existing_key_valid_across_the_instance(
        self, empty_engine: Engine
    ) -> None:
        upgrade_by_hand(empty_engine, "0004")
        insert_key_row(empty_engine, "aaaaaaaa", "submit")

        upgrade_by_hand(empty_engine, "0005")

        with empty_engine.connect() as connection:
            assert connection.execute(text("SELECT suites FROM api_key")).scalar_one() is None

    def test_downgrading_revokes_restricted_keys_rather_than_widening_them(
        self, empty_engine: Engine
    ) -> None:
        # An earlier build would read a restricted key as valid in every suite.
        upgrade_by_hand(empty_engine, "0005")
        insert_key_row(empty_engine, "aaaaaaaa", "submit", ["nts"])
        insert_key_row(empty_engine, "bbbbbbbb", "submit")

        downgrade_by_hand(empty_engine, "0004")

        with empty_engine.connect() as connection:
            rows = connection.execute(text("SELECT prefix, is_active FROM api_key")).all()
        assert {row.prefix: row.is_active for row in rows} == {
            "aaaaaaaa": False,
            "bbbbbbbb": True,
        }
        assert "suites" not in column_names(empty_engine, "public", "api_key")


class TestConcurrentUpgrade:
    def test_waits_for_whoever_holds_the_migration_lock(
        self, empty_engine: Engine, empty_database_url: str
    ) -> None:
        """Two processes migrating the same database must not run the same DDL at once (D6).

        This happens, for example, when two servers start against the same database, or when an
        operator runs `server migrate` while a server starts. Rather than racing two migrations and
        hoping the timing works out, this test holds the lock itself and checks that a migration
        doesn't start until the lock is released.
        """
        finished = threading.Event()
        failure: list[BaseException] = []

        def migrate_in_background() -> None:
            try:
                upgrade_to_head(empty_engine)
            except BaseException as error:
                failure.append(error)
            finally:
                finished.set()

        # From the URL, not from `str(engine.url)`, which renders the password as `***`.
        blocker = create_engine(empty_database_url)
        try:
            with blocker.connect() as held:
                lock = held.execution_options(isolation_level="AUTOCOMMIT")
                lock.execute(text("SELECT pg_advisory_lock(:key)"), {"key": MIGRATION_LOCK_KEY})

                thread = threading.Thread(target=migrate_in_background)
                thread.start()
                try:
                    assert not finished.wait(timeout=1.0), (
                        "the migration ran while another process held the lock"
                    )
                finally:
                    lock.execute(
                        text("SELECT pg_advisory_unlock(:key)"), {"key": MIGRATION_LOCK_KEY}
                    )

                assert finished.wait(timeout=60), "the migration never completed"
                thread.join(timeout=60)
        finally:
            blocker.dispose()

        assert not failure, f"the migration failed once unblocked: {failure}"
        with empty_engine.connect() as connection:
            assert current_revision(connection) == head_revision()


def test_a_fresh_database_reports_no_revision(empty_engine: Engine) -> None:
    with empty_engine.connect() as connection:
        assert current_revision(connection) is None


def test_the_build_carries_a_head_revision() -> None:
    # Guards against the migrations directory going missing from a wheel or an image: the
    # packaging is easy to get wrong and the symptom would otherwise be a server that starts and
    # then fails every request.
    assert head_revision() is not None


def test_a_connection_is_left_usable_afterwards(empty_engine: Engine) -> None:
    # The advisory lock is held on one connection for all the transactions and released at the
    # end. A leaked connection or lock would only show up much later, as pool exhaustion or a hang.
    upgrade_to_head(empty_engine)

    with empty_engine.connect() as connection:
        assert connection.execute(text("SELECT 1")).scalar_one() == 1

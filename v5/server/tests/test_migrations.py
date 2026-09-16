"""Bringing a database up to the structure the code expects (D14)."""

from __future__ import annotations

import threading

from alembic import command
from sqlalchemy import Engine, create_engine, inspect, text

from lnt_v5.migrate import (
    MIGRATION_LOCK_KEY,
    alembic_config,
    current_revision,
    head_revision,
    upgrade_to_head,
)
from lnt_v5.suites import tables as suite_tables
from lnt_v5.suites.schema import SuiteSchema
from lnt_v5.tables import SCHEMA_VERSION_ID, metadata


def assert_no_pending_revision(engine: Engine) -> None:
    """Fail unless autogenerate would put nothing in a new revision against this database.

    Driven through `command.check`, which runs the project's own `env.py`, rather than by
    assembling a MigrationContext here. That configuration is the thing under test -- `compare_type`
    and, above all, the *absence* of `include_schemas` (D14) -- so a context built in the test would
    only compare against a copy of it and would pass whatever env.py actually said.

    Raises rather than returning a list, because Alembic's own error enumerates the operations it
    wanted to emit, which is exactly what a failure here needs to report.
    """
    with engine.connect() as connection:
        config = alembic_config()
        config.attributes["connection"] = connection
        command.check(config)


class TestUpgrade:
    def test_creates_every_table_defined_in_code(self, empty_engine: Engine) -> None:
        upgrade_to_head(empty_engine)

        assert set(metadata.tables) <= set(inspect(empty_engine).get_table_names())

    def test_seeds_exactly_one_schema_version_row(self, empty_engine: Engine) -> None:
        upgrade_to_head(empty_engine)

        with empty_engine.connect() as connection:
            rows = connection.execute(text("SELECT id, version FROM schema_version")).all()

        # D5 lets every reader address this row directly, which is only safe because it exists
        # from the moment the database does.
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
        """Autogenerate must never touch a suite's namespace (D14).

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
        suite = suite_tables.build(
            SuiteSchema.model_validate(
                {
                    "name": "nts",
                    "metrics": [{"name": "execution_time", "type": "real"}],
                    "commit_fields": [{"name": "git_sha", "type": "text", "searchable": True}],
                    "machine_fields": [{"name": "hardware", "type": "text"}],
                }
            )
        )
        with empty_engine.begin() as connection:
            suite_tables.create(connection, suite)

        assert_no_pending_revision(empty_engine)

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


class TestConcurrentUpgrade:
    def test_waits_for_whoever_holds_the_migration_lock(
        self, empty_engine: Engine, empty_database_url: str
    ) -> None:
        """Two servers starting at once must not run the same DDL concurrently (D14).

        Not hypothetical: a deploy replaces the EC2 instance, so the outgoing and incoming ones
        overlap. Rather than racing two migrations and hoping the timing lines up, this holds the
        lock explicitly and checks that a migration will not start until it is released.
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
    # The advisory lock is taken inside the migration's own transaction and released with it;
    # leaking a connection or a lock would show up much later as pool exhaustion or a hang.
    upgrade_to_head(empty_engine)

    with empty_engine.connect() as connection:
        assert connection.execute(text("SELECT 1")).scalar_one() == 1

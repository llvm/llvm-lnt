"""A suite's own tables (D5), as PostgreSQL actually ends up holding them.

Introspection rather than assertions about the SQLAlchemy objects: the objects are what this code
builds, and what matters is what reached the database. That is also the only way to check the two
things D5 leaves implicit -- that a composed constraint name survives the 63-byte identifier limit,
and that the cascades behave the way the delete endpoints depend on.
"""

from __future__ import annotations

from collections.abc import Callable, Iterator
from typing import Any

import pytest
from sqlalchemy import Connection, Engine, Inspector, Table, insert, inspect, select, text
from sqlalchemy.engine.interfaces import ReflectedColumn
from sqlalchemy.exc import IntegrityError, ProgrammingError

from lnt_v5.suites import tables as suite_tables
from lnt_v5.suites.schema import SuiteSchema
from lnt_v5.suites.tables import RegressionState, SuiteTables
from lnt_v5.tables import metadata as global_metadata

# The eight tables D5 gives every suite.
SUITE_TABLES = frozenset(
    {
        "commit",
        "machine",
        "run",
        "test",
        "sample",
        "regression",
        "regression_indicator",
        "profile",
    }
)

# A schema exercising all three lists and every attribute type (D3).
FULL: dict[str, Any] = {
    "metrics": [
        {"name": "execution_time", "type": "real"},
        {"name": "compile_status", "type": "integer"},
        {"name": "build_id", "type": "text"},
        {"name": "measured_at", "type": "datetime"},
    ],
    "commit_fields": [
        {"name": "git_sha", "type": "text", "searchable": True, "display": True},
        {"name": "commit_timestamp", "type": "datetime"},
    ],
    "machine_fields": [
        {"name": "hardware", "type": "text", "searchable": True},
        {"name": "core_count", "type": "integer"},
    ],
}


@pytest.fixture
def make_suite(db_engine: Engine) -> Iterator[Callable[..., SuiteTables]]:
    """Create a suite in the test database, and drop its namespace afterwards.

    Teardown issues its own SQL rather than calling `drop`, so that a broken `drop` fails the test
    that covers it instead of leaking a namespace into every test that follows.
    """
    created: list[str] = []

    def make(name: str = "nts", **overrides: Any) -> SuiteTables:
        schema = SuiteSchema.model_validate({"name": name} | overrides)
        built = suite_tables.build(schema)
        with db_engine.begin() as connection:
            suite_tables.create(connection, built)
        created.append(name)
        return built

    yield make

    for name in created:
        with db_engine.begin() as connection:
            connection.execute(text(f'DROP SCHEMA IF EXISTS "{name}" CASCADE'))


def columns_of(inspector: Inspector, suite: str, table: str) -> dict[str, ReflectedColumn]:
    return {column["name"]: column for column in inspector.get_columns(table, schema=suite)}


def sql_type_of(engine: Engine, suite: str, table: str, column: str) -> str:
    """The column type PostgreSQL reports, spelled the way D3's table spells it.

    Read from `information_schema` rather than from SQLAlchemy's reflection, which renders a
    `timestamptz` as `TIMESTAMP` with a separate `timezone` flag and so cannot be compared against
    D3 directly.
    """
    with engine.connect() as connection:
        return str(
            connection.execute(
                text(
                    "SELECT data_type FROM information_schema.columns "
                    "WHERE table_schema = :suite AND table_name = :table AND column_name = :column"
                ),
                {"suite": suite, "table": table, "column": column},
            ).scalar_one()
        ).upper()


def names_in(inspector: Inspector, suite: str, table: str) -> set[str]:
    """Every constraint and index name PostgreSQL stored for a table."""
    found = {index["name"] for index in inspector.get_indexes(table, schema=suite)}
    found |= {u["name"] for u in inspector.get_unique_constraints(table, schema=suite)}
    found |= {f["name"] for f in inspector.get_foreign_keys(table, schema=suite)}
    found |= {c["name"] for c in inspector.get_check_constraints(table, schema=suite)}
    primary_key = inspector.get_pk_constraint(table, schema=suite)
    found.add(primary_key.get("name"))
    return {str(name) for name in found if name is not None}


def seed(connection: Connection, tables: SuiteTables) -> dict[str, int]:
    """One row in each table, wired together, for the cascade and constraint tests."""
    machine = connection.execute(
        insert(tables.machine).values(name="linux-x86_64").returning(tables.machine.c.id)
    ).scalar_one()
    commit = connection.execute(
        insert(tables.commit).values(commit="abc123", ordinal=1).returning(tables.commit.c.id)
    ).scalar_one()
    test = connection.execute(
        insert(tables.test).values(name="suite/benchmark").returning(tables.test.c.id)
    ).scalar_one()
    run = connection.execute(
        insert(tables.run)
        .values(uuid="11111111-1111-4111-8111-111111111111", machine_id=machine, commit_id=commit)
        .returning(tables.run.c.id)
    ).scalar_one()
    sample = connection.execute(
        insert(tables.sample).values(run_id=run, test_id=test).returning(tables.sample.c.id)
    ).scalar_one()
    profile = connection.execute(
        insert(tables.profile)
        .values(
            uuid="22222222-2222-4222-8222-222222222222",
            run_id=run,
            test_id=test,
            data=b"\x02profile",
        )
        .returning(tables.profile.c.id)
    ).scalar_one()
    regression = connection.execute(
        insert(tables.regression)
        .values(
            uuid="33333333-3333-4333-8333-333333333333",
            state=RegressionState.DETECTED,
            commit_id=commit,
        )
        .returning(tables.regression.c.id)
    ).scalar_one()
    indicator = connection.execute(
        insert(tables.regression_indicator)
        .values(
            uuid="44444444-4444-4444-8444-444444444444",
            regression_id=regression,
            machine_id=machine,
            test_id=test,
            metric="execution_time",
        )
        .returning(tables.regression_indicator.c.id)
    ).scalar_one()
    return {
        "machine": machine,
        "commit": commit,
        "test": test,
        "run": run,
        "sample": sample,
        "profile": profile,
        "regression": regression,
        "indicator": indicator,
    }


def count(connection: Connection, table: Table) -> int:
    return len(connection.execute(select(table.c.id)).all())


class TestCreate:
    def test_puts_every_table_in_a_namespace_named_after_the_suite(
        self, db_engine: Engine, make_suite: Callable[..., SuiteTables]
    ) -> None:
        make_suite("nts")

        inspector = inspect(db_engine)
        assert "nts" in inspector.get_schema_names()
        assert set(inspector.get_table_names(schema="nts")) == SUITE_TABLES

    def test_leaves_the_global_tables_where_they_are(
        self, db_engine: Engine, make_suite: Callable[..., SuiteTables]
    ) -> None:
        # D5 keeps the global tables in the default namespace; creating a suite must not touch
        # them, and must not put a second copy of anything beside them.
        make_suite("nts")

        public = set(inspect(db_engine).get_table_names(schema="public"))
        assert {table.name for table in global_metadata.sorted_tables} <= public
        assert public.isdisjoint(SUITE_TABLES)

    def test_two_suites_coexist_with_schemas_of_their_own(
        self, db_engine: Engine, make_suite: Callable[..., SuiteTables]
    ) -> None:
        make_suite("nts", metrics=[{"name": "execution_time", "type": "real"}])
        make_suite("compile", metrics=[{"name": "size", "type": "integer"}])

        inspector = inspect(db_engine)
        assert "execution_time" in columns_of(inspector, "nts", "sample")
        assert "execution_time" not in columns_of(inspector, "compile", "sample")
        assert "size" in columns_of(inspector, "compile", "sample")

    def test_refuses_to_create_a_suite_that_already_exists(
        self, db_engine: Engine, make_suite: Callable[..., SuiteTables]
    ) -> None:
        # What grounds the 409 from `POST /api/suites`, including when two workers race.
        make_suite("nts")

        with pytest.raises(ProgrammingError):
            make_suite("nts")


class TestDrop:
    def test_removes_the_namespace_and_everything_in_it(
        self, db_engine: Engine, make_suite: Callable[..., SuiteTables]
    ) -> None:
        tables = make_suite("nts", **FULL)
        with db_engine.begin() as connection:
            seed(connection, tables)

        with db_engine.begin() as connection:
            suite_tables.drop(connection, "nts")

        assert "nts" not in inspect(db_engine).get_schema_names()


class TestBuiltInColumns:
    def test_commit_carries_what_d5_specifies(
        self, db_engine: Engine, make_suite: Callable[..., SuiteTables]
    ) -> None:
        make_suite("nts", **FULL)

        columns = columns_of(inspect(db_engine), "nts", "commit")

        assert list(columns) == ["id", "commit", "ordinal", "tag", "git_sha", "commit_timestamp"]
        assert columns["commit"]["nullable"] is False
        # D1: an ordinal is optional, and NULL means unordered.
        assert columns["ordinal"]["nullable"] is True
        assert columns["tag"]["nullable"] is True

    def test_machine_carries_what_d5_specifies(
        self, db_engine: Engine, make_suite: Callable[..., SuiteTables]
    ) -> None:
        make_suite("nts", **FULL)

        columns = columns_of(inspect(db_engine), "nts", "machine")

        assert list(columns) == ["id", "name", "tracked", "hardware", "core_count"]
        assert columns["name"]["nullable"] is False
        assert columns["tracked"]["nullable"] is False

    def test_run_carries_what_d5_specifies(
        self, db_engine: Engine, make_suite: Callable[..., SuiteTables]
    ) -> None:
        make_suite("nts", **FULL)

        columns = columns_of(inspect(db_engine), "nts", "run")

        assert list(columns) == [
            "id",
            "uuid",
            "machine_id",
            "commit_id",
            "submitted_at",
            "run_parameters",
        ]
        # D6: every run has a commit, and the submission cannot supply the timestamp.
        assert columns["commit_id"]["nullable"] is False
        assert columns["submitted_at"]["nullable"] is False

    def test_a_machine_is_tracked_unless_told_otherwise(
        self, db_engine: Engine, make_suite: Callable[..., SuiteTables]
    ) -> None:
        # D6: `tracked` defaults to true when a submission omits it.
        tables = make_suite("nts")

        with db_engine.begin() as connection:
            connection.execute(insert(tables.machine).values(name="m"))
            assert connection.execute(select(tables.machine.c.tracked)).scalar_one() is True

    def test_a_run_without_parameters_stores_an_empty_object(
        self, db_engine: Engine, make_suite: Callable[..., SuiteTables]
    ) -> None:
        # The Run object reports `{}` when the submission supplied none (endpoints.md, Runs).
        tables = make_suite("nts")

        with db_engine.begin() as connection:
            seed(connection, tables)
            assert connection.execute(select(tables.run.c.run_parameters)).scalar_one() == {}

    def test_a_profile_blob_round_trips(
        self, db_engine: Engine, make_suite: Callable[..., SuiteTables]
    ) -> None:
        tables = make_suite("nts")

        with db_engine.begin() as connection:
            seed(connection, tables)
            assert connection.execute(select(tables.profile.c.data)).scalar_one() == b"\x02profile"

    @pytest.mark.parametrize(
        ("table", "column"), [("run", "submitted_at"), ("profile", "created_at")]
    )
    def test_every_timestamp_is_timezone_aware(
        self, db_engine: Engine, make_suite: Callable[..., SuiteTables], table: str, column: str
    ) -> None:
        # D5's convention for every timestamp column in the instance. A naive column would be read
        # back in whatever zone the session happens to be in, and R4 serializes these with a `Z`.
        make_suite("nts")

        assert sql_type_of(db_engine, "nts", table, column) == "TIMESTAMP WITH TIME ZONE"


class TestDynamicColumns:
    @pytest.mark.parametrize(
        ("attribute", "sql_type"),
        [
            # D3's type table, which is the contract a schema author reads.
            ("real", "DOUBLE PRECISION"),
            ("integer", "INTEGER"),
            ("text", "TEXT"),
            ("datetime", "TIMESTAMP WITH TIME ZONE"),
        ],
    )
    def test_each_declared_type_becomes_the_column_d3_names(
        self,
        db_engine: Engine,
        make_suite: Callable[..., SuiteTables],
        attribute: str,
        sql_type: str,
    ) -> None:
        make_suite("nts", metrics=[{"name": "measurement", "type": attribute}])

        assert sql_type_of(db_engine, "nts", "sample", "measurement") == sql_type

    @pytest.mark.parametrize(
        ("list_name", "table"),
        [("metrics", "sample"), ("commit_fields", "commit"), ("machine_fields", "machine")],
    )
    def test_are_always_nullable(
        self,
        db_engine: Engine,
        make_suite: Callable[..., SuiteTables],
        list_name: str,
        table: str,
    ) -> None:
        # D2: adding an entry leaves existing rows with no value for it, and D7 lets a submission
        # send any subset of a record's metadata.
        make_suite("nts", **{list_name: [{"name": "added", "type": "text"}]})

        assert columns_of(inspect(db_engine), "nts", table)["added"]["nullable"] is True

    def test_a_name_that_is_a_reserved_word_works_end_to_end(
        self, db_engine: Engine, make_suite: Callable[..., SuiteTables]
    ) -> None:
        # The name rule admits PostgreSQL's reserved words (see schema.py), so every identifier is
        # quoted. Unquoted, the CREATE TABLE below is a syntax error.
        tables = make_suite(
            "nts",
            metrics=[{"name": "order", "type": "integer"}],
            machine_fields=[{"name": "user", "type": "text"}],
        )

        with db_engine.begin() as connection:
            rows = seed(connection, tables)
            connection.execute(
                tables.sample.update()
                .where(tables.sample.c.id == rows["sample"])
                .values({"order": 7})
            )
            assert connection.execute(select(tables.sample.c["order"])).scalar_one() == 7


class TestNamingConvention:
    def test_every_composed_name_reaches_the_database_intact(
        self, db_engine: Engine, make_suite: Callable[..., SuiteTables]
    ) -> None:
        """The check `tables.py` says per-suite tables owe (D14).

        PostgreSQL truncates an identifier over 63 bytes with a warning rather than an error, so a
        name that overflows is not the name a violation is reported under -- attribution (D13)
        would read a name and silently never match.
        """
        tables = make_suite("nts", **FULL)

        inspector = inspect(db_engine)
        for table in tables.metadata.sorted_tables:
            composed = {
                str(constraint.name)
                for constraint in table.constraints
                if constraint.name is not None
            } | {str(index.name) for index in table.indexes if index.name is not None}
            stored = names_in(inspector, "nts", table.name)
            assert composed <= stored, f"{table.name}: {sorted(composed - stored)} did not survive"

    def test_the_longest_name_is_exactly_at_the_limit(
        self, db_engine: Engine, make_suite: Callable[..., SuiteTables]
    ) -> None:
        # D5's unique constraint on regression_indicator composes to exactly 63 bytes. Spelled out
        # so that a change to the convention or to a column name fails here rather than silently
        # producing a truncated name.
        longest = "uq_regression_indicator_regression_id_machine_id_test_id_metric"
        assert len(longest) == 63

        make_suite("nts")

        assert longest in names_in(inspect(db_engine), "nts", "regression_indicator")

    def test_two_suites_carry_identical_names(
        self, db_engine: Engine, make_suite: Callable[..., SuiteTables]
    ) -> None:
        # What lets D13's violation attribution write a constraint name out rather than compose it
        # per suite: the convention names a constraint after its table and columns, neither of
        # which mentions the suite.
        make_suite("nts", **FULL)
        make_suite("compile", **FULL)

        inspector = inspect(db_engine)
        for table in sorted(SUITE_TABLES):
            assert names_in(inspector, "nts", table) == names_in(inspector, "compile", table)


class TestIndexes:
    def test_tag_is_indexed_only_where_it_is_set(
        self, db_engine: Engine, make_suite: Callable[..., SuiteTables]
    ) -> None:
        # D5 makes this index partial: a tag is applied by hand to a handful of commits, so an
        # index over the nulls would be most of the table for no lookups.
        make_suite("nts")

        definition = inspect(db_engine).get_indexes("commit", schema="nts")
        tag = next(index for index in definition if index["name"] == "ix_commit_tag")

        assert tag["column_names"] == ["tag"]
        assert tag.get("dialect_options", {}).get("postgresql_where") is not None

    def test_sample_is_indexed_in_both_orders(
        self, db_engine: Engine, make_suite: Callable[..., SuiteTables]
    ) -> None:
        # D5 names both deliberately: (run_id, test_id) covers "all samples for a run", and
        # (test_id, run_id) covers the time-series query (D10).
        make_suite("nts")

        indexes = {
            index["name"]: index["column_names"]
            for index in inspect(db_engine).get_indexes("sample", schema="nts")
        }

        assert indexes["ix_sample_run_id_test_id"] == ["run_id", "test_id"]
        assert indexes["ix_sample_test_id_run_id"] == ["test_id", "run_id"]

    def test_run_is_indexed_by_machine_and_submission_time(
        self, db_engine: Engine, make_suite: Callable[..., SuiteTables]
    ) -> None:
        # D5: keeps both `?sort=-submitted_at` and the derived `last_run_at` to a bounded index
        # scan rather than a scan of the run table.
        make_suite("nts")

        indexes = {
            index["name"]: index["column_names"]
            for index in inspect(db_engine).get_indexes("run", schema="nts")
        }

        assert indexes["ix_run_machine_id_submitted_at"] == ["machine_id", "submitted_at"]


class TestUniqueness:
    def test_a_commit_string_names_one_commit(
        self, db_engine: Engine, make_suite: Callable[..., SuiteTables]
    ) -> None:
        tables = make_suite("nts")

        with db_engine.begin() as connection:
            seed(connection, tables)
            with pytest.raises(IntegrityError):
                connection.execute(insert(tables.commit).values(commit="abc123"))

    def test_an_ordinal_is_held_by_one_commit(
        self, db_engine: Engine, make_suite: Callable[..., SuiteTables]
    ) -> None:
        # D11: a regular, non-deferred constraint. A write that would give two commits the same
        # ordinal is rejected, which the API reports as `ordinal_conflict` (R4).
        tables = make_suite("nts")

        with db_engine.begin() as connection:
            seed(connection, tables)
            with pytest.raises(IntegrityError):
                connection.execute(insert(tables.commit).values(commit="def456", ordinal=1))

    def test_many_commits_may_be_unordered(
        self, db_engine: Engine, make_suite: Callable[..., SuiteTables]
    ) -> None:
        # D1's second tier: NULL means unordered, and NULLs do not collide under a unique
        # constraint. Throwaway A/B commits rely on this.
        tables = make_suite("nts")

        with db_engine.begin() as connection:
            connection.execute(insert(tables.commit).values(commit="one"))
            connection.execute(insert(tables.commit).values(commit="two"))

            assert count(connection, tables.commit) == 2

    def test_a_run_uuid_names_one_run(
        self, db_engine: Engine, make_suite: Callable[..., SuiteTables]
    ) -> None:
        # D6: a repeated UUID is a 409, which is why attribution has to tell this constraint from
        # the ordinal one.
        tables = make_suite("nts")

        with db_engine.begin() as connection:
            rows = seed(connection, tables)
            with pytest.raises(IntegrityError):
                connection.execute(
                    insert(tables.run).values(
                        uuid="11111111-1111-4111-8111-111111111111",
                        machine_id=rows["machine"],
                        commit_id=rows["commit"],
                    )
                )

    def test_a_run_and_test_have_at_most_one_profile(
        self, db_engine: Engine, make_suite: Callable[..., SuiteTables]
    ) -> None:
        tables = make_suite("nts")

        with db_engine.begin() as connection:
            rows = seed(connection, tables)
            with pytest.raises(IntegrityError):
                connection.execute(
                    insert(tables.profile).values(
                        uuid="55555555-5555-4555-8555-555555555555",
                        run_id=rows["run"],
                        test_id=rows["test"],
                        data=b"\x02",
                    )
                )

    def test_an_indicator_names_one_machine_test_and_metric_per_regression(
        self, db_engine: Engine, make_suite: Callable[..., SuiteTables]
    ) -> None:
        # What makes a repeated indicator silently ignored rather than a duplicate row
        # (endpoints.md, Regressions).
        tables = make_suite("nts")

        with db_engine.begin() as connection:
            rows = seed(connection, tables)
            with pytest.raises(IntegrityError):
                connection.execute(
                    insert(tables.regression_indicator).values(
                        uuid="66666666-6666-4666-8666-666666666666",
                        regression_id=rows["regression"],
                        machine_id=rows["machine"],
                        test_id=rows["test"],
                        metric="execution_time",
                    )
                )

    def test_many_runs_may_share_a_machine_and_commit(
        self, db_engine: Engine, make_suite: Callable[..., SuiteTables]
    ) -> None:
        # endpoints.md: v5 always creates a new run, and multiple runs per machine+commit are
        # allowed. Nothing may constrain the pair.
        tables = make_suite("nts")

        with db_engine.begin() as connection:
            rows = seed(connection, tables)
            connection.execute(
                insert(tables.run).values(
                    uuid="77777777-7777-4777-8777-777777777777",
                    machine_id=rows["machine"],
                    commit_id=rows["commit"],
                )
            )

            assert count(connection, tables.run) == 2


class TestRegressionState:
    @pytest.mark.parametrize("state", list(RegressionState))
    def test_accepts_every_state_d5_defines(
        self, db_engine: Engine, make_suite: Callable[..., SuiteTables], state: RegressionState
    ) -> None:
        tables = make_suite("nts")

        with db_engine.begin() as connection:
            connection.execute(
                insert(tables.regression).values(
                    uuid=f"00000000-0000-4000-8000-00000000000{state.value}", state=state
                )
            )

    @pytest.mark.parametrize("state", [-1, 5, 99])
    def test_rejects_a_state_outside_that_set(
        self, db_engine: Engine, make_suite: Callable[..., SuiteTables], state: int
    ) -> None:
        # Cheap insurance against a bug writing a regression no `?state=` filter can find.
        tables = make_suite("nts")

        with db_engine.begin() as connection, pytest.raises(IntegrityError):
            connection.execute(
                insert(tables.regression).values(
                    uuid="88888888-8888-4888-8888-888888888888", state=state
                )
            )

    def test_the_stored_values_are_the_ones_d5_tabulates(self) -> None:
        assert [(state.value, state.name.lower()) for state in RegressionState] == [
            (0, "detected"),
            (1, "active"),
            (2, "not_to_be_fixed"),
            (3, "fixed"),
            (4, "false_positive"),
        ]


class TestCascades:
    def test_deleting_a_commit_takes_its_runs_samples_and_profiles(
        self, db_engine: Engine, make_suite: Callable[..., SuiteTables]
    ) -> None:
        # D1 and D5. Commonly used to clean up the unordered commits of a throwaway A/B run.
        tables = make_suite("nts")

        with db_engine.begin() as connection:
            rows = seed(connection, tables)
            # The regression's reference would otherwise refuse the delete; that is the next test.
            connection.execute(tables.regression.update().values(commit_id=None))

            connection.execute(tables.commit.delete().where(tables.commit.c.id == rows["commit"]))

            assert count(connection, tables.run) == 0
            assert count(connection, tables.sample) == 0
            assert count(connection, tables.profile) == 0

    def test_a_commit_a_regression_points_at_cannot_be_deleted(
        self, db_engine: Engine, make_suite: Callable[..., SuiteTables]
    ) -> None:
        # D5, and the source of R4's `in_use` 409.
        tables = make_suite("nts")

        with db_engine.begin() as connection:
            rows = seed(connection, tables)
            with pytest.raises(IntegrityError):
                connection.execute(
                    tables.commit.delete().where(tables.commit.c.id == rows["commit"])
                )

    def test_deleting_a_machine_takes_its_runs_and_indicators(
        self, db_engine: Engine, make_suite: Callable[..., SuiteTables]
    ) -> None:
        tables = make_suite("nts")

        with db_engine.begin() as connection:
            rows = seed(connection, tables)

            connection.execute(
                tables.machine.delete().where(tables.machine.c.id == rows["machine"])
            )

            assert count(connection, tables.run) == 0
            assert count(connection, tables.sample) == 0
            assert count(connection, tables.profile) == 0
            assert count(connection, tables.regression_indicator) == 0

    def test_deleting_a_machine_leaves_the_regression_itself(
        self, db_engine: Engine, make_suite: Callable[..., SuiteTables]
    ) -> None:
        # D5: a regression left with no indicators keeps its title, bug, notes and commit. An
        # empty indicator set is a legal state.
        tables = make_suite("nts")

        with db_engine.begin() as connection:
            rows = seed(connection, tables)

            connection.execute(
                tables.machine.delete().where(tables.machine.c.id == rows["machine"])
            )

            assert count(connection, tables.regression) == 1

    def test_deleting_a_run_takes_its_samples_and_profiles(
        self, db_engine: Engine, make_suite: Callable[..., SuiteTables]
    ) -> None:
        tables = make_suite("nts")

        with db_engine.begin() as connection:
            rows = seed(connection, tables)

            connection.execute(tables.run.delete().where(tables.run.c.id == rows["run"]))

            assert count(connection, tables.sample) == 0
            assert count(connection, tables.profile) == 0
            assert count(connection, tables.machine) == 1

    def test_deleting_a_regression_takes_its_indicators(
        self, db_engine: Engine, make_suite: Callable[..., SuiteTables]
    ) -> None:
        tables = make_suite("nts")

        with db_engine.begin() as connection:
            rows = seed(connection, tables)

            connection.execute(
                tables.regression.delete().where(tables.regression.c.id == rows["regression"])
            )

            assert count(connection, tables.regression_indicator) == 0
            assert count(connection, tables.machine) == 1

    def test_a_test_in_use_cannot_be_deleted(
        self, db_engine: Engine, make_suite: Callable[..., SuiteTables]
    ) -> None:
        # Nothing deletes a test -- the Tests endpoint is read-only and tests are created
        # implicitly by submission -- so refusing is the safe answer rather than cascading away
        # every sample that mentions it.
        tables = make_suite("nts")

        with db_engine.begin() as connection:
            rows = seed(connection, tables)
            with pytest.raises(IntegrityError):
                connection.execute(tables.test.delete().where(tables.test.c.id == rows["test"]))


class TestEvolution:
    def test_a_column_can_be_added_to_a_populated_table(
        self, db_engine: Engine, make_suite: Callable[..., SuiteTables]
    ) -> None:
        # D2: adding an entry leaves existing rows with no value for it.
        make_suite("nts")
        grown = suite_tables.build(
            SuiteSchema.model_validate(
                {"name": "nts", "machine_fields": [{"name": "hardware", "type": "text"}]}
            )
        )

        with db_engine.begin() as connection:
            connection.execute(insert(grown.machine).values(name="before"))

            suite_tables.add_column(connection, grown.machine.c.hardware)

            assert connection.execute(select(grown.machine.c.hardware)).scalar_one() is None
            connection.execute(insert(grown.machine).values(name="after", hardware="arm64"))

    def test_a_column_can_be_added_for_every_type(
        self, db_engine: Engine, make_suite: Callable[..., SuiteTables]
    ) -> None:
        make_suite("nts")
        grown = suite_tables.build(
            SuiteSchema.model_validate({"name": "nts", **FULL}),
        )

        with db_engine.begin() as connection:
            for name in ("execution_time", "compile_status", "build_id", "measured_at"):
                suite_tables.add_column(connection, grown.sample.c[name])

        assert sql_type_of(db_engine, "nts", "sample", "execution_time") == "DOUBLE PRECISION"
        assert sql_type_of(db_engine, "nts", "sample", "measured_at") == "TIMESTAMP WITH TIME ZONE"

    def test_a_column_can_be_removed(
        self, db_engine: Engine, make_suite: Callable[..., SuiteTables]
    ) -> None:
        # D2: removing an entry permanently destroys every value stored for it, which is why the
        # endpoint that reaches this requires `?confirm=true`.
        tables = make_suite("nts", metrics=[{"name": "execution_time", "type": "real"}])

        with db_engine.begin() as connection:
            suite_tables.drop_column(connection, tables.sample, "execution_time")

        assert "execution_time" not in columns_of(inspect(db_engine), "nts", "sample")

    def test_a_column_named_for_a_reserved_word_can_be_added_and_removed(
        self, db_engine: Engine, make_suite: Callable[..., SuiteTables]
    ) -> None:
        tables = make_suite("nts", metrics=[{"name": "order", "type": "integer"}])
        grown = suite_tables.build(
            SuiteSchema.model_validate(
                {
                    "name": "nts",
                    "metrics": [
                        {"name": "order", "type": "integer"},
                        {"name": "user", "type": "text"},
                    ],
                }
            )
        )

        with db_engine.begin() as connection:
            suite_tables.add_column(connection, grown.sample.c["user"])
            suite_tables.drop_column(connection, tables.sample, "order")

        columns = columns_of(inspect(db_engine), "nts", "sample")
        assert "user" in columns
        assert "order" not in columns

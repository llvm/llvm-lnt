"""The suite registry (D2): how a worker keeps its copy of every schema honest.

A "worker" here is one `SuiteRegistry` over the shared database, so two of them is a two-worker
deployment -- which is the only way to reach the protocol these tests exist for.
"""

from __future__ import annotations

import threading
from collections.abc import Callable

import pytest
from sqlalchemy import Engine, event, insert, inspect, select, update
from sqlalchemy.exc import ProgrammingError

from introspection import schema_version_of, stored_names
from lnt_v5.errors import ApiError, ErrorCode
from lnt_v5.suites import tables as suite_tables
from lnt_v5.suites.registry import SuiteRegistry
from lnt_v5.suites.schema import SuiteSchema
from lnt_v5.suites.store import SCHEMA_NAME_CONSTRAINT, bump, locked_suite, normalized_json
from lnt_v5.tables import schema, schema_version

MINIMAL = {"name": "nts", "metrics": [{"name": "execution_time", "type": "real"}]}


def schema_for(name: str = "nts", **overrides: object) -> SuiteSchema:
    return SuiteSchema.model_validate({**MINIMAL, "name": name, **overrides})


@pytest.fixture
def store(db_engine: Engine) -> Callable[..., SuiteSchema]:
    """Write a suite straight into the database, the way another worker would have."""

    def write(name: str = "nts", **overrides: object) -> SuiteSchema:
        parsed = schema_for(name, **overrides)
        with db_engine.begin() as connection:
            connection.execute(
                insert(schema).values(name=name, schema_json=normalized_json(parsed))
            )
            suite_tables.create(connection, suite_tables.build(parsed))
            bump(connection)
        return parsed

    return write


def fresh(registry: SuiteRegistry, engine: Engine) -> dict[str, object]:
    with engine.connect() as connection:
        return dict(registry.fresh(connection))


class TestLoading:
    def test_finds_nothing_in_a_database_with_no_suites(self, db_engine: Engine) -> None:
        assert fresh(SuiteRegistry(), db_engine) == {}

    def test_loads_what_is_stored(
        self, db_engine: Engine, store: Callable[..., SuiteSchema]
    ) -> None:
        stored = store("nts")

        suites = fresh(SuiteRegistry(), db_engine)

        assert list(suites) == ["nts"]
        assert suites["nts"].schema == stored  # type: ignore[attr-defined]

    def test_builds_the_tables_for_what_it_loads(
        self, db_engine: Engine, store: Callable[..., SuiteSchema]
    ) -> None:
        store("nts")

        suite = fresh(SuiteRegistry(), db_engine)["nts"]

        assert "execution_time" in suite.tables.sample.c  # type: ignore[attr-defined]
        assert suite.tables.name == "nts"  # type: ignore[attr-defined]

    def test_reads_the_counter_and_the_schemas_in_one_statement(
        self, db_engine: Engine, store: Callable[..., SuiteSchema]
    ) -> None:
        """One statement, so both come from one snapshot (D2).

        Read separately they could straddle another worker's commit, and in one of the two orders
        that leaves the worker caching a counter newer than the data beside it -- so it stops
        reloading and serves a stale schema until the *next* change. Counting statements is what
        makes that unrepresentable rather than a comment someone has to preserve.
        """
        store("nts")
        registry = SuiteRegistry()
        seen: list[str] = []

        def record(connection: object, cursor: object, statement: str, *rest: object) -> None:
            seen.append(statement)

        event.listen(db_engine, "before_cursor_execute", record)
        try:
            fresh(registry, db_engine)
        finally:
            event.remove(db_engine, "before_cursor_execute", record)

        assert len(seen) == 1, seen
        assert "schema_version" in seen[0] and "schema_json" in seen[0]


class TestFreshness:
    def test_a_second_worker_sees_a_created_suite(
        self, db_engine: Engine, store: Callable[..., SuiteSchema]
    ) -> None:
        worker = SuiteRegistry()
        assert fresh(worker, db_engine) == {}

        store("nts")

        assert list(fresh(worker, db_engine)) == ["nts"]

    def test_a_second_worker_sees_a_changed_suite(
        self, db_engine: Engine, store: Callable[..., SuiteSchema]
    ) -> None:
        store("nts")
        worker = SuiteRegistry()
        fresh(worker, db_engine)

        evolved = schema_for("nts", metrics=[{"name": "compile_time", "type": "real"}])
        with db_engine.begin() as connection:
            connection.execute(
                update(schema)
                .where(schema.c.name == "nts")
                .values(schema_json=normalized_json(evolved))
            )
            bump(connection)

        suite = fresh(worker, db_engine)["nts"]
        assert [m.name for m in suite.schema.metrics] == ["compile_time"]  # type: ignore[attr-defined]

    def test_a_second_worker_sees_a_deleted_suite(
        self, db_engine: Engine, store: Callable[..., SuiteSchema]
    ) -> None:
        store("nts")
        worker = SuiteRegistry()
        fresh(worker, db_engine)

        with db_engine.begin() as connection:
            connection.execute(schema.delete().where(schema.c.name == "nts"))
            suite_tables.drop(connection, "nts")
            bump(connection)

        assert fresh(worker, db_engine) == {}

    def test_does_not_rebuild_when_the_counter_has_not_moved(
        self, db_engine: Engine, store: Callable[..., SuiteSchema]
    ) -> None:
        # The whole point of the counter: a request that changes nothing must not pay for a reload.
        store("nts")
        registry = SuiteRegistry()

        first = fresh(registry, db_engine)["nts"]
        second = fresh(registry, db_engine)["nts"]

        assert first is second

    def test_reloads_only_once_for_several_threads(
        self, db_engine: Engine, store: Callable[..., SuiteSchema]
    ) -> None:
        """Sync endpoints run in a threadpool, so several threads reach `fresh` at once.

        Released from a barrier rather than merely started together, so the overlap is guaranteed
        rather than left to the scheduler.
        """
        store("nts")
        registry = SuiteRegistry()
        threads = 8
        barrier = threading.Barrier(threads)
        loads = 0
        counted = threading.Lock()
        original = SuiteRegistry._parse

        def counting(self: SuiteRegistry, rows: object) -> object:
            nonlocal loads
            with counted:
                loads += 1
            return original(self, rows)  # type: ignore[arg-type]

        results: list[object] = []

        def worker() -> None:
            barrier.wait()
            with db_engine.connect() as connection:
                results.append(registry.fresh(connection)["nts"])

        SuiteRegistry._parse = counting  # type: ignore[method-assign, assignment]
        try:
            workers = [threading.Thread(target=worker) for _ in range(threads)]
            for thread in workers:
                thread.start()
            for thread in workers:
                thread.join()
        finally:
            SuiteRegistry._parse = original  # type: ignore[method-assign]

        assert loads == 1
        assert len(results) == threads
        assert all(result is results[0] for result in results)


class TestBadRows:
    def test_one_unparseable_schema_does_not_hide_the_others(
        self, db_engine: Engine, store: Callable[..., SuiteSchema]
    ) -> None:
        """A single bad row must not take the worker down (D2).

        `fresh` runs on every request path, so an all-or-nothing load would turn one row a newer
        build wrote -- or one edited by hand -- into a total outage for every unrelated suite, on
        every request, until someone noticed.
        """
        store("good")
        with db_engine.begin() as connection:
            connection.execute(
                insert(schema).values(name="bad", schema_json='{"name": "bad", "nonsense": 1}')
            )
            bump(connection)

        suites = fresh(SuiteRegistry(), db_engine)

        assert list(suites) == ["good"]

    def test_keeps_the_copy_it_already_had_for_a_row_that_stops_parsing(
        self, db_engine: Engine, store: Callable[..., SuiteSchema]
    ) -> None:
        store("nts")
        registry = SuiteRegistry()
        before = fresh(registry, db_engine)["nts"]

        with db_engine.begin() as connection:
            connection.execute(
                update(schema).where(schema.c.name == "nts").values(schema_json="{ not json")
            )
            bump(connection)

        assert fresh(registry, db_engine)["nts"] is before


class TestBump:
    def test_is_undone_with_the_transaction_that_made_it(self, db_engine: Engine) -> None:
        # D2 puts the bump in the same transaction as the write, so a write that rolls back must
        # not leave every other worker reloading for a change that never happened.
        before = schema_version_of(db_engine)

        with pytest.raises(RuntimeError), db_engine.begin() as connection:
            bump(connection)
            raise RuntimeError("rolled back")

        assert schema_version_of(db_engine) == before

    def test_moves_the_counter_when_it_commits(self, db_engine: Engine) -> None:
        before = schema_version_of(db_engine)

        with db_engine.begin() as connection:
            bump(connection)

        assert schema_version_of(db_engine) == before + 1

    def test_leaves_exactly_one_row(self, db_engine: Engine) -> None:
        # It addresses the row by the fixed id `tables.py` gives it rather than updating whatever
        # is there, so a second row could never appear from this path.
        with db_engine.begin() as connection:
            bump(connection)

        with db_engine.connect() as connection:
            assert len(connection.execute(select(schema_version.c.id)).all()) == 1


class TestLockedSuite:
    def test_returns_the_stored_schema(
        self, db_engine: Engine, store: Callable[..., SuiteSchema]
    ) -> None:
        stored = store("nts")

        with db_engine.begin() as connection:
            assert locked_suite(connection, "nts") == stored

    def test_is_404_for_a_suite_that_is_not_there(self, db_engine: Engine) -> None:
        # Which is what makes a change racing a delete answer 404 rather than succeed against a row
        # that has gone.
        with db_engine.begin() as connection, pytest.raises(ApiError) as raised:
            locked_suite(connection, "nope")

        assert raised.value.code is ErrorCode.NOT_FOUND

    def test_reads_the_row_rather_than_the_registry(
        self, db_engine: Engine, store: Callable[..., SuiteSchema]
    ) -> None:
        # The registry is allowed to be a commit behind; a change derived from it would drop
        # whatever the previous change added while still applying its own DDL.
        store("nts")
        evolved = schema_for("nts", metrics=[{"name": "compile_time", "type": "real"}])
        with db_engine.begin() as connection:
            connection.execute(
                update(schema)
                .where(schema.c.name == "nts")
                .values(schema_json=normalized_json(evolved))
            )
            # Deliberately no bump, so any cache would still be showing the old schema.

        with db_engine.begin() as connection:
            assert locked_suite(connection, "nts") == evolved

    def test_holds_the_row_against_a_second_caller(
        self, db_engine: Engine, store: Callable[..., SuiteSchema]
    ) -> None:
        """The lock itself, which is what makes two concurrent changes serialize.

        Asserted directly rather than through two racing requests, whose interleaving is up to the
        scheduler: here the second caller demonstrably cannot read until the first commits, which is
        the property every write path depends on.
        """
        store("nts")
        reached = threading.Event()

        def second() -> None:
            with db_engine.begin() as connection:
                locked_suite(connection, "nts")
                reached.set()

        with db_engine.begin() as first:
            locked_suite(first, "nts")
            waiter = threading.Thread(target=second, daemon=True)
            waiter.start()
            # Long enough to be sure it is blocked rather than merely slow.
            assert not reached.wait(timeout=1.0), "the second caller was not blocked"

        assert reached.wait(timeout=10.0), "the second caller never got the row"
        waiter.join(timeout=10.0)


class TestConstraintNames:
    def test_the_suite_name_constraint_is_the_one_postgres_reports(self, db_engine: Engine) -> None:
        # `routes/suites.py` tells a repeated suite name from any other integrity error by this
        # name, which it writes out. A change to the convention must fail here rather than silently
        # turn the 409 into a 500.
        assert SCHEMA_NAME_CONSTRAINT in stored_names(inspect(db_engine))["schema"]


class TestUnmigratedDatabase:
    def test_fails_rather_than_reporting_no_suites(self, empty_engine: Engine) -> None:
        # Answering "no suites" would be a lie a caller could not tell from the truth. The server
        # migrates before it serves (D14), so this is only reachable out of band.
        with empty_engine.connect() as connection, pytest.raises(ProgrammingError):
            SuiteRegistry().fresh(connection)


class TestSuiteTablesAreNotMutated:
    def test_a_reload_replaces_the_map_rather_than_editing_it(
        self, db_engine: Engine, store: Callable[..., SuiteSchema]
    ) -> None:
        """A caller holding a previous result keeps a consistent snapshot.

        Request threads read these `Table` objects concurrently while compiling queries, and
        SQLAlchemy's are safe for concurrent reads only -- so a reload must never edit one in place.
        """
        store("nts")
        registry = SuiteRegistry()
        held = fresh(registry, db_engine)
        held_suite = held["nts"]

        evolved = schema_for("nts", metrics=[{"name": "compile_time", "type": "real"}])
        with db_engine.begin() as connection:
            connection.execute(
                update(schema)
                .where(schema.c.name == "nts")
                .values(schema_json=normalized_json(evolved))
            )
            bump(connection)
        after = fresh(registry, db_engine)

        assert after["nts"] is not held_suite
        # The snapshot the caller already had still describes what it described.
        assert "execution_time" in held_suite.tables.sample.c  # type: ignore[attr-defined]
        assert "compile_time" not in held_suite.tables.sample.c  # type: ignore[attr-defined]

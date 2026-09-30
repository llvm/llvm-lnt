"""`{suite}.test_coverage` (D5): exact counts of which tests have samples on which machine.

Driven over the real application and a real database. The one property that matters is that the
table always equals what it summarizes, so nearly every test here ends by recounting `sample` from
scratch and comparing: after submissions, after each kind of deletion, after a schema change, and --
the half a single-threaded test cannot see -- after a deletion races a submission or another
deletion. The races are staged the way `test_concurrency.py` stages them: a transaction holds its
lock, the test waits until the other request is demonstrably blocked on it, and only then commits.
"""

from __future__ import annotations

import time
from collections.abc import Callable, Iterator
from concurrent.futures import Future, ThreadPoolExecutor
from typing import Any
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import Engine, delete, func, insert, select, text

from conftest import code_of, run_payload
from introspection import counting_statements
from lnt_v5.routes.commits import COMMITS_PATH
from lnt_v5.routes.machines import MACHINES_PATH
from lnt_v5.routes.runs import RUNS_PATH
from lnt_v5.routes.suites import SUITES_PATH
from lnt_v5.suites import coverage
from lnt_v5.suites.registry import Suite
from lnt_v5.suites.schema import SuiteSchema
from lnt_v5.suites.states import RegressionState
from lnt_v5.suites.submission import SubmittedTest
from lnt_v5.suites.tables import SuiteTables, build
from test_concurrency import BLOCK_TIMEOUT, until_blocked

RUNS = RUNS_PATH.format(testsuite="nts")
COMMITS = COMMITS_PATH.format(testsuite="nts")
MACHINES = MACHINES_PATH.format(testsuite="nts")

NTS: dict[str, Any] = {
    "name": "nts",
    "metrics": [
        {"name": "execution_time", "type": "real"},
        {"name": "compile_time", "type": "real"},
    ],
}

# (machine, test) -> (sample_count, one count per metric), which is what both the table and the
# recount below reduce to.
Counts = dict[tuple[str, str], tuple[int, ...]]


@pytest.fixture
def suite(make_api_suite: Callable[[dict[str, Any]], SuiteTables]) -> SuiteTables:
    return make_api_suite(NTS)


@pytest.fixture
def background() -> Iterator[Callable[..., Future[Any]]]:
    with ThreadPoolExecutor(max_workers=8) as pool:
        yield pool.submit


@pytest.fixture
def submit(
    api_client: TestClient, submitter: dict[str, str], suite: SuiteTables
) -> Callable[..., str]:
    """Submit a run and hand back its UUID."""

    def post(*tests: dict[str, Any], machine: str = "linux", commit: str = "abc123") -> str:
        body = run_payload(machine={"name": machine}, commit={"value": commit}, tests=list(tests))
        response = api_client.post(RUNS, json=body, headers=submitter)
        assert response.status_code == 201, response.text
        return str(response.json()["uuid"])

    return post


def stored(engine: Engine, tables: SuiteTables) -> Counts:
    """What `{suite}.test_coverage` holds, keyed by names rather than ids."""
    coverage_, machine, test = tables.test_coverage, tables.machine, tables.test
    counted = [coverage_.c.sample_count, *(coverage_.c[m["name"]] for m in NTS["metrics"])]
    with engine.connect() as connection:
        rows = connection.execute(
            select(machine.c.name, test.c.name, *counted)
            .join_from(coverage_, machine, machine.c.id == coverage_.c.machine_id)
            .join(test, test.c.id == coverage_.c.test_id)
        ).all()
    return {(row[0], row[1]): tuple(row[2:]) for row in rows}


def recounted(engine: Engine, tables: SuiteTables) -> Counts:
    """What `{suite}.test_coverage` should hold, recounted from `{suite}.sample` from scratch."""
    sample, run, machine, test = tables.sample, tables.run, tables.machine, tables.test
    with engine.connect() as connection:
        rows = connection.execute(
            select(
                machine.c.name,
                test.c.name,
                func.count(),
                *(func.count(sample.c[m["name"]]) for m in NTS["metrics"]),
            )
            .join_from(sample, run, run.c.id == sample.c.run_id)
            .join(machine, machine.c.id == run.c.machine_id)
            .join(test, test.c.id == sample.c.test_id)
            .group_by(machine.c.name, test.c.name)
        ).all()
    return {(row[0], row[1]): tuple(row[2:]) for row in rows}


def live(tables: SuiteTables) -> Suite:
    """The suite as the write paths take it, for a test that stages a writer by hand."""
    return Suite(schema=SuiteSchema.model_validate(NTS), tables=tables, schema_json="")


def until_waiting(engine: Engine, count: int) -> None:
    """Wait until at least `count` backends on this database are waiting on a lock."""
    deadline = time.monotonic() + BLOCK_TIMEOUT
    while time.monotonic() < deadline:
        with engine.connect() as connection:
            waiting = connection.execute(
                text(
                    "SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() "
                    "AND wait_event_type = 'Lock'"
                )
            ).scalar_one()
        if waiting >= count:
            return
        time.sleep(0.01)
    raise AssertionError(f"fewer than {count} backends blocked on a lock within {BLOCK_TIMEOUT}s")


def assert_exact(engine: Engine, tables: SuiteTables) -> Counts:
    counts = stored(engine, tables)
    assert counts == recounted(engine, tables)
    return counts


class TestSubmission:
    def test_counts_every_sample_and_every_metric_value(
        self, db_engine: Engine, suite: SuiteTables, submit: Callable[..., str]
    ) -> None:
        # Three repetitions, of which all carry `execution_time` and one carries `compile_time` --
        # scalars repeat across the rows an array expands into (D6), so a scalar counts three times.
        submit(
            {"name": "a", "execution_time": [1.0, 2.0, 3.0], "compile_time": 0.5},
            {"name": "b", "execution_time": 1.0},
        )

        assert assert_exact(db_engine, suite) == {
            ("linux", "a"): (3, 3, 3),
            ("linux", "b"): (1, 1, 0),
        }

    def test_counts_a_test_that_ran_without_any_metric(
        self, db_engine: Engine, suite: SuiteTables, submit: Callable[..., str]
    ) -> None:
        # D6: such an entry is still a sample, and `machine=` alone has to find it.
        submit({"name": "a"})

        assert assert_exact(db_engine, suite) == {("linux", "a"): (1, 0, 0)}

    def test_adds_to_what_earlier_submissions_counted(
        self, db_engine: Engine, suite: SuiteTables, submit: Callable[..., str]
    ) -> None:
        submit({"name": "a", "execution_time": 1.0})
        submit({"name": "a", "compile_time": 1.0}, commit="def456")

        assert assert_exact(db_engine, suite) == {("linux", "a"): (2, 1, 1)}

    def test_keeps_each_machine_apart(
        self, db_engine: Engine, suite: SuiteTables, submit: Callable[..., str]
    ) -> None:
        submit({"name": "a", "execution_time": 1.0}, machine="linux")
        submit({"name": "a", "compile_time": 1.0}, machine="darwin")

        assert assert_exact(db_engine, suite) == {
            ("linux", "a"): (1, 1, 0),
            ("darwin", "a"): (1, 0, 1),
        }

    def test_costs_one_statement_however_many_tests_there_are(
        self, submit: Callable[..., str]
    ) -> None:
        # D13: the coverage rows are written in one statement, like the samples.
        with counting_statements("nts.test_coverage") as one_test:
            submit({"name": "a", "execution_time": 1.0})
        with counting_statements("nts.test_coverage") as many_tests:
            submit(*({"name": f"t{index}", "execution_time": 1.0} for index in range(500)))

        assert len(many_tests) == len(one_test) == 1

    def test_a_run_that_measured_nothing_counts_nothing(
        self, db_engine: Engine, suite: SuiteTables, submit: Callable[..., str]
    ) -> None:
        submit()

        assert assert_exact(db_engine, suite) == {}


class TestDeletion:
    def test_deleting_a_run_subtracts_its_samples(
        self,
        api_client: TestClient,
        manage: dict[str, str],
        db_engine: Engine,
        suite: SuiteTables,
        submit: Callable[..., str],
    ) -> None:
        submit({"name": "a", "execution_time": [1.0, 2.0]})
        doomed = submit({"name": "a", "execution_time": 1.0, "compile_time": 1.0}, commit="def")

        assert api_client.delete(f"{RUNS}/{doomed}", headers=manage).status_code == 204
        assert assert_exact(db_engine, suite) == {("linux", "a"): (2, 2, 0)}

    def test_deleting_a_tests_last_samples_on_a_machine_removes_its_row(
        self,
        api_client: TestClient,
        manage: dict[str, str],
        db_engine: Engine,
        suite: SuiteTables,
        submit: Callable[..., str],
    ) -> None:
        # D5: a row exists exactly when the machine has samples of the test, which is what
        # `machine=` alone asks about.
        submit({"name": "kept"})
        doomed = submit({"name": "gone"}, commit="def")

        assert api_client.delete(f"{RUNS}/{doomed}", headers=manage).status_code == 204
        assert assert_exact(db_engine, suite) == {("linux", "kept"): (1, 0, 0)}

    def test_deleting_a_commit_subtracts_every_run_on_every_machine(
        self,
        api_client: TestClient,
        manage: dict[str, str],
        db_engine: Engine,
        suite: SuiteTables,
        submit: Callable[..., str],
    ) -> None:
        submit({"name": "a", "execution_time": 1.0}, machine="linux", commit="doomed")
        submit({"name": "a", "execution_time": 1.0}, machine="darwin", commit="doomed")
        submit({"name": "a", "execution_time": 1.0}, machine="linux", commit="kept")

        assert api_client.delete(f"{COMMITS}/doomed", headers=manage).status_code == 204
        assert assert_exact(db_engine, suite) == {("linux", "a"): (1, 1, 0)}

    def test_a_refused_commit_deletion_subtracts_nothing(
        self,
        api_client: TestClient,
        manage: dict[str, str],
        db_engine: Engine,
        suite: SuiteTables,
        submit: Callable[..., str],
    ) -> None:
        # R4's `in_use` rolls the whole transaction back, the subtraction with it.
        submit({"name": "a", "execution_time": 1.0}, commit="referenced")
        with db_engine.begin() as connection:
            referenced = select(suite.commit.c.id).where(suite.commit.c.commit == "referenced")
            connection.execute(
                insert(suite.regression).values(
                    uuid=str(uuid4()),
                    state=RegressionState.DETECTED,
                    commit_id=referenced.scalar_subquery(),
                )
            )

        response = api_client.delete(f"{COMMITS}/referenced", headers=manage)

        assert code_of(response) == "in_use"
        assert assert_exact(db_engine, suite) == {("linux", "a"): (1, 1, 0)}

    def test_deleting_a_machine_removes_its_rows(
        self,
        api_client: TestClient,
        manage: dict[str, str],
        db_engine: Engine,
        suite: SuiteTables,
        submit: Callable[..., str],
    ) -> None:
        submit({"name": "a"}, machine="linux")
        submit({"name": "a"}, machine="darwin")

        assert api_client.delete(f"{MACHINES}/darwin", headers=manage).status_code == 204
        assert assert_exact(db_engine, suite) == {("linux", "a"): (1, 0, 0)}

    def test_a_deletion_costs_the_same_statements_however_much_it_deletes(
        self,
        api_client: TestClient,
        manage: dict[str, str],
        submit: Callable[..., str],
    ) -> None:
        small = submit({"name": "a"}, commit="small")
        submit(*({"name": f"t{index}"} for index in range(500)), commit="large")

        with counting_statements("nts.test_coverage") as for_small:
            assert api_client.delete(f"{RUNS}/{small}", headers=manage).status_code == 204
        with counting_statements("nts.test_coverage") as for_large:
            assert api_client.delete(f"{COMMITS}/large", headers=manage).status_code == 204

        # The subtraction and the removal of emptied rows; the counts they subtract are read from
        # `sample` in one statement more, which does not name this table.
        assert len(for_large) == len(for_small) == 2

    def test_deleting_a_run_that_is_not_there_subtracts_nothing(
        self,
        api_client: TestClient,
        manage: dict[str, str],
        db_engine: Engine,
        suite: SuiteTables,
        submit: Callable[..., str],
    ) -> None:
        submit({"name": "a"})

        assert api_client.delete(f"{RUNS}/{uuid4()}", headers=manage).status_code == 404
        assert assert_exact(db_engine, suite) == {("linux", "a"): (1, 0, 0)}


class TestSchemaChange:
    def test_an_added_metric_starts_at_zero_and_is_counted_from_then_on(
        self,
        api_client: TestClient,
        manage: dict[str, str],
        db_engine: Engine,
        suite: SuiteTables,
        submit: Callable[..., str],
    ) -> None:
        submit({"name": "a", "execution_time": 1.0})
        patch = {"metrics": {"add": [{"name": "size", "type": "integer"}]}}
        response = api_client.patch(f"{SUITES_PATH}/nts/schema", json=patch, headers=manage)
        assert response.status_code == 200, response.text
        submit({"name": "a", "size": 4}, commit="def")

        grown = build(SuiteSchema.model_validate(response.json())).test_coverage
        with db_engine.connect() as connection:
            row = connection.execute(select(grown.c.sample_count, grown.c.size)).one()
        assert tuple(row) == (2, 1)

    def test_a_removed_metric_takes_its_count_with_it(
        self,
        api_client: TestClient,
        manage: dict[str, str],
        db_engine: Engine,
        suite: SuiteTables,
        submit: Callable[..., str],
    ) -> None:
        submit({"name": "a", "execution_time": 1.0, "compile_time": 1.0})
        patch = {"metrics": {"remove": ["compile_time"]}}

        response = api_client.patch(
            f"{SUITES_PATH}/nts/schema?confirm=true", json=patch, headers=manage
        )

        assert response.status_code == 200, response.text
        shrunk = build(SuiteSchema.model_validate(response.json())).test_coverage
        with db_engine.connect() as connection:
            row = connection.execute(select(shrunk)).one()
        assert "compile_time" not in row._mapping
        assert row._mapping["sample_count"] == 1


class TestConcurrency:
    def test_a_commit_deletion_waits_for_and_counts_a_submission_in_flight(
        self,
        api_client: TestClient,
        manage: dict[str, str],
        db_engine: Engine,
        suite: SuiteTables,
        submit: Callable[..., str],
        background: Callable[..., Future[Any]],
    ) -> None:
        # D13. A submission for the commit is mid-transaction: its run, sample and coverage rows
        # are written but not committed. Counting before locking the commit would miss them, and the
        # cascade -- which reads the latest committed state -- would then delete them uncounted.
        submit({"name": "a"}, commit="doomed")
        with db_engine.connect() as connection, connection.begin():
            machine = connection.execute(select(suite.machine.c.id)).scalar_one()
            commit = connection.execute(select(suite.commit.c.id)).scalar_one()
            test = connection.execute(select(suite.test.c.id)).scalar_one()
            run = connection.execute(
                insert(suite.run)
                .values(uuid=str(uuid4()), machine_id=machine, commit_id=commit)
                .returning(suite.run.c.id)
            ).scalar_one()
            row = {"execution_time": 1.0, "compile_time": None}
            connection.execute(insert(suite.sample).values(run_id=run, test_id=test, **row))
            in_flight = [SubmittedTest("a", [row], None)]
            coverage.add(connection, live(suite), machine, in_flight, {"a": test})

            deleting = background(api_client.delete, f"{COMMITS}/doomed", headers=manage)
            until_blocked(db_engine)

        assert deleting.result(timeout=BLOCK_TIMEOUT).status_code == 204
        assert assert_exact(db_engine, suite) == {}

    def test_two_deletions_of_one_run_subtract_it_once(
        self,
        api_client: TestClient,
        manage: dict[str, str],
        db_engine: Engine,
        suite: SuiteTables,
        submit: Callable[..., str],
        background: Callable[..., Future[Any]],
    ) -> None:
        submit({"name": "a"})
        doomed = submit({"name": "a"}, commit="def")
        with db_engine.connect() as connection, connection.begin():
            locked = connection.execute(
                select(suite.run.c.id).where(suite.run.c.uuid == doomed).with_for_update()
            ).scalar_one()
            second = background(api_client.delete, f"{RUNS}/{doomed}", headers=manage)
            until_blocked(db_engine)
            coverage.subtract(connection, live(suite), suite.run.c.id == locked)
            connection.execute(delete(suite.run).where(suite.run.c.id == locked))

        assert second.result(timeout=BLOCK_TIMEOUT).status_code == 404
        assert assert_exact(db_engine, suite) == {("linux", "a"): (1, 0, 0)}

    def test_a_commit_and_its_machine_deleted_at_once_both_complete(
        self,
        api_client: TestClient,
        manage: dict[str, str],
        db_engine: Engine,
        suite: SuiteTables,
        submit: Callable[..., str],
        background: Callable[..., Future[Any]],
    ) -> None:
        # The commit deletion holds coverage rows and then cascades to runs; the machine deletion
        # cascades to both. Staged by holding one of the commit's runs, which pauses the commit
        # deletion inside its cascade until the machine deletion has started too. The deadlock
        # `coverage.hold_machines` prevents needs the two cascades to reach the runs in different
        # orders, which tables this small do not produce reliably, so this pins that the two
        # complete and stay exact rather than reproducing the cycle.
        paused = submit(*({"name": f"t{index}"} for index in range(20)), commit="doomed")
        submit(*({"name": f"t{index}"} for index in range(20)), commit="doomed")
        with db_engine.connect() as connection:
            transaction = connection.begin()
            connection.execute(
                select(suite.run.c.id).where(suite.run.c.uuid == paused).with_for_update()
            )
            commit = background(api_client.delete, f"{COMMITS}/doomed", headers=manage)
            until_waiting(db_engine, 1)
            machine = background(api_client.delete, f"{MACHINES}/linux", headers=manage)
            until_waiting(db_engine, 2)
            transaction.rollback()

        assert commit.result(timeout=BLOCK_TIMEOUT).status_code == 204
        assert machine.result(timeout=BLOCK_TIMEOUT).status_code == 204
        assert assert_exact(db_engine, suite) == {}

    def test_concurrent_submissions_and_deletions_stay_exact(
        self,
        api_client: TestClient,
        manage: dict[str, str],
        db_engine: Engine,
        suite: SuiteTables,
        submit: Callable[..., str],
        background: Callable[..., Future[Any]],
    ) -> None:
        # Every writer updates the same rows. The submissions list their tests in orders that are
        # deliberately incompatible, which is what would deadlock writers that did not sort; a
        # deadlock surfaces as a 500 out of `result()`, so "every request succeeded" is half of
        # what this asserts.
        names = [f"t{index:02d}" for index in range(40)]
        orders = [names, list(reversed(names)), names[20:] + names[:20], names[1::2] + names[::2]]
        doomed = [submit(*({"name": n} for n in names), commit=f"old{i}") for i in range(4)]

        def entries(order: list[str]) -> list[dict[str, Any]]:
            return [{"name": name, "execution_time": 1.0} for name in order]

        running = [
            background(submit, *entries(order), commit=f"new{i}") for i, order in enumerate(orders)
        ]
        running += [
            background(api_client.delete, f"{RUNS}/{uuid}", headers=manage) for uuid in doomed
        ]
        for future in running:
            result = future.result(timeout=BLOCK_TIMEOUT)
            if not isinstance(result, str):
                assert result.status_code == 204, result.text

        counts = assert_exact(db_engine, suite)
        assert counts == {("linux", name): (4, 4, 0) for name in names}

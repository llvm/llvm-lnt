"""`{suite}.test_coverage` (D5): the tests each machine has had samples of, and of which metrics.

Driven over the real application and a real database. Two properties matter. After submissions alone
the table equals what `{suite}.sample` derives, so most tests here end by rederiving it from scratch
and comparing. And it only ever accumulates: a deletion of runs or commits leaves it as it was, and
only deleting a machine removes rows.
"""

from __future__ import annotations

from collections.abc import Callable, Iterator
from concurrent.futures import Future, ThreadPoolExecutor
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import Engine, func, select, text

from conftest import run_payload
from introspection import counting_statements
from lnt_v5.routes.commits import COMMITS_PATH
from lnt_v5.routes.machines import MACHINES_PATH
from lnt_v5.routes.runs import RUNS_PATH
from lnt_v5.routes.suites import SUITES_PATH
from lnt_v5.suites.schema import SuiteSchema
from lnt_v5.suites.tables import SuiteTables, build
from test_concurrency import BLOCK_TIMEOUT

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

# (machine, test) -> one flag per metric, which is what both the table and the rederivation below
# reduce to.
Flags = dict[tuple[str, str], tuple[bool, ...]]


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


def stored(engine: Engine, tables: SuiteTables) -> Flags:
    """What `{suite}.test_coverage` holds, keyed by names rather than ids."""
    coverage, machine, test = tables.test_coverage, tables.machine, tables.test
    flags = [coverage.c[m["name"]] for m in NTS["metrics"]]
    with engine.connect() as connection:
        rows = connection.execute(
            select(machine.c.name, test.c.name, *flags)
            .join_from(coverage, machine, machine.c.id == coverage.c.machine_id)
            .join(test, test.c.id == coverage.c.test_id)
        ).all()
    return {(row[0], row[1]): tuple(row[2:]) for row in rows}


def derived(engine: Engine, tables: SuiteTables) -> Flags:
    """What `{suite}.test_coverage` would hold if the samples still stored were all it had seen."""
    sample, run, machine, test = tables.sample, tables.run, tables.machine, tables.test
    with engine.connect() as connection:
        rows = connection.execute(
            select(
                machine.c.name,
                test.c.name,
                *(func.bool_or(sample.c[m["name"]].is_not(None)) for m in NTS["metrics"]),
            )
            .join_from(sample, run, run.c.id == sample.c.run_id)
            .join(machine, machine.c.id == run.c.machine_id)
            .join(test, test.c.id == sample.c.test_id)
            .group_by(machine.c.name, test.c.name)
        ).all()
    return {(row[0], row[1]): tuple(row[2:]) for row in rows}


def assert_derivable(engine: Engine, tables: SuiteTables) -> Flags:
    flags = stored(engine, tables)
    assert flags == derived(engine, tables)
    return flags


def row_versions(engine: Engine) -> list[str]:
    """Each coverage row's `xmin`, which changes exactly when the row is rewritten."""
    with engine.connect() as connection:
        return list(
            connection.execute(
                text("SELECT xmin::text FROM nts.test_coverage ORDER BY machine_id, test_id")
            ).scalars()
        )


class TestSubmission:
    def test_records_each_metric_that_has_a_value(
        self, db_engine: Engine, suite: SuiteTables, submit: Callable[..., str]
    ) -> None:
        # Scalars repeat across the rows an array expands into (O1); one value is enough either way.
        submit(
            {"name": "a", "execution_time": [1.0, 2.0, 3.0], "compile_time": 0.5},
            {"name": "b", "execution_time": 1.0},
        )

        assert assert_derivable(db_engine, suite) == {
            ("linux", "a"): (True, True),
            ("linux", "b"): (True, False),
        }

    def test_records_a_test_that_ran_without_any_metric(
        self, db_engine: Engine, suite: SuiteTables, submit: Callable[..., str]
    ) -> None:
        # O1: such an entry is still a sample, and `machine=` alone has to find it.
        submit({"name": "a"})

        assert assert_derivable(db_engine, suite) == {("linux", "a"): (False, False)}

    def test_adds_to_what_earlier_submissions_recorded(
        self, db_engine: Engine, suite: SuiteTables, submit: Callable[..., str]
    ) -> None:
        submit({"name": "a", "execution_time": 1.0})
        submit({"name": "a", "compile_time": 1.0}, commit="def456")

        assert assert_derivable(db_engine, suite) == {("linux", "a"): (True, True)}

    def test_a_submission_without_a_metric_does_not_clear_it(
        self, db_engine: Engine, suite: SuiteTables, submit: Callable[..., str]
    ) -> None:
        submit({"name": "a", "execution_time": 1.0})
        submit({"name": "a"}, commit="def456")

        assert assert_derivable(db_engine, suite) == {("linux", "a"): (True, False)}

    def test_keeps_each_machine_apart(
        self, db_engine: Engine, suite: SuiteTables, submit: Callable[..., str]
    ) -> None:
        submit({"name": "a", "execution_time": 1.0}, machine="linux")
        submit({"name": "a", "compile_time": 1.0}, machine="darwin")

        assert assert_derivable(db_engine, suite) == {
            ("linux", "a"): (True, False),
            ("darwin", "a"): (False, True),
        }

    def test_a_submission_that_adds_nothing_rewrites_nothing(
        self, db_engine: Engine, suite: SuiteTables, submit: Callable[..., str]
    ) -> None:
        # A machine normally reports the same tests and metrics on every run, so the common
        # submission must leave its rows alone rather than churn a new version of each.
        submit({"name": "a", "execution_time": 1.0}, {"name": "b"})
        before = row_versions(db_engine)

        submit({"name": "a", "execution_time": 2.0}, {"name": "b"}, commit="def456")

        assert row_versions(db_engine) == before

    def test_costs_one_statement_however_many_tests_there_are(
        self, submit: Callable[..., str]
    ) -> None:
        # O8: the coverage rows are written in one statement, like the samples.
        with counting_statements("nts.test_coverage") as one_test:
            submit({"name": "a", "execution_time": 1.0})
        with counting_statements("nts.test_coverage") as many_tests:
            submit(*({"name": f"t{index}", "execution_time": 1.0} for index in range(500)))

        assert len(many_tests) == len(one_test) == 1

    def test_a_run_that_measured_nothing_records_nothing(
        self, db_engine: Engine, suite: SuiteTables, submit: Callable[..., str]
    ) -> None:
        submit()

        assert assert_derivable(db_engine, suite) == {}

    def test_a_suite_with_no_metrics_records_its_tests(
        self,
        api_client: TestClient,
        submitter: dict[str, str],
        db_engine: Engine,
        make_api_suite: Callable[[dict[str, Any]], SuiteTables],
    ) -> None:
        # No flag to set, so a repeated test has nothing to update -- which the upsert must not
        # trip over.
        tables = make_api_suite({"name": "bare"})
        runs = RUNS_PATH.format(testsuite="bare")
        for commit in ("abc", "def"):
            body = run_payload(commit={"value": commit}, tests=[{"name": "a"}])
            assert api_client.post(runs, json=body, headers=submitter).status_code == 201

        with db_engine.connect() as connection:
            assert (
                connection.execute(
                    select(func.count()).select_from(tables.test_coverage)
                ).scalar_one()
                == 1
            )


class TestDeletion:
    def test_deleting_a_run_leaves_what_it_recorded(
        self,
        api_client: TestClient,
        manage: dict[str, str],
        db_engine: Engine,
        suite: SuiteTables,
        submit: Callable[..., str],
    ) -> None:
        submit({"name": "a", "execution_time": 1.0})
        doomed = submit({"name": "a", "compile_time": 1.0}, {"name": "b"}, commit="def")

        assert api_client.delete(f"{RUNS}/{doomed}", headers=manage).status_code == 204
        assert stored(db_engine, suite) == {
            ("linux", "a"): (True, True),
            ("linux", "b"): (False, False),
        }

    def test_deleting_a_commit_leaves_what_its_runs_recorded(
        self,
        api_client: TestClient,
        manage: dict[str, str],
        db_engine: Engine,
        suite: SuiteTables,
        submit: Callable[..., str],
    ) -> None:
        submit({"name": "a", "execution_time": 1.0}, machine="linux", commit="doomed")
        submit({"name": "a", "execution_time": 1.0}, machine="darwin", commit="doomed")

        assert api_client.delete(f"{COMMITS}/doomed", headers=manage).status_code == 204
        assert stored(db_engine, suite) == {
            ("linux", "a"): (True, False),
            ("darwin", "a"): (True, False),
        }

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
        assert assert_derivable(db_engine, suite) == {("linux", "a"): (False, False)}


class TestSchemaChange:
    def test_an_added_metric_starts_false_and_is_recorded_from_then_on(
        self,
        api_client: TestClient,
        manage: dict[str, str],
        db_engine: Engine,
        suite: SuiteTables,
        submit: Callable[..., str],
    ) -> None:
        submit({"name": "a", "execution_time": 1.0}, {"name": "b"})
        patch = {"metrics": {"add": [{"name": "size", "type": "integer"}]}}
        response = api_client.patch(f"{SUITES_PATH}/nts/schema", json=patch, headers=manage)
        assert response.status_code == 200, response.text
        grown = build(SuiteSchema.model_validate(response.json())).test_coverage
        read = select(grown.c.test_id, grown.c.size).order_by(grown.c.test_id)
        with db_engine.connect() as connection:
            assert [row.size for row in connection.execute(read)] == [False, False]

        submit({"name": "a", "size": 4}, commit="def")

        with db_engine.connect() as connection:
            assert [row.size for row in connection.execute(read)] == [True, False]

    def test_a_removed_metric_takes_its_flag_with_it(
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
        assert row._mapping["execution_time"] is True


class TestConcurrency:
    def test_concurrent_submissions_for_one_machine_all_succeed(
        self,
        db_engine: Engine,
        suite: SuiteTables,
        submit: Callable[..., str],
        background: Callable[..., Future[Any]],
    ) -> None:
        # Every submission writes the same rows, and lists its tests in an order deliberately
        # incompatible with the others', which is what would deadlock writers that did not sort. A
        # deadlock surfaces as a 409 `retry`, which `submit` asserts against.
        names = [f"t{index:02d}" for index in range(40)]
        orders = [names, list(reversed(names)), names[20:] + names[:20], names[1::2] + names[::2]]

        def entries(order: list[str], metric: str) -> list[dict[str, Any]]:
            return [{"name": name, metric: 1.0} for name in order]

        running = [
            background(submit, *entries(order, metric), commit=f"c{i}")
            for i, order in enumerate(orders)
            for metric in ("execution_time", "compile_time")
        ]
        for future in running:
            future.result(timeout=BLOCK_TIMEOUT)

        assert assert_derivable(db_engine, suite) == {("linux", n): (True, True) for n in names}

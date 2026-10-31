"""Deleting the machines and commits that have been inactive for longer than they asked (O10).

Inactivity is simulated by moving timestamps back in SQL -- `first_seen_at` and the runs'
`submitted_at` -- rather than by waiting, since O10 counts in days.
"""

from __future__ import annotations

import threading
import time
from collections.abc import Callable
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import Engine, Interval, func, literal_column, text, update

from conftest import entry, run_payload
from introspection import counted
from lnt_v5.app import create_app
from lnt_v5.config import Settings
from lnt_v5.routes.commits import COMMITS_PATH
from lnt_v5.routes.machines import MACHINES_PATH
from lnt_v5.routes.regressions import REGRESSIONS_PATH
from lnt_v5.routes.runs import RUNS_PATH
from lnt_v5.suites import inactivity
from lnt_v5.suites.inactivity import SWEEP_LOCK_KEY, InactivitySweeper, sweep
from lnt_v5.suites.registry import SuiteRegistry
from lnt_v5.suites.tables import SuiteTables

NTS: dict[str, Any] = {"name": "nts", "metrics": [{"name": "execution_time", "type": "real"}]}

MACHINES = MACHINES_PATH.format(project="nts", suite="nts")
COMMITS = COMMITS_PATH.format(project="nts", suite="nts")
RUNS = RUNS_PATH.format(project="nts", suite="nts")
REGRESSIONS = REGRESSIONS_PATH.format(project="nts", suite="nts")


@pytest.fixture
def suite(make_api_suite: Callable[[dict[str, Any]], SuiteTables]) -> SuiteTables:
    return make_api_suite(NTS)


@pytest.fixture
def submit(
    api_client: TestClient, submitter: dict[str, str], suite: SuiteTables
) -> Callable[..., None]:
    """Submit a run for a machine and a commit, given as entity objects or as their identity."""

    def post(machine: str | dict[str, Any], commit: str | dict[str, Any], **keys: Any) -> None:
        body = run_payload(
            machine=machine if isinstance(machine, dict) else {"name": machine},
            commit=commit if isinstance(commit, dict) else {"value": commit},
            tests=[entry("bench", {"execution_time": 1.0})],
            **keys,
        )
        response = api_client.post(RUNS, json=body, headers=submitter)
        assert response.status_code == 201, response.text

    return post


@pytest.fixture
def idle(db_engine: Engine, suite: SuiteTables) -> Callable[[int], None]:
    """Make everything in the suite so far look `days` days older: when each machine and commit was
    first seen, and when each run was submitted."""

    def age(days: int) -> None:
        back = literal_column(f"INTERVAL '{days} days'", Interval)
        with db_engine.begin() as connection:
            for table in (suite.machine, suite.commit):
                connection.execute(update(table).values(first_seen_at=table.c.first_seen_at - back))
            connection.execute(
                update(suite.run).values(submitted_at=suite.run.c.submitted_at - back)
            )

    return age


def swept(engine: Engine) -> list[inactivity.SweptSuite]:
    result = sweep(engine, SuiteRegistry())
    assert result is not None
    return result


def exists(api_client: TestClient, path: str) -> bool:
    status = api_client.get(path).status_code
    assert status in (200, 404)
    return status == 200


class TestEligibility:
    def test_deletes_a_machine_inactive_for_longer_than_it_asked_with_its_runs(
        self,
        api_client: TestClient,
        db_engine: Engine,
        suite: SuiteTables,
        submit: Callable[..., None],
        idle: Callable[[int], None],
    ) -> None:
        submit({"name": "pr-1", "delete_after_inactive_days": 30}, "abc")
        idle(31)

        assert swept(db_engine)[0].deleted["machine"] == ("pr-1",)

        assert not exists(api_client, f"{MACHINES}/pr-1")
        assert counted(db_engine, suite, "run") == 0

    def test_keeps_a_machine_without_the_setting_however_long_it_is_inactive(
        self,
        api_client: TestClient,
        db_engine: Engine,
        submit: Callable[..., None],
        idle: Callable[[int], None],
    ) -> None:
        submit("linux", "abc")
        idle(36600)

        swept(db_engine)

        assert exists(api_client, f"{MACHINES}/linux")
        assert exists(api_client, f"{COMMITS}/abc")

    def test_keeps_a_machine_that_had_a_run_submitted_within_the_period(
        self,
        api_client: TestClient,
        db_engine: Engine,
        submit: Callable[..., None],
        idle: Callable[[int], None],
    ) -> None:
        submit({"name": "pr-1", "delete_after_inactive_days": 30}, "abc")
        idle(100)
        submit("pr-1", "def")
        idle(29)

        swept(db_engine)

        assert exists(api_client, f"{MACHINES}/pr-1")

    def test_counts_when_a_run_was_submitted_rather_than_measured(
        self,
        api_client: TestClient,
        db_engine: Engine,
        submit: Callable[..., None],
        idle: Callable[[int], None],
    ) -> None:
        # O10: data measured long ago and submitted today is activity today.
        submit({"name": "pr-1", "delete_after_inactive_days": 30}, "abc")
        idle(100)
        submit("pr-1", "def", measured_at="2020-01-01T00:00:00Z")

        swept(db_engine)

        assert exists(api_client, f"{MACHINES}/pr-1")

    def test_a_machine_without_runs_is_inactive_since_it_was_first_seen(
        self,
        api_client: TestClient,
        db_engine: Engine,
        manage: dict[str, str],
        suite: SuiteTables,
        idle: Callable[[int], None],
    ) -> None:
        for name in ("early", "late"):
            api_client.post(
                MACHINES, json={"name": name, "delete_after_inactive_days": 30}, headers=manage
            )
            idle(20)

        swept(db_engine)

        # Created 40 and 20 days ago.
        assert not exists(api_client, f"{MACHINES}/early")
        assert exists(api_client, f"{MACHINES}/late")

    def test_activity_is_the_later_of_first_seen_and_the_latest_run(
        self,
        api_client: TestClient,
        db_engine: Engine,
        suite: SuiteTables,
        submit: Callable[..., None],
        idle: Callable[[int], None],
    ) -> None:
        # A machine whose runs are older than its `first_seen_at`, which is what migrating gives
        # every machine that existed before (D5).
        submit({"name": "pr-1", "delete_after_inactive_days": 30}, "abc")
        idle(100)
        with db_engine.begin() as connection:
            connection.execute(update(suite.machine).values(first_seen_at=func.now()))

        swept(db_engine)

        assert exists(api_client, f"{MACHINES}/pr-1")

    def test_setting_it_on_an_entity_inactive_for_longer_makes_it_due_at_once(
        self,
        api_client: TestClient,
        db_engine: Engine,
        manage: dict[str, str],
        submit: Callable[..., None],
        idle: Callable[[int], None],
    ) -> None:
        submit("linux", "abc")
        idle(100)
        api_client.patch(
            f"{MACHINES}/linux", json={"delete_after_inactive_days": 30}, headers=manage
        )

        swept(db_engine)

        assert not exists(api_client, f"{MACHINES}/linux")

    def test_deletes_an_unordered_commit_and_its_runs_but_not_its_machine(
        self,
        api_client: TestClient,
        db_engine: Engine,
        suite: SuiteTables,
        submit: Callable[..., None],
        idle: Callable[[int], None],
    ) -> None:
        submit("linux", {"value": "pr-1", "delete_after_inactive_days": 30})
        submit("linux", "main")
        idle(31)

        assert swept(db_engine)[0].deleted["commit"] == ("pr-1",)

        assert not exists(api_client, f"{COMMITS}/pr-1")
        assert exists(api_client, f"{COMMITS}/main")
        assert exists(api_client, f"{MACHINES}/linux")
        assert counted(db_engine, suite, "run") == 1

    def test_never_deletes_a_commit_with_an_ordinal(
        self,
        api_client: TestClient,
        db_engine: Engine,
        manage: dict[str, str],
        submit: Callable[..., None],
        idle: Callable[[int], None],
    ) -> None:
        submit("linux", {"value": "abc", "ordinal": 1, "delete_after_inactive_days": 30})
        idle(31)

        swept(db_engine)
        assert exists(api_client, f"{COMMITS}/abc")

        # The setting applies again once the ordinal is cleared.
        api_client.patch(f"{COMMITS}/abc", json={"ordinal": None}, headers=manage)
        swept(db_engine)
        assert not exists(api_client, f"{COMMITS}/abc")


class TestDeletion:
    def test_a_deleted_commit_leaves_its_regressions_without_a_commit(
        self,
        api_client: TestClient,
        db_engine: Engine,
        triage: dict[str, str],
        submit: Callable[..., None],
        idle: Callable[[int], None],
    ) -> None:
        # O10: deleted exactly as `DELETE /commits/{value}` deletes it (D5).
        submit("linux", {"value": "pr-1", "delete_after_inactive_days": 30})
        created = api_client.post(REGRESSIONS, json={"commit": "pr-1"}, headers=triage).json()
        idle(31)

        swept(db_engine)

        assert api_client.get(f"{REGRESSIONS}/{created['uuid']}").json()["commit"] is None

    def test_a_deleted_machine_takes_its_regression_indicators_with_it(
        self,
        api_client: TestClient,
        db_engine: Engine,
        triage: dict[str, str],
        submit: Callable[..., None],
        idle: Callable[[int], None],
    ) -> None:
        submit({"name": "pr-1", "delete_after_inactive_days": 30}, "abc")
        indicator = {"machine": "pr-1", "test": "bench", "metric": "execution_time"}
        created = api_client.post(
            REGRESSIONS, json={"indicators": [indicator]}, headers=triage
        ).json()
        idle(31)

        swept(db_engine)

        assert api_client.get(f"{REGRESSIONS}/{created['uuid']}").json()["indicators"] == []

    def test_keeps_an_entity_that_gets_a_run_after_the_round_found_it(
        self,
        api_client: TestClient,
        db_engine: Engine,
        suite: SuiteTables,
        submit: Callable[..., None],
        idle: Callable[[int], None],
    ) -> None:
        # O10: eligibility is checked again, in the deleting transaction, after the entity is
        # locked. The steps of a round are taken one at a time to put a submission in between.
        submit({"name": "pr-1", "delete_after_inactive_days": 30}, "abc")
        idle(31)
        registered = SuiteRegistry()
        with db_engine.connect() as connection:
            nts = registered.resolve(connection, "nts", "nts")
            connection.commit()
            machines = inactivity._kinds(nts)[0]
            due = inactivity._due_entities(connection, nts, machines)
            assert due is not None and [identity for _, identity in due] == ["pr-1"]

            submit("pr-1", "def")

            [(identifier, identity)] = due
            assert (
                inactivity._delete_if_due(connection, nts, machines, identifier, identity) is False
            )

        assert exists(api_client, f"{MACHINES}/pr-1")

    def test_deletes_an_entity_renamed_after_the_round_found_it(
        self,
        api_client: TestClient,
        db_engine: Engine,
        manage: dict[str, str],
        submit: Callable[..., None],
        idle: Callable[[int], None],
    ) -> None:
        # A rename is not activity, so the machine is still due, under its new name: the round
        # addresses what it found by id rather than by name.
        submit({"name": "pr-1", "delete_after_inactive_days": 30}, "abc")
        idle(31)
        with db_engine.connect() as connection:
            nts = SuiteRegistry().resolve(connection, "nts", "nts")
            connection.commit()
            machines = inactivity._kinds(nts)[0]
            due = inactivity._due_entities(connection, nts, machines)
            assert due is not None
            [(identifier, identity)] = due

            api_client.patch(f"{MACHINES}/pr-1", json={"name": "pr-1-renamed"}, headers=manage)

            assert inactivity._delete_if_due(connection, nts, machines, identifier, identity)

        assert not exists(api_client, f"{MACHINES}/pr-1-renamed")


class TestRounds:
    def test_skips_the_round_while_another_process_sweeps(
        self, db_engine: Engine, suite: SuiteTables
    ) -> None:
        with db_engine.connect() as other:
            other.execute(text("SELECT pg_advisory_lock(:key)"), {"key": SWEEP_LOCK_KEY})
            try:
                assert sweep(db_engine, SuiteRegistry()) is None
            finally:
                other.execute(text("SELECT pg_advisory_unlock(:key)"), {"key": SWEEP_LOCK_KEY})

        assert sweep(db_engine, SuiteRegistry()) is not None

    def test_a_suite_that_fails_does_not_stop_the_others(
        self,
        api_client: TestClient,
        db_engine: Engine,
        make_api_suite: Callable[[dict[str, Any]], SuiteTables],
        submit: Callable[..., None],
        idle: Callable[[int], None],
    ) -> None:
        # Its tables vanish without its schema row, which the registry cannot tell from a suite
        # deleted while the round runs.
        broken = make_api_suite(NTS | {"name": "broken"})
        with db_engine.begin() as connection:
            connection.execute(text(f'DROP SCHEMA "{broken.namespace}" CASCADE'))
        submit({"name": "pr-1", "delete_after_inactive_days": 30}, "abc")
        idle(31)

        result = {suite.suite: suite for suite in swept(db_engine)}

        assert result["broken/broken"].failures == 2
        nts = result["nts/nts"]
        assert (nts.deleted["machine"], nts.failures) == (("pr-1",), 0)

    def test_stops_before_its_next_statement_once_asked_to(
        self,
        api_client: TestClient,
        db_engine: Engine,
        submit: Callable[..., None],
        idle: Callable[[int], None],
    ) -> None:
        submit({"name": "pr-1", "delete_after_inactive_days": 30}, "abc")
        idle(31)
        stopping = threading.Event()
        stopping.set()

        result = sweep(db_engine, SuiteRegistry(), stopping)

        assert result == []
        assert exists(api_client, f"{MACHINES}/pr-1")


class TestSweeper:
    def test_sweeps_periodically_in_the_background(
        self,
        api_client: TestClient,
        db_engine: Engine,
        submit: Callable[..., None],
        idle: Callable[[int], None],
    ) -> None:
        submit({"name": "pr-1", "delete_after_inactive_days": 30}, "abc")
        idle(31)
        sweeper = InactivitySweeper(db_engine, SuiteRegistry(), 0.05, first_round_delay=0)

        sweeper.start()
        try:
            deadline = time.monotonic() + 10
            while exists(api_client, f"{MACHINES}/pr-1") and time.monotonic() < deadline:
                time.sleep(0.05)
        finally:
            sweeper.stop()

        assert not exists(api_client, f"{MACHINES}/pr-1")

    @pytest.mark.parametrize(("interval", "running"), [(3600, True), (0, False)])
    def test_the_server_runs_one_unless_the_interval_is_zero(
        self, api_settings: Settings, interval: int, running: bool
    ) -> None:
        def sweepers() -> int:
            return sum(thread.name == "inactivity-sweeper" for thread in threading.enumerate())

        settings = api_settings.model_copy(update={"inactivity_sweep_interval": interval})
        before = sweepers()

        with TestClient(create_app(settings)):
            assert sweepers() == before + running

        assert sweepers() == before

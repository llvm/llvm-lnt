"""`GET /trends` (E9), over a real database: the geomeans are PostgreSQL's work. `GET /series` has
test_series.py."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

import pytest
from fastapi.testclient import TestClient

from conftest import code_of, entry, run_payload
from lnt_v5.routes.commits import COMMITS_PATH
from lnt_v5.routes.runs import RUNS_PATH
from lnt_v5.routes.suites import SUITES_PATH
from lnt_v5.routes.timeseries import TRENDS_PATH
from lnt_v5.suites.tables import SuiteTables

TRENDS = TRENDS_PATH.format(testsuite="nts")
RUNS = RUNS_PATH.format(testsuite="nts")
COMMITS = COMMITS_PATH.format(testsuite="nts")

# A `real` and an `integer` are numeric (D3), so a trend may be taken of either, and a `text` is
# not.
NTS: dict[str, Any] = {
    "name": "nts",
    "metrics": [
        {"name": "execution_time", "type": "real"},
        {"name": "compile_time", "type": "real"},
        {"name": "compile_status", "type": "integer"},
        {"name": "toolchain", "type": "text"},
    ],
}


@pytest.fixture
def suite(make_api_suite: Callable[[dict[str, Any]], SuiteTables]) -> SuiteTables:
    return make_api_suite(NTS)


@pytest.fixture
def submit(
    api_client: TestClient, submitter: dict[str, str], suite: SuiteTables
) -> Callable[..., dict[str, Any]]:
    """Submit one run and hand back its detail body.

    A submission is the only thing that creates a test (O1), and it creates the machine and the
    commit in the same breath, so every fixture below is built out of these.
    """

    def post(machine: str, commit: str, *tests: dict[str, Any], **overrides: Any) -> dict[str, Any]:
        body = run_payload(
            machine={"name": machine}, commit={"value": commit}, tests=list(tests), **overrides
        )
        response = api_client.post(RUNS, json=body, headers=submitter)
        assert response.status_code == 201, response.text
        return dict(response.json())

    return post


@pytest.fixture
def place(api_client: TestClient, manage: dict[str, str]) -> Callable[..., None]:
    """Give a commit an ordinal, and optionally a tag. PATCH is the only path to either (O6)."""

    def patch(commit: str, ordinal: int | None = None, tag: str | None = None) -> None:
        body: dict[str, Any] = {}
        if ordinal is not None:
            body["ordinal"] = ordinal
        if tag is not None:
            body["tag"] = tag
        response = api_client.patch(f"{COMMITS}/{commit}", json=body, headers=manage)
        assert response.status_code == 200, response.text

    return patch


def trend_query(api_client: TestClient, **params: Any) -> Any:
    return api_client.get(TRENDS, params=params)


def trends(api_client: TestClient, **params: Any) -> list[dict[str, Any]]:
    response = trend_query(api_client, **params)
    assert response.status_code == 200, response.text
    return list(response.json()["items"])


class TestTrends:
    def test_is_an_unpaginated_envelope_even_when_nothing_matches(
        self, api_client: TestClient, submit: Callable[..., dict[str, Any]]
    ) -> None:
        # The run's commit has no ordinal, so it has no place in a trend.
        submit("linux", "abc", entry("t", {"execution_time": 1.0}))

        response = trend_query(api_client, metric="execution_time", machine=["linux"])

        assert response.status_code == 200
        assert response.json() == {"items": []}

    def test_carries_exactly_the_six_keys_endpoints_md_gives_it(
        self,
        api_client: TestClient,
        submit: Callable[..., dict[str, Any]],
        place: Callable[..., None],
    ) -> None:
        run = submit("linux", "abc", entry("t", {"execution_time": 4.0}))
        place("abc", ordinal=7, tag="release-18.1")

        assert trends(api_client, metric="execution_time", machine=["linux"]) == [
            {
                "machine": "linux",
                "commit": "abc",
                "ordinal": 7,
                "measured_at": run["measured_at"],
                "tag": "release-18.1",
                "value": 4.0,
            }
        ]

    def test_is_the_geometric_mean_across_the_tests_at_that_machine_and_commit(
        self,
        api_client: TestClient,
        submit: Callable[..., dict[str, Any]],
        place: Callable[..., None],
    ) -> None:
        submit(
            "linux", "abc", entry("a", {"execution_time": 1.0}), entry("b", {"execution_time": 4.0})
        )
        place("abc", ordinal=1)

        assert trends(api_client, metric="execution_time", machine=["linux"])[0][
            "value"
        ] == pytest.approx(2.0)

    @pytest.mark.parametrize(("aggregation", "expected"), [(None, 2.0), ("max", 6.0)])
    def test_reduces_each_tests_samples_with_the_requested_aggregation(
        self,
        api_client: TestClient,
        submit: Callable[..., dict[str, Any]],
        place: Callable[..., None],
        aggregation: str | None,
        expected: float,
    ) -> None:
        # The median by default. test_summaries.py covers each aggregation and the per-test stage.
        submit(
            "linux",
            "abc",
            entry("t", {"execution_time": 6.0}, {"execution_time": 1.0}, {"execution_time": 2.0}),
        )
        place("abc", ordinal=1)
        requested = {} if aggregation is None else {"sample_agg": aggregation}

        served = trends(api_client, metric="execution_time", machine=["linux"], **requested)

        assert served[0]["value"] == pytest.approx(expected)

    def test_combines_the_runs_at_that_machine_and_commit_by_their_geomean(
        self,
        api_client: TestClient,
        submit: Callable[..., dict[str, Any]],
        place: Callable[..., None],
    ) -> None:
        # Several runs per machine and commit are legal (E4), and a trend point
        # covers all of them rather than one.
        # The run measured last is not the one submitted last.
        latest = "2026-01-01T00:00:00Z"
        submit("linux", "abc", entry("t", {"execution_time": 1.0}), measured_at=latest)
        submit(
            "linux", "abc", entry("t", {"execution_time": 9.0}), measured_at="2020-01-01T00:00:00Z"
        )
        place("abc", ordinal=1)

        item = trends(api_client, metric="execution_time", machine=["linux"])[0]

        assert item["value"] == pytest.approx(3.0)
        assert item["measured_at"] == latest

    def test_skips_the_zero_and_negative_values(
        self,
        api_client: TestClient,
        submit: Callable[..., dict[str, Any]],
        place: Callable[..., None],
    ) -> None:
        submit(
            "linux",
            "abc",
            entry("a", {"execution_time": 1.0}),
            entry("b", {"execution_time": 4.0}),
            entry("c", {"execution_time": 0.0}),
            entry("d", {"execution_time": -8.0}),
        )
        place("abc", ordinal=1)

        assert trends(api_client, metric="execution_time", machine=["linux"])[0][
            "value"
        ] == pytest.approx(2.0)

    def test_a_group_with_nothing_positive_is_absent_rather_than_null(
        self,
        api_client: TestClient,
        submit: Callable[..., dict[str, Any]],
        place: Callable[..., None],
    ) -> None:
        submit("linux", "good", entry("t", {"execution_time": 2.0}))
        submit("linux", "bad", entry("t", {"execution_time": -2.0}))
        place("good", ordinal=1)
        place("bad", ordinal=2)

        served = trends(api_client, metric="execution_time", machine=["linux"])

        assert [item["commit"] for item in served] == ["good"]

    def test_a_machine_with_no_geomean_under_the_aggregation_is_absent_at_that_commit(
        self,
        api_client: TestClient,
        submit: Callable[..., dict[str, Any]],
        place: Callable[..., None],
    ) -> None:
        # `linux` puts the commit in the window. `mac` has a summary of the metric there, but its
        # minimum is -1, so it has no geomean under `min`.
        submit("linux", "abc", entry("t", {"execution_time": 2.0}))
        submit("mac", "abc", entry("t", {"execution_time": -1.0}, {"execution_time": 3.0}))
        place("abc", ordinal=1)

        served = trends(
            api_client, metric="execution_time", machine=["linux", "mac"], sample_agg="min"
        )

        assert [item["machine"] for item in served] == ["linux"]

    def test_measured_at_covers_only_the_runs_with_a_geomean_under_the_aggregation(
        self,
        api_client: TestClient,
        submit: Callable[..., dict[str, Any]],
        place: Callable[..., None],
    ) -> None:
        # The run measured last has no geomean under `min`, so the value does not cover it.
        covered = "2020-01-01T00:00:00Z"
        submit("linux", "abc", entry("t", {"execution_time": 4.0}), measured_at=covered)
        submit(
            "linux",
            "abc",
            entry("t", {"execution_time": -1.0}, {"execution_time": 3.0}),
            measured_at="2026-01-01T00:00:00Z",
        )
        place("abc", ordinal=1)

        [item] = trends(api_client, metric="execution_time", machine=["linux"], sample_agg="min")

        assert item["value"] == pytest.approx(4.0)
        assert item["measured_at"] == covered

    def test_an_integer_metric_is_averaged_in_floating_point(
        self,
        api_client: TestClient,
        submit: Callable[..., dict[str, Any]],
        place: Callable[..., None],
    ) -> None:
        # D3: the geomean of integers is not an integer, and endpoints.md returns it as a real.
        submit("linux", "abc", entry("a", {"compile_status": 2}), entry("b", {"compile_status": 8}))
        place("abc", ordinal=1)

        assert trends(api_client, metric="compile_status", machine=["linux"])[0][
            "value"
        ] == pytest.approx(4.0)

    def test_excludes_the_commits_with_no_ordinal(
        self,
        api_client: TestClient,
        submit: Callable[..., dict[str, Any]],
        place: Callable[..., None],
    ) -> None:
        submit("linux", "ordered", entry("t", {"execution_time": 1.0}))
        submit("linux", "unordered", entry("t", {"execution_time": 2.0}))
        place("ordered", ordinal=1)

        served = trends(api_client, metric="execution_time", machine=["linux"])

        assert [item["commit"] for item in served] == ["ordered"]

    def test_orders_by_machine_and_then_by_ordinal(
        self,
        api_client: TestClient,
        submit: Callable[..., dict[str, Any]],
        place: Callable[..., None],
    ) -> None:
        for machine in ("linux", "darwin"):
            for index in (2, 1):
                submit(machine, f"c{index}", entry("t", {"execution_time": float(index)}))
        place("c1", ordinal=1)
        place("c2", ordinal=2)

        served = trends(api_client, metric="execution_time", machine=["linux", "darwin"])

        assert [(item["machine"], item["ordinal"]) for item in served] == [
            ("darwin", 1),
            ("darwin", 2),
            ("linux", 1),
            ("linux", 2),
        ]


class TestTrendsFilters:
    def test_the_machine_list_keeps_only_those_machines(
        self,
        api_client: TestClient,
        submit: Callable[..., dict[str, Any]],
        place: Callable[..., None],
    ) -> None:
        for machine in ("linux", "darwin", "windows"):
            submit(machine, "abc", entry("t", {"execution_time": 1.0}))
        place("abc", ordinal=1)

        served = trends(api_client, metric="execution_time", machine=["linux", "windows"])

        assert [item["machine"] for item in served] == ["linux", "windows"]

    def test_an_unknown_machine_is_404(self, api_client: TestClient, suite: SuiteTables) -> None:
        response = trend_query(api_client, metric="execution_time", machine=["nope"])

        assert response.status_code == 404
        assert code_of(response) == "not_found"

    def test_an_untracked_machine_is_returned_when_it_is_named(
        self,
        api_client: TestClient,
        manage: dict[str, str],
        submit: Callable[..., dict[str, Any]],
        place: Callable[..., None],
    ) -> None:
        # endpoints.md: `tracked` governs *automatic* selection (D5), and a machine named here was
        # chosen deliberately. The Dashboard applies the flag when it picks the names.
        submit("retired", "abc", entry("t", {"execution_time": 1.0}))
        place("abc", ordinal=1)
        patched = api_client.patch(
            f"{SUITES_PATH}/nts/machines/retired", json={"tracked": False}, headers=manage
        )
        assert patched.status_code == 200, patched.text

        assert [
            item["machine"]
            for item in trends(api_client, metric="execution_time", machine=["retired"])
        ] == ["retired"]

    def test_last_n_keeps_the_most_recent_commits_by_ordinal(
        self,
        api_client: TestClient,
        submit: Callable[..., dict[str, Any]],
        place: Callable[..., None],
    ) -> None:
        for index in range(5):
            submit("linux", f"c{index}", entry("t", {"execution_time": 1.0}))
            place(f"c{index}", ordinal=index)

        served = trends(api_client, metric="execution_time", machine=["linux"], last_n=2)

        assert [item["ordinal"] for item in served] == [3, 4]

    def test_last_n_larger_than_the_suite_keeps_everything(
        self,
        api_client: TestClient,
        submit: Callable[..., dict[str, Any]],
        place: Callable[..., None],
    ) -> None:
        # The cutoff is the Nth-highest ordinal, and there is none when the suite holds fewer than
        # N commits; that has to mean "keep everything" rather than "keep nothing". The omitted
        # case takes the same path, with `last_n` defaulting to DEFAULT_LAST_N.
        submit("linux", "abc", entry("t", {"execution_time": 1.0}))
        place("abc", ordinal=1)

        assert len(trends(api_client, metric="execution_time", machine=["linux"], last_n=1000)) == 1
        assert len(trends(api_client, metric="execution_time", machine=["linux"])) == 1

    def test_last_n_counts_only_the_commits_the_named_machines_have_a_value_at(
        self,
        api_client: TestClient,
        submitter: dict[str, str],
        submit: Callable[..., dict[str, Any]],
        place: Callable[..., None],
    ) -> None:
        for index in range(4):
            submit("linux", f"c{index}", entry("t", {"execution_time": 1.0}))
            place(f"c{index}", ordinal=index)
        # Newer commits that do not count: one with no run at all, one only another machine ran,
        # and two the machine ran without a positive value for the metric.
        created = api_client.post(COMMITS, json={"value": "c4", "ordinal": 4}, headers=submitter)
        assert created.status_code == 201, created.text
        submit("darwin", "c5", entry("t", {"execution_time": 1.0}))
        submit("linux", "c6", entry("t", {"compile_time": 1.0}))
        submit("linux", "c7", entry("t", {"execution_time": -1.0}))
        for index in (5, 6, 7):
            place(f"c{index}", ordinal=index)

        served = trends(api_client, metric="execution_time", machine=["linux"], last_n=2)

        assert [item["ordinal"] for item in served] == [2, 3]

    def test_last_n_counts_the_commits_with_a_geomean_under_the_requested_aggregation(
        self,
        api_client: TestClient,
        submit: Callable[..., dict[str, Any]],
        place: Callable[..., None],
    ) -> None:
        for index in range(3):
            submit("linux", f"c{index}", entry("t", {"execution_time": 1.0}))
            place(f"c{index}", ordinal=index)
        # A median of 1 but a minimum of -1, so only the median gives this commit a geomean.
        submit("linux", "c3", entry("t", {"execution_time": -1.0}, {"execution_time": 3.0}))
        place("c3", ordinal=3)

        def window(sample_agg: str) -> list[int]:
            served = trends(
                api_client,
                metric="execution_time",
                machine=["linux"],
                sample_agg=sample_agg,
                last_n=2,
            )
            return [item["ordinal"] for item in served]

        assert window("median") == [2, 3]
        assert window("min") == [1, 2]

    def test_last_n_is_one_window_for_all_the_named_machines(
        self,
        api_client: TestClient,
        submit: Callable[..., dict[str, Any]],
        place: Callable[..., None],
    ) -> None:
        # A machine that stopped reporting inside the window yields a trendline that stops, rather
        # than one stretched back over older commits.
        for index in range(4):
            submit("linux", f"c{index}", entry("t", {"execution_time": 1.0}))
            place(f"c{index}", ordinal=index)
        submit("retired", "c0", entry("t", {"execution_time": 1.0}))

        served = trends(api_client, metric="execution_time", machine=["linux", "retired"], last_n=2)

        assert [(item["machine"], item["ordinal"]) for item in served] == [
            ("linux", 2),
            ("linux", 3),
        ]

    @pytest.mark.parametrize("last_n", [0, 10001, "true", "2.5", "five"])
    def test_refuses_an_invalid_last_n(
        self, api_client: TestClient, suite: SuiteTables, last_n: Any
    ) -> None:
        response = trend_query(api_client, metric="execution_time", machine=["m"], last_n=last_n)

        assert response.status_code == 400
        assert code_of(response) == "invalid_request"

    def test_refuses_an_unknown_sample_aggregation(
        self, api_client: TestClient, suite: SuiteTables
    ) -> None:
        response = trend_query(api_client, metric="execution_time", machine=["m"], sample_agg="p90")

        assert response.status_code == 400
        assert code_of(response) == "invalid_request"


class TestTrendsMetric:
    def test_the_metric_is_required(self, api_client: TestClient, suite: SuiteTables) -> None:
        response = trend_query(api_client, machine=["m"])

        assert response.status_code == 400
        assert code_of(response) == "invalid_request"

    def test_the_machine_is_required(self, api_client: TestClient, suite: SuiteTables) -> None:
        response = trend_query(api_client, metric="execution_time")

        assert response.status_code == 400
        assert code_of(response) == "invalid_request"

    def test_an_undeclared_metric_is_400(self, api_client: TestClient, suite: SuiteTables) -> None:
        response = trend_query(api_client, metric="nope", machine=["m"])

        assert response.status_code == 400
        assert code_of(response) == "invalid_request"

    def test_a_non_numeric_metric_is_400(self, api_client: TestClient, suite: SuiteTables) -> None:
        # D3: a geomean is arithmetic, and `text` is not a number. The type system deliberately
        # goes no further than that -- an `integer` encoding an enum is the author's problem.
        response = trend_query(api_client, metric="toolchain", machine=["m"])

        assert response.status_code == 400
        assert code_of(response) == "invalid_request"

    def test_a_non_numeric_metric_beats_an_absent_machine(
        self, api_client: TestClient, suite: SuiteTables
    ) -> None:
        response = trend_query(api_client, metric="toolchain", machine=["also-nope"])

        assert response.status_code == 400


class TestAccess:
    """I5: `read`-scoped, so it allows an anonymous caller."""

    @pytest.fixture
    def call(
        self, api_client: TestClient, submit: Callable[..., dict[str, Any]]
    ) -> Callable[..., Any]:
        """The smallest request the endpoint accepts, which is all these tests need."""
        submit("linux", "abc")

        def call(suite: str = "nts", **kwargs: Any) -> Any:
            target = TRENDS.replace("/nts/", f"/{suite}/")
            params = {"metric": "execution_time", "machine": "linux"}
            return api_client.get(target, params=params, **kwargs)

        return call

    def test_needs_no_credential(self, call: Callable[..., Any]) -> None:
        assert call().status_code == 200

    def test_a_bad_token_is_401_even_though_the_endpoint_is_read_scoped(
        self, call: Callable[..., Any], bearer: Callable[[str], dict[str, str]]
    ) -> None:
        # I5: a bad credential is never silently downgraded to anonymous access.
        response = call(headers=bearer("f" * 64))

        assert response.status_code == 401
        assert code_of(response) == "unauthorized"

    def test_is_404_for_a_suite_that_is_not_there(self, call: Callable[..., Any]) -> None:
        response = call(suite="nope")

        assert response.status_code == 404
        assert code_of(response) == "not_found"

    def test_is_not_shadowed_by_the_spa_catch_all(self, call: Callable[..., Any]) -> None:
        assert "<title>LNT</title>" not in call().text

"""The sample list (endpoints.md, Samples).

Driven over the real application and a real database. Most of what is interesting here is the shape
of one object -- R4's exception that `metrics` carries only the metrics that have a value -- and the
`test=` filter, which exists because a test name cannot be a path segment (R1): it legitimately
contains `/`, and a server decodes `%2F` back to a separator before routing. The test named
`suite/one` below is not incidental; addressing it is the thing the filter has to make possible.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

from conftest import code_of, run_payload, walk_pages
from lnt_v5.routes.commits import COMMITS_PATH
from lnt_v5.routes.runs import RUNS_PATH
from lnt_v5.routes.samples import SAMPLES_PATH
from lnt_v5.routes.suites import SUITES_PATH
from lnt_v5.suites.tables import SuiteTables

RUNS = RUNS_PATH.format(testsuite="nts")
COMMITS = COMMITS_PATH.format(testsuite="nts")

# One metric of every declared type (D3), so that `metrics` can be checked for the JSON
# representation R4 gives each rather than only for the two numeric ones.
NTS: dict[str, Any] = {
    "name": "nts",
    "metrics": [
        {"name": "execution_time", "type": "real"},
        {"name": "compile_time", "type": "real"},
        {"name": "compile_status", "type": "integer"},
        {"name": "toolchain", "type": "text"},
        {"name": "started_at", "type": "datetime"},
    ],
}

# A name with a slash in it, which is what D6 and R1 use as the example throughout, and what no
# path segment could ever carry.
SLASHED = "suite/one"


@pytest.fixture
def suite(make_api_suite: Callable[[dict[str, Any]], SuiteTables]) -> SuiteTables:
    return make_api_suite(NTS)


@pytest.fixture
def submit(
    api_client: TestClient, submitter: dict[str, str], suite: SuiteTables
) -> Callable[..., str]:
    """Submit a run with the given test entries and hand back its UUID."""

    def post(*tests: dict[str, Any]) -> str:
        response = api_client.post(RUNS, json=run_payload(tests=list(tests)), headers=submitter)
        assert response.status_code == 201, response.text
        return str(response.json()["uuid"])

    return post


def samples_of(run: str) -> str:
    return SAMPLES_PATH.format(testsuite="nts", uuid=run)


def listed(api_client: TestClient, run: str, query: str = "") -> Any:
    return api_client.get(f"{samples_of(run)}?{query}")


def walk(api_client: TestClient, run: str, query: str = "") -> list[dict[str, Any]]:
    """Every sample the list serves, following cursors to the end."""
    return walk_pages(api_client, samples_of(run), query)


class TestList:
    def test_is_a_cursor_envelope_even_for_a_run_that_measured_nothing(
        self, api_client: TestClient, submit: Callable[..., str]
    ) -> None:
        run = submit()

        response = listed(api_client, run)

        assert response.status_code == 200
        assert response.json() == {"items": [], "cursor": {"next": None, "previous": None}}

    def test_carries_the_test_name_and_the_metrics(
        self, api_client: TestClient, submit: Callable[..., str]
    ) -> None:
        run = submit({"name": SLASHED, "execution_time": 1.25, "compile_status": 0})

        assert listed(api_client, run).json()["items"] == [
            {"test": SLASHED, "metrics": {"execution_time": 1.25, "compile_status": 0}}
        ]

    def test_omits_the_metrics_with_no_value(
        self, api_client: TestClient, submit: Callable[..., str]
    ) -> None:
        # R4's stated exception: unlike a `fields` dict, `metrics` does not carry a null per
        # declared key. A suite's metric list is long and any one test populates little of it.
        run = submit({"name": "t", "execution_time": 1.25})

        assert listed(api_client, run).json()["items"] == [
            {"test": "t", "metrics": {"execution_time": 1.25}}
        ]

    def test_a_run_that_measured_a_test_and_no_metric_is_still_a_sample(
        self, api_client: TestClient, submit: Callable[..., str]
    ) -> None:
        # D6: an entry carrying nothing but a name still records that the test ran.
        run = submit({"name": "t"})

        assert listed(api_client, run).json()["items"] == [{"test": "t", "metrics": {}}]

    def test_repetitions_are_separate_and_indistinguishable(
        self, api_client: TestClient, submit: Callable[..., str]
    ) -> None:
        # D6: an array value is one sample per element, and endpoints.md makes those repetitions
        # indistinguishable by design -- nothing in the object tells them apart, so a test may only
        # ask what the set of them is.
        run = submit({"name": "t", "execution_time": [1.0, 2.0], "compile_time": 0.5})

        items = listed(api_client, run).json()["items"]

        assert sorted(items, key=repr) == sorted(
            [
                {"test": "t", "metrics": {"execution_time": 1.0, "compile_time": 0.5}},
                {"test": "t", "metrics": {"execution_time": 2.0, "compile_time": 0.5}},
            ],
            key=repr,
        )

    def test_covers_every_test_the_run_measured(
        self, api_client: TestClient, submit: Callable[..., str]
    ) -> None:
        run = submit({"name": "a"}, {"name": "b"}, {"name": "c"})

        assert {item["test"] for item in listed(api_client, run).json()["items"]} == {"a", "b", "c"}

    def test_serves_only_this_runs_samples(
        self, api_client: TestClient, submit: Callable[..., str]
    ) -> None:
        mine = submit({"name": "a"})
        submit({"name": "b"})

        assert [item["test"] for item in listed(api_client, mine).json()["items"]] == ["a"]

    def test_values_keep_the_type_the_schema_declares(
        self, api_client: TestClient, submit: Callable[..., str]
    ) -> None:
        # D3 and R4: a value uses the JSON representation of its declared type and is never
        # stringified, so an integer comes back an integer rather than "3".
        run = submit(
            {
                "name": "t",
                "execution_time": 1.5,
                "compile_status": 3,
                "toolchain": "clang-21",
                "started_at": "2026-04-01T12:00:00Z",
            }
        )

        assert listed(api_client, run).json()["items"][0]["metrics"] == {
            "execution_time": 1.5,
            "compile_status": 3,
            "toolchain": "clang-21",
            "started_at": "2026-04-01T12:00:00Z",
        }

    def test_accepts_the_run_uuid_in_either_case(
        self, api_client: TestClient, submit: Callable[..., str]
    ) -> None:
        run = submit({"name": "t"})

        assert listed(api_client, run.upper()).json() == listed(api_client, run).json()

    def test_is_404_for_a_run_that_is_not_there(
        self, api_client: TestClient, suite: SuiteTables
    ) -> None:
        response = listed(api_client, str(uuid4()))

        assert response.status_code == 404
        assert code_of(response) == "not_found"

    def test_is_404_for_a_suite_that_is_not_there(self, api_client: TestClient) -> None:
        assert api_client.get(f"{SUITES_PATH}/nope/runs/{uuid4()}/samples").status_code == 404

    def test_needs_no_credential(self, api_client: TestClient, submit: Callable[..., str]) -> None:
        run = submit({"name": "t"})

        assert listed(api_client, run).status_code == 200

    def test_is_not_shadowed_by_the_spa_catch_all(
        self, api_client: TestClient, submit: Callable[..., str]
    ) -> None:
        run = submit({"name": "t"})

        assert "<title>LNT</title>" not in listed(api_client, run).text


class TestTestFilter:
    """The filter that replaces the path segment a test name cannot occupy (R1)."""

    def test_keeps_only_that_tests_samples(
        self, api_client: TestClient, submit: Callable[..., str]
    ) -> None:
        run = submit({"name": "a", "execution_time": 1.0}, {"name": "b", "execution_time": 2.0})

        items = listed(api_client, run, "test=a").json()["items"]

        assert items == [{"test": "a", "metrics": {"execution_time": 1.0}}]

    def test_addresses_a_test_name_containing_a_slash(
        self, api_client: TestClient, submit: Callable[..., str]
    ) -> None:
        # The whole reason this is a query parameter: `/runs/{uuid}/tests/suite%2Fone/samples`
        # decodes back to a path separator before routing and reaches no route at all.
        run = submit({"name": SLASHED, "execution_time": 1.0}, {"name": "other"})

        items = listed(api_client, run, f"test={SLASHED}").json()["items"]

        assert items == [{"test": SLASHED, "metrics": {"execution_time": 1.0}}]

    def test_keeps_every_repetition_of_that_test(
        self, api_client: TestClient, submit: Callable[..., str]
    ) -> None:
        run = submit({"name": "a", "execution_time": [1.0, 2.0, 3.0]}, {"name": "b"})

        assert len(listed(api_client, run, "test=a").json()["items"]) == 3

    def test_a_test_this_run_did_not_measure_is_an_empty_page(
        self, api_client: TestClient, submit: Callable[..., str]
    ) -> None:
        # endpoints.md: the test exists in the suite, so this is an ordinary empty answer rather
        # than an error -- the same treatment a `machine=` naming a machine with no runs gets.
        submit({"name": "elsewhere"})
        run = submit({"name": "here"})

        response = listed(api_client, run, "test=elsewhere")

        assert response.status_code == 200
        assert response.json()["items"] == []

    def test_is_404_for_a_test_the_suite_has_never_seen(
        self, api_client: TestClient, submit: Callable[..., str]
    ) -> None:
        # R3: filtering by a nonexistent test name is 404, exactly as a nonexistent machine is.
        run = submit({"name": "t"})

        response = listed(api_client, run, "test=nope")

        assert response.status_code == 404
        assert code_of(response) == "not_found"

    def test_the_run_is_resolved_before_the_filter(
        self, api_client: TestClient, submit: Callable[..., str]
    ) -> None:
        # Both are 404s, but the one the path names is the one to report.
        submit({"name": "t"})

        response = listed(api_client, str(uuid4()), "test=t")

        assert response.status_code == 404
        assert "run" in response.json()["error"]["message"]


class TestPagination:
    @pytest.fixture
    def run(self, submit: Callable[..., str]) -> str:
        return submit(*({"name": f"t{index}", "execution_time": 1.0} for index in range(7)))

    def test_serves_one_page_at_a_time(self, api_client: TestClient, run: str) -> None:
        response = listed(api_client, run, "limit=3")

        assert len(response.json()["items"]) == 3
        assert response.json()["cursor"]["next"] is not None

    def test_pages_cover_every_sample_exactly_once(self, api_client: TestClient, run: str) -> None:
        served = [item["test"] for item in walk(api_client, run, "limit=2")]

        assert sorted(served) == [f"t{index}" for index in range(7)]

    def test_pages_the_repetitions_of_one_test_too(
        self, api_client: TestClient, submit: Callable[..., str]
    ) -> None:
        run = submit({"name": "t", "execution_time": [1.0, 2.0, 3.0, 4.0, 5.0]})

        served = walk(api_client, run, "test=t&limit=2")

        assert sorted(item["metrics"]["execution_time"] for item in served) == [
            1.0,
            2.0,
            3.0,
            4.0,
            5.0,
        ]

    def test_the_filter_survives_a_page_boundary(
        self, api_client: TestClient, submit: Callable[..., str]
    ) -> None:
        run = submit({"name": "a", "execution_time": [1.0] * 5}, {"name": "b"})

        served = walk(api_client, run, "test=a&limit=2")

        assert [item["test"] for item in served] == ["a"] * 5

    def test_refuses_a_cursor_issued_for_another_entitys_list(
        self, api_client: TestClient, run: str
    ) -> None:
        cursor = listed(api_client, run, "limit=2").json()["cursor"]["next"]

        response = api_client.get(f"{COMMITS}?limit=2&cursor={cursor}")

        assert response.status_code == 400
        assert code_of(response) == "invalid_request"

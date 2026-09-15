"""The test list (endpoints.md, Tests).

Driven over the real application and a real database. A test is a name and nothing else, so what is
worth checking here is the three filters -- and in particular that two of them ask a question about
samples (`machine=`, `metric=`) rather than about tests, and that R3's three different answers to a
filter naming something absent all come out right: 404 for a machine, 400 for a metric, and an empty
page for a combination nothing matches.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

import pytest
from fastapi.testclient import TestClient

from conftest import code_of, run_payload, walk_pages
from lnt_v5.routes.commits import COMMITS_PATH
from lnt_v5.routes.runs import RUNS_PATH
from lnt_v5.routes.suites import SUITES_PATH
from lnt_v5.routes.tests import TESTS_PATH
from lnt_v5.suites.tables import SuiteTables

TESTS = TESTS_PATH.format(testsuite="nts")
RUNS = RUNS_PATH.format(testsuite="nts")
COMMITS = COMMITS_PATH.format(testsuite="nts")

NTS: dict[str, Any] = {
    "name": "nts",
    "metrics": [
        {"name": "execution_time", "type": "real"},
        {"name": "compile_time", "type": "real"},
    ],
}


@pytest.fixture
def suite(make_api_suite: Callable[[dict[str, Any]], SuiteTables]) -> SuiteTables:
    return make_api_suite(NTS)


@pytest.fixture
def submit(
    api_client: TestClient, submitter: dict[str, str], suite: SuiteTables
) -> Callable[..., None]:
    """Submit a run, which is the only thing that creates a test (D6)."""

    def post(*tests: dict[str, Any], machine: str = "linux") -> None:
        body = run_payload(machine={"name": machine}, tests=list(tests))
        response = api_client.post(RUNS, json=body, headers=submitter)
        assert response.status_code == 201, response.text

    return post


def listed(api_client: TestClient, query: str = "") -> Any:
    return api_client.get(f"{TESTS}?{query}")


def names_in(response: Any) -> list[str]:
    return [item["name"] for item in response.json()["items"]]


def walk(api_client: TestClient, query: str = "") -> list[str]:
    """Every test the list serves, following cursors to the end."""
    return [item["name"] for item in walk_pages(api_client, TESTS, query)]


class TestList:
    def test_is_a_cursor_envelope_even_when_nothing_matches(
        self, api_client: TestClient, suite: SuiteTables
    ) -> None:
        response = listed(api_client)

        assert response.status_code == 200
        assert response.json() == {"items": [], "cursor": {"next": None, "previous": None}}

    def test_carries_an_object_around_the_name(
        self, api_client: TestClient, submit: Callable[..., None]
    ) -> None:
        # endpoints.md: an object rather than a bare string, so the list can gain a key later.
        submit({"name": "suite/one"})

        assert listed(api_client).json()["items"] == [{"name": "suite/one"}]

    def test_lists_the_tests_submission_created(
        self, api_client: TestClient, submit: Callable[..., None]
    ) -> None:
        submit({"name": "a"}, {"name": "b"})
        submit({"name": "c"})

        assert sorted(names_in(listed(api_client))) == ["a", "b", "c"]

    def test_names_a_test_once_however_many_runs_measured_it(
        self, api_client: TestClient, submit: Callable[..., None]
    ) -> None:
        # The filters are EXISTS subqueries rather than joins for exactly this reason.
        submit({"name": "a", "execution_time": [1.0, 2.0]})
        submit({"name": "a", "execution_time": 3.0})

        assert names_in(listed(api_client)) == ["a"]

    def test_keeps_a_test_whose_samples_were_all_deleted(
        self,
        api_client: TestClient,
        submit: Callable[..., None],
        manage: dict[str, str],
    ) -> None:
        # D5: nothing deletes a test, so deleting every run that measured it leaves it behind.
        submit({"name": "a"})
        uuid = api_client.get(f"{RUNS}").json()["items"][0]["uuid"]

        assert api_client.delete(f"{RUNS}/{uuid}", headers=manage).status_code == 204
        assert names_in(listed(api_client)) == ["a"]

    def test_needs_no_credential(self, api_client: TestClient, submit: Callable[..., None]) -> None:
        submit({"name": "a"})

        assert listed(api_client).status_code == 200

    def test_is_404_for_a_suite_that_is_not_there(self, api_client: TestClient) -> None:
        assert api_client.get(f"{SUITES_PATH}/nope/tests").status_code == 404

    def test_is_not_shadowed_by_the_spa_catch_all(
        self, api_client: TestClient, suite: SuiteTables
    ) -> None:
        assert "<title>LNT</title>" not in listed(api_client).text


class TestSearch:
    @pytest.fixture(autouse=True)
    def tests(self, submit: Callable[..., None]) -> None:
        submit({"name": "suite/BenchmarkOne"}, {"name": "suite/other"}, {"name": "100%/odd"})

    def test_matches_a_substring_of_the_name(self, api_client: TestClient) -> None:
        assert names_in(listed(api_client, "search=Bench")) == ["suite/BenchmarkOne"]

    def test_is_case_insensitive(self, api_client: TestClient) -> None:
        assert names_in(listed(api_client, "search=benchmarkone")) == ["suite/BenchmarkOne"]

    def test_is_a_substring_match_rather_than_a_prefix(self, api_client: TestClient) -> None:
        assert names_in(listed(api_client, "search=markOne")) == ["suite/BenchmarkOne"]

    def test_treats_a_wildcard_in_the_term_literally(self, api_client: TestClient) -> None:
        assert names_in(listed(api_client, "search=100%")) == ["100%/odd"]


class TestMachineFilter:
    def test_keeps_only_tests_with_data_on_that_machine(
        self, api_client: TestClient, submit: Callable[..., None]
    ) -> None:
        submit({"name": "a"}, machine="linux")
        submit({"name": "b"}, machine="darwin")

        assert names_in(listed(api_client, "machine=linux")) == ["a"]

    def test_is_404_for_a_machine_that_is_not_there(
        self, api_client: TestClient, suite: SuiteTables
    ) -> None:
        response = listed(api_client, "machine=nope")

        assert response.status_code == 404
        assert code_of(response) == "not_found"


class TestMetricFilter:
    def test_keeps_only_tests_with_a_value_for_that_metric(
        self, api_client: TestClient, submit: Callable[..., None]
    ) -> None:
        submit({"name": "a", "execution_time": 1.0}, {"name": "b", "compile_time": 2.0})

        assert names_in(listed(api_client, "metric=execution_time")) == ["a"]

    def test_drops_a_test_that_ran_without_that_metric(
        self, api_client: TestClient, submit: Callable[..., None]
    ) -> None:
        # D6: an entry with no metric values still produces a sample row, and every metric on it
        # is NULL. The filter asks for non-NULL, so such a test does not match.
        submit({"name": "a"})

        assert names_in(listed(api_client, "metric=execution_time")) == []

    def test_is_400_for_a_metric_the_schema_does_not_declare(
        self, api_client: TestClient, suite: SuiteTables
    ) -> None:
        # R3: an unknown metric is 400, not the 404 an unknown machine or test gets -- a metric is
        # a column the schema declares rather than a row the suite holds.
        response = listed(api_client, "metric=nope")

        assert response.status_code == 400
        assert code_of(response) == "invalid_request"

    def test_the_rejection_lists_what_the_suite_does_declare(
        self, api_client: TestClient, suite: SuiteTables
    ) -> None:
        message = listed(api_client, "metric=nope").json()["error"]["message"]

        assert "execution_time" in message and "compile_time" in message

    def test_a_metric_name_is_not_read_as_sql(
        self, api_client: TestClient, suite: SuiteTables
    ) -> None:
        # The filter names a column, so a value that is not a declared metric must never reach the
        # query at all.
        response = listed(api_client, "metric=1) OR (1=1")

        assert response.status_code == 400
        assert code_of(response) == "invalid_request"


class TestFiltersTogether:
    @pytest.fixture(autouse=True)
    def tests(self, submit: Callable[..., None]) -> None:
        submit({"name": "both", "execution_time": 1.0}, machine="linux")
        submit({"name": "wrong_machine", "execution_time": 1.0}, machine="darwin")
        submit({"name": "wrong_metric", "compile_time": 1.0}, machine="linux")

    def test_describe_one_set_of_samples_rather_than_two(self, api_client: TestClient) -> None:
        # endpoints.md: `?machine=m&metric=x` asks which tests have an `x` value *on that machine*.
        assert names_in(listed(api_client, "machine=linux&metric=execution_time")) == ["both"]

    def test_a_test_measured_elsewhere_with_that_metric_does_not_qualify(
        self, api_client: TestClient, submit: Callable[..., None]
    ) -> None:
        # The independent reading would let this through: it has data on linux, and it has an
        # `execution_time` somewhere. It has no `execution_time` on linux.
        submit({"name": "split", "compile_time": 1.0}, machine="linux")
        submit({"name": "split", "execution_time": 1.0}, machine="darwin")

        assert "split" not in names_in(listed(api_client, "machine=linux&metric=execution_time"))

    def test_combine_with_search(self, api_client: TestClient) -> None:
        query = "machine=linux&metric=execution_time&search=nothing"

        assert names_in(listed(api_client, query)) == []


class TestPagination:
    @pytest.fixture(autouse=True)
    def tests(self, submit: Callable[..., None]) -> list[str]:
        names = [f"t{index}" for index in range(7)]
        submit(*({"name": name, "execution_time": 1.0} for name in names))
        return names

    def test_serves_one_page_at_a_time(self, api_client: TestClient) -> None:
        response = listed(api_client, "limit=3")

        assert len(response.json()["items"]) == 3
        assert response.json()["cursor"]["next"] is not None

    def test_pages_cover_every_test_exactly_once(
        self, api_client: TestClient, tests: list[str]
    ) -> None:
        assert sorted(walk(api_client, "limit=2")) == sorted(tests)

    def test_the_filters_survive_a_page_boundary(
        self, api_client: TestClient, submit: Callable[..., None], tests: list[str]
    ) -> None:
        submit(*({"name": f"other{index}"} for index in range(4)), machine="darwin")

        assert sorted(walk(api_client, "machine=linux&limit=2")) == sorted(tests)

    def test_refuses_a_cursor_issued_for_another_entitys_list(self, api_client: TestClient) -> None:
        cursor = listed(api_client, "limit=2").json()["cursor"]["next"]

        response = api_client.get(f"{COMMITS}?limit=2&cursor={cursor}")

        assert response.status_code == 400
        assert code_of(response) == "invalid_request"

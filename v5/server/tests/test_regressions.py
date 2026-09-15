"""Regressions and their indicators (endpoints.md, Regressions).

Driven over the real application and a real database. Four things get most of the attention here,
because they are the four the specification is most specific about and an implementation is most
likely to get subtly wrong.

The state is stored as an integer and spoken as a string, so every route that carries one is checked
against the string.

The list item and the detail body carry *different* sets of keys, and both are checked exactly
rather than by inclusion -- `notes` leaking into a list would be as wrong as it going missing from a
detail.

`machine_count` and `test_count` count over all of a regression's indicators whatever the request
filtered by, which is the one statement in the spec that a natural implementation gets wrong.

And the two indicator routes are deliberately forgiving: adding one that already exists and removing
one that is not there are both successes, so a client that retries either is not punished for it.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import Engine, func, select

from conftest import code_of, run_payload, uuids_in, walk_pages
from lnt_v5.routes.commits import COMMITS_PATH
from lnt_v5.routes.machines import MACHINES_PATH
from lnt_v5.routes.regressions import REGRESSIONS_PATH
from lnt_v5.routes.runs import RUNS_PATH
from lnt_v5.routes.suites import SUITES_PATH
from lnt_v5.suites.states import RegressionState, RegressionStateName
from lnt_v5.suites.tables import SuiteTables

REGRESSIONS = REGRESSIONS_PATH.format(testsuite="nts")
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

# One indicator's worth of names, as every test that needs a valid one spells it.
LINUX_ONE = {"machine": "linux", "test": "suite/one", "metric": "execution_time"}
LINUX_TWO = {"machine": "linux", "test": "suite/two", "metric": "execution_time"}
DARWIN_ONE = {"machine": "darwin", "test": "suite/one", "metric": "execution_time"}

# Every route here that is not a GET, with a body it would accept, as the two authorization tests
# walk them. One table rather than one per test, so that a route added to one and not the other
# cannot silently lose its 401 or its 403 coverage.
WRITES: list[tuple[str, str, dict[str, Any] | None]] = [
    ("POST", "", {}),
    ("PATCH", "/{uuid}", {"title": "t"}),
    ("DELETE", "/{uuid}", None),
    ("POST", "/{uuid}/indicators", {"indicators": [LINUX_ONE]}),
    ("DELETE", "/{uuid}/indicators", {"indicator_uuids": ["x"]}),
]


@pytest.fixture
def suite(make_api_suite: Callable[[dict[str, Any]], SuiteTables]) -> SuiteTables:
    return make_api_suite(NTS)


@pytest.fixture
def data(api_client: TestClient, submitter: dict[str, str], suite: SuiteTables) -> None:
    """The machines, tests and commits an indicator can name.

    Through a run submission, because that is the only thing that creates a test (D6), and because
    it creates the machine and the commit in the same breath.
    """
    for machine in ("linux", "darwin"):
        body = run_payload(
            machine={"name": machine},
            commit={"value": "abc123"},
            tests=[
                {"name": "suite/one", "execution_time": 1.0},
                {"name": "suite/two", "execution_time": 2.0},
            ],
        )
        assert api_client.post(RUNS, json=body, headers=submitter).status_code == 201


@pytest.fixture
def create(
    api_client: TestClient, triage: dict[str, str], suite: SuiteTables
) -> Callable[..., Any]:
    """Create a regression and hand back its detail body."""

    def post(**body: Any) -> Any:
        response = api_client.post(REGRESSIONS, json=body, headers=triage)
        assert response.status_code == 201, response.text
        return response.json()

    return post


def listed(api_client: TestClient, query: str = "") -> Any:
    return api_client.get(f"{REGRESSIONS}?{query}")


class TestStates:
    def test_the_two_spellings_name_the_same_five_states(self) -> None:
        """D5 stores an integer and the API speaks a string, paired by the member's name.

        The pairing is what `RegressionStateName.stored` and `.of` walk, so a member added to one
        enum and forgotten in the other would be a state that cannot be stored, or cannot be
        rendered.
        """
        assert [state.name for state in RegressionStateName] == [
            state.name for state in RegressionState
        ]


class TestCreate:
    def test_needs_nothing_at_all(self, create: Callable[..., Any]) -> None:
        # A triager opens a regression before it knows what it is looking at.
        created = create()

        assert created["title"] is None
        assert created["bug"] is None
        assert created["notes"] is None
        assert created["commit"] is None
        assert created["indicators"] == []

    def test_defaults_to_detected(self, create: Callable[..., Any]) -> None:
        assert create()["state"] == "detected"

    def test_returns_the_detail_body(self, create: Callable[..., Any], data: None) -> None:
        created = create(
            title="find_if slowdown",
            bug="https://github.com/llvm/llvm-project/issues/1",
            notes="bisected to abc123",
            state="active",
            commit="abc123",
            indicators=[LINUX_ONE],
        )

        assert set(created) == {"uuid", "title", "bug", "notes", "state", "commit", "indicators"}
        assert created["title"] == "find_if slowdown"
        assert created["bug"] == "https://github.com/llvm/llvm-project/issues/1"
        assert created["notes"] == "bisected to abc123"
        assert created["state"] == "active"
        assert created["commit"] == "abc123"

    def test_answers_201_with_a_location_header(
        self, api_client: TestClient, triage: dict[str, str], suite: SuiteTables
    ) -> None:
        response = api_client.post(REGRESSIONS, json={}, headers=triage)

        assert response.status_code == 201
        assert response.headers["Location"] == f"{REGRESSIONS}/{response.json()['uuid']}"

    def test_the_location_header_reads_the_regression_back(
        self, api_client: TestClient, triage: dict[str, str], suite: SuiteTables
    ) -> None:
        created = api_client.post(REGRESSIONS, json={"title": "x"}, headers=triage)

        assert api_client.get(created.headers["Location"]).json() == created.json()

    def test_mints_a_uuid_the_client_cannot_choose(
        self, api_client: TestClient, triage: dict[str, str], suite: SuiteTables
    ) -> None:
        # R1: a run's UUID may be client-provided; every other UUID in the API is the server's.
        response = api_client.post(
            REGRESSIONS, json={"uuid": "e6c9ba0a-0000-4000-8000-000000000000"}, headers=triage
        )

        assert response.status_code == 400
        assert code_of(response) == "invalid_request"

    def test_two_regressions_get_two_uuids(self, create: Callable[..., Any]) -> None:
        assert create()["uuid"] != create()["uuid"]

    def test_stores_the_indicators_it_was_given(
        self, create: Callable[..., Any], data: None
    ) -> None:
        created = create(indicators=[LINUX_ONE, DARWIN_ONE])

        assert [
            {key: indicator[key] for key in ("machine", "test", "metric")}
            for indicator in created["indicators"]
        ] == [LINUX_ONE, DARWIN_ONE]

    def test_gives_every_indicator_a_uuid(self, create: Callable[..., Any], data: None) -> None:
        created = create(indicators=[LINUX_ONE, DARWIN_ONE])

        uuids = {indicator["uuid"] for indicator in created["indicators"]}
        assert len(uuids) == 2

    def test_stores_a_repeated_indicator_once(self, create: Callable[..., Any], data: None) -> None:
        # D5's unique constraint would collapse these anyway; collapsing them before the insert is
        # what keeps the count honest.
        assert len(create(indicators=[LINUX_ONE, LINUX_ONE])["indicators"]) == 1

    def test_is_404_for_a_commit_that_is_not_there(
        self, api_client: TestClient, triage: dict[str, str], suite: SuiteTables
    ) -> None:
        response = api_client.post(REGRESSIONS, json={"commit": "nope"}, headers=triage)

        assert response.status_code == 404
        assert code_of(response) == "not_found"

    def test_is_404_for_a_machine_that_is_not_there(
        self, api_client: TestClient, triage: dict[str, str], data: None
    ) -> None:
        body = {"indicators": [{**LINUX_ONE, "machine": "nope"}]}

        response = api_client.post(REGRESSIONS, json=body, headers=triage)

        assert response.status_code == 404
        assert code_of(response) == "not_found"

    def test_is_404_for_a_test_that_is_not_there(
        self, api_client: TestClient, triage: dict[str, str], data: None
    ) -> None:
        body = {"indicators": [{**LINUX_ONE, "test": "nope"}]}

        response = api_client.post(REGRESSIONS, json=body, headers=triage)

        assert response.status_code == 404
        assert code_of(response) == "not_found"

    def test_is_400_for_a_metric_the_schema_does_not_declare(
        self, api_client: TestClient, triage: dict[str, str], data: None
    ) -> None:
        # R3: a metric names a column the schema declares rather than a row the suite holds, so an
        # unknown one is a bad request rather than a missing entity.
        body = {"indicators": [{**LINUX_ONE, "metric": "nope"}]}

        response = api_client.post(REGRESSIONS, json=body, headers=triage)

        assert response.status_code == 400
        assert code_of(response) == "invalid_request"

    def test_the_rejected_metric_lists_what_the_suite_does_declare(
        self, api_client: TestClient, triage: dict[str, str], data: None
    ) -> None:
        body = {"indicators": [{**LINUX_ONE, "metric": "nope"}]}

        message = api_client.post(REGRESSIONS, json=body, headers=triage).json()["error"]["message"]

        assert "execution_time" in message and "compile_time" in message

    def test_is_400_for_a_state_that_is_not_one_of_the_five(
        self, api_client: TestClient, triage: dict[str, str], suite: SuiteTables
    ) -> None:
        response = api_client.post(REGRESSIONS, json={"state": "wontfix"}, headers=triage)

        assert response.status_code == 400
        assert code_of(response) == "invalid_request"

    def test_writes_nothing_when_an_indicator_cannot_be_resolved(
        self, api_client: TestClient, triage: dict[str, str], data: None
    ) -> None:
        # The regression and its indicators are one transaction: a rejected batch must not leave a
        # regression with half of it behind.
        body = {"title": "half", "indicators": [LINUX_ONE, {**LINUX_ONE, "test": "nope"}]}

        assert api_client.post(REGRESSIONS, json=body, headers=triage).status_code == 404
        assert listed(api_client).json()["items"] == []

    @pytest.mark.parametrize("key", ["machine_count", "test_count"])
    def test_the_detail_carries_no_counts(
        self, create: Callable[..., Any], data: None, key: str
    ) -> None:
        # endpoints.md puts the counts on the list item, where a client cannot see the indicators.
        assert key not in create(indicators=[LINUX_ONE])

    def test_is_404_for_a_suite_that_is_not_there(
        self, api_client: TestClient, triage: dict[str, str]
    ) -> None:
        response = api_client.post(f"{SUITES_PATH}/nope/regressions", json={}, headers=triage)

        assert response.status_code == 404


class TestDetail:
    def test_carries_exactly_the_keys_endpoints_md_names(
        self, api_client: TestClient, create: Callable[..., Any], data: None
    ) -> None:
        uuid = create(indicators=[LINUX_ONE])["uuid"]

        body = api_client.get(f"{REGRESSIONS}/{uuid}").json()

        assert set(body) == {"uuid", "title", "bug", "notes", "state", "commit", "indicators"}

    def test_an_indicator_carries_exactly_four_keys(
        self, api_client: TestClient, create: Callable[..., Any], data: None
    ) -> None:
        uuid = create(indicators=[LINUX_ONE])["uuid"]

        indicator = api_client.get(f"{REGRESSIONS}/{uuid}").json()["indicators"][0]

        assert set(indicator) == {"uuid", "machine", "test", "metric"}
        assert {key: indicator[key] for key in ("machine", "test", "metric")} == LINUX_ONE

    def test_is_404_for_a_uuid_no_regression_has(
        self, api_client: TestClient, suite: SuiteTables
    ) -> None:
        response = api_client.get(f"{REGRESSIONS}/e6c9ba0a-0000-4000-8000-000000000000")

        assert response.status_code == 404
        assert code_of(response) == "not_found"

    def test_is_404_for_a_segment_that_is_not_a_uuid_at_all(
        self, api_client: TestClient, suite: SuiteTables
    ) -> None:
        # It names no regression, which is a 404 rather than a malformed request -- the same rule
        # `GET /runs/{uuid}` follows.
        assert api_client.get(f"{REGRESSIONS}/not-a-uuid").status_code == 404

    def test_accepts_the_uuid_in_either_case(
        self, api_client: TestClient, create: Callable[..., Any]
    ) -> None:
        uuid = create()["uuid"]

        assert api_client.get(f"{REGRESSIONS}/{uuid.upper()}").json()["uuid"] == uuid

    def test_is_not_shadowed_by_the_spa_catch_all(
        self, api_client: TestClient, create: Callable[..., Any]
    ) -> None:
        # The mount at "/" matches everything, so a miss here must not serve the client shell.
        uuid = create()["uuid"]

        assert "<title>LNT</title>" not in api_client.get(f"{REGRESSIONS}/{uuid}").text


class TestList:
    def test_is_a_cursor_envelope_even_when_nothing_matches(
        self, api_client: TestClient, suite: SuiteTables
    ) -> None:
        response = listed(api_client)

        assert response.status_code == 200
        assert response.json() == {"items": [], "cursor": {"next": None, "previous": None}}

    def test_an_item_carries_exactly_the_keys_endpoints_md_names(
        self, api_client: TestClient, create: Callable[..., Any], data: None
    ) -> None:
        create(title="t", indicators=[LINUX_ONE])

        assert set(listed(api_client).json()["items"][0]) == {
            "uuid",
            "title",
            "bug",
            "state",
            "commit",
            "machine_count",
            "test_count",
        }

    def test_leaves_the_unbounded_notes_out(
        self, api_client: TestClient, create: Callable[..., Any]
    ) -> None:
        # The same reason a run's `run_parameters` is detail-only: no list view renders it.
        create(notes="a very long investigation")

        assert "notes" not in listed(api_client).json()["items"][0]

    def test_names_the_commit_it_is_attributed_to(
        self, api_client: TestClient, create: Callable[..., Any], data: None
    ) -> None:
        create(commit="abc123")

        assert listed(api_client).json()["items"][0]["commit"] == "abc123"

    def test_is_404_for_a_suite_that_is_not_there(self, api_client: TestClient) -> None:
        assert api_client.get(f"{SUITES_PATH}/nope/regressions").status_code == 404


class TestCounts:
    @pytest.fixture(autouse=True)
    def regression(self, create: Callable[..., Any], data: None) -> Any:
        return create(indicators=[LINUX_ONE, LINUX_TWO, DARWIN_ONE])

    def test_count_distinct_machines_and_tests(self, api_client: TestClient) -> None:
        # Three indicators over two machines and two tests.
        item = listed(api_client).json()["items"][0]

        assert (item["machine_count"], item["test_count"]) == (2, 2)

    def test_are_zero_for_a_regression_with_no_indicators(
        self, api_client: TestClient, create: Callable[..., Any]
    ) -> None:
        uuid = create()["uuid"]

        item = next(one for one in listed(api_client).json()["items"] if one["uuid"] == uuid)
        assert (item["machine_count"], item["test_count"]) == (0, 0)

    @pytest.mark.parametrize("query", ["machine=darwin", "test=suite/one", "metric=execution_time"])
    def test_describe_the_regression_rather_than_the_query(
        self, api_client: TestClient, query: str
    ) -> None:
        """endpoints.md is explicit: the counts are independent of `machine=` and `test=`.

        `?machine=darwin` matches through one indicator of three, and a natural implementation that
        counted over the filtered join would answer 1 and 1.
        """
        item = listed(api_client, query).json()["items"][0]

        assert (item["machine_count"], item["test_count"]) == (2, 2)


class TestStateFilter:
    @pytest.fixture(autouse=True)
    def regressions(self, create: Callable[..., Any]) -> dict[str, str]:
        return {state: create(state=state)["uuid"] for state in RegressionStateName}

    def test_takes_a_comma_separated_list(
        self, api_client: TestClient, regressions: dict[str, str]
    ) -> None:
        response = listed(api_client, "state=active,detected")

        assert sorted(uuids_in(response)) == sorted(
            [regressions["active"], regressions["detected"]]
        )

    def test_omitting_it_returns_every_state(self, api_client: TestClient) -> None:
        assert len(uuids_in(listed(api_client))) == len(RegressionStateName)

    def test_every_state_round_trips_through_the_filter(
        self, api_client: TestClient, regressions: dict[str, str]
    ) -> None:
        # The stored value is an integer, so a state whose mapping is wrong would be findable
        # under another state's name rather than under its own.
        for state, uuid in regressions.items():
            assert uuids_in(listed(api_client, f"state={state}")) == [uuid]

    def test_is_400_for_a_name_that_is_not_a_state(self, api_client: TestClient) -> None:
        response = listed(api_client, "state=wontfix")

        assert response.status_code == 400
        assert code_of(response) == "invalid_request"

    def test_is_400_when_one_of_several_is_not_a_state(self, api_client: TestClient) -> None:
        assert listed(api_client, "state=active,wontfix").status_code == 400

    def test_the_rejection_names_the_five_that_exist(self, api_client: TestClient) -> None:
        message = listed(api_client, "state=wontfix").json()["error"]["message"]

        assert all(state in message for state in RegressionStateName)

    def test_a_state_is_not_read_as_sql(self, api_client: TestClient) -> None:
        assert listed(api_client, "state=1) OR (1=1").status_code == 400


class TestIndicatorFilters:
    @pytest.fixture(autouse=True)
    def regressions(self, create: Callable[..., Any], data: None) -> dict[str, str]:
        return {
            "linux": create(indicators=[LINUX_ONE])["uuid"],
            "darwin": create(indicators=[DARWIN_ONE])["uuid"],
            "compile": create(indicators=[{**LINUX_TWO, "metric": "compile_time"}])["uuid"],
            "none": create()["uuid"],
        }

    def test_machine_keeps_only_regressions_indicating_it(
        self, api_client: TestClient, regressions: dict[str, str]
    ) -> None:
        assert uuids_in(listed(api_client, "machine=darwin")) == [regressions["darwin"]]

    def test_test_keeps_only_regressions_indicating_it(
        self, api_client: TestClient, regressions: dict[str, str]
    ) -> None:
        assert uuids_in(listed(api_client, "test=suite/two")) == [regressions["compile"]]

    def test_a_test_name_with_a_slash_survives_the_query_parameter(
        self, api_client: TestClient, regressions: dict[str, str]
    ) -> None:
        # R1: no path carries a test name, so this filter is where a name containing '/' has to
        # work -- and every test name here has one.
        assert uuids_in(listed(api_client, "test=suite/one")) == [
            regressions["linux"],
            regressions["darwin"],
        ]

    def test_metric_keeps_only_regressions_indicating_it(
        self, api_client: TestClient, regressions: dict[str, str]
    ) -> None:
        assert uuids_in(listed(api_client, "metric=compile_time")) == [regressions["compile"]]

    def test_together_they_describe_one_indicator(
        self, api_client: TestClient, regressions: dict[str, str]
    ) -> None:
        # `?machine=linux&metric=compile_time` asks which regressions indicate `compile_time` *on
        # linux*, not which indicate either. The `linux` regression has an indicator on linux and
        # the `compile` one has a compile_time indicator; only the latter has both at once.
        assert uuids_in(listed(api_client, "machine=linux&metric=compile_time")) == [
            regressions["compile"]
        ]

    def test_a_regression_with_two_matching_indicators_is_listed_once(
        self, api_client: TestClient, create: Callable[..., Any]
    ) -> None:
        # The filter is an EXISTS rather than a join for exactly this reason.
        uuid = create(indicators=[LINUX_ONE, LINUX_TWO])["uuid"]

        assert uuids_in(listed(api_client, "machine=linux")).count(uuid) == 1

    def test_machine_is_404_for_one_that_is_not_there(self, api_client: TestClient) -> None:
        response = listed(api_client, "machine=nope")

        assert response.status_code == 404
        assert code_of(response) == "not_found"

    def test_test_is_404_for_one_that_is_not_there(self, api_client: TestClient) -> None:
        response = listed(api_client, "test=nope")

        assert response.status_code == 404
        assert code_of(response) == "not_found"

    def test_metric_is_400_for_one_the_schema_does_not_declare(
        self, api_client: TestClient
    ) -> None:
        # R3's third answer: a metric is a column rather than a row.
        response = listed(api_client, "metric=nope")

        assert response.status_code == 400
        assert code_of(response) == "invalid_request"

    def test_the_undeclared_metric_wins_over_the_absent_machine(
        self, api_client: TestClient
    ) -> None:
        # endpoints.md settles the precedence, and the two write paths take the same one.
        assert listed(api_client, "machine=nope&metric=nope").status_code == 400


class TestCommitFilters:
    @pytest.fixture(autouse=True)
    def regressions(self, create: Callable[..., Any], data: None) -> dict[str, str]:
        return {"at": create(commit="abc123")["uuid"], "nowhere": create()["uuid"]}

    def test_commit_keeps_only_regressions_attributed_to_it(
        self, api_client: TestClient, regressions: dict[str, str]
    ) -> None:
        assert uuids_in(listed(api_client, "commit=abc123")) == [regressions["at"]]

    def test_an_unknown_commit_is_an_empty_page_rather_than_an_error(
        self, api_client: TestClient
    ) -> None:
        # R3 draws this asymmetry deliberately: an unknown `machine=` is a 404, an unknown
        # `commit=` is an ordinary empty answer.
        response = listed(api_client, "commit=nope")

        assert response.status_code == 200
        assert response.json()["items"] == []

    def test_has_commit_true_keeps_the_attributed_ones(
        self, api_client: TestClient, regressions: dict[str, str]
    ) -> None:
        assert uuids_in(listed(api_client, "has_commit=true")) == [regressions["at"]]

    def test_has_commit_false_keeps_the_rest(
        self, api_client: TestClient, regressions: dict[str, str]
    ) -> None:
        assert uuids_in(listed(api_client, "has_commit=false")) == [regressions["nowhere"]]

    def test_omitting_has_commit_returns_both(self, api_client: TestClient) -> None:
        assert len(uuids_in(listed(api_client))) == 2


class TestSearch:
    @pytest.fixture(autouse=True)
    def regressions(self, create: Callable[..., Any]) -> None:
        create(title="find_if Slowdown")
        create(title="100% regression")
        create(notes="find_if")
        create()

    def test_matches_a_substring_of_the_title(self, api_client: TestClient) -> None:
        assert [item["title"] for item in listed(api_client, "search=Slow").json()["items"]] == [
            "find_if Slowdown"
        ]

    def test_is_case_insensitive(self, api_client: TestClient) -> None:
        assert len(uuids_in(listed(api_client, "search=slowdown"))) == 1

    def test_treats_a_wildcard_in_the_term_literally(self, api_client: TestClient) -> None:
        assert [item["title"] for item in listed(api_client, "search=100%").json()["items"]] == [
            "100% regression"
        ]

    def test_matches_the_title_alone(self, api_client: TestClient) -> None:
        # D9 gives this list the title column and nothing else, so a regression whose *notes* say
        # `find_if` does not match.
        assert len(uuids_in(listed(api_client, "search=find_if"))) == 1

    def test_a_regression_with_no_title_never_matches(self, api_client: TestClient) -> None:
        # A NULL title compares as unknown, so an untitled regression falls out of the match
        # rather than matching the empty term that every titled one does.
        assert len(uuids_in(listed(api_client, "search="))) == 2


class TestUpdate:
    @pytest.fixture
    def patch(
        self, api_client: TestClient, triage: dict[str, str], create: Callable[..., Any]
    ) -> Callable[..., Any]:
        def apply(uuid: str, **body: Any) -> Any:
            response = api_client.patch(f"{REGRESSIONS}/{uuid}", json=body, headers=triage)
            assert response.status_code == 200, response.text
            return response.json()

        return apply

    def test_sets_each_field(
        self, create: Callable[..., Any], patch: Callable[..., Any], data: None
    ) -> None:
        uuid = create()["uuid"]

        updated = patch(uuid, title="t", bug="b", notes="n", state="fixed", commit="abc123")

        assert updated["title"] == "t"
        assert updated["bug"] == "b"
        assert updated["notes"] == "n"
        assert updated["state"] == "fixed"
        assert updated["commit"] == "abc123"

    @pytest.mark.parametrize("key", ["title", "bug", "notes", "commit"])
    def test_an_explicit_null_clears_a_stored_value(
        self, create: Callable[..., Any], patch: Callable[..., Any], data: None, key: str
    ) -> None:
        uuid = create(title="t", bug="b", notes="n", commit="abc123")["uuid"]

        assert patch(uuid, **{key: None})[key] is None

    @pytest.mark.parametrize("key", ["title", "bug", "notes", "commit"])
    def test_an_omitted_key_is_left_unchanged(
        self, create: Callable[..., Any], patch: Callable[..., Any], data: None, key: str
    ) -> None:
        uuid = create(title="t", bug="b", notes="n", commit="abc123")["uuid"]

        assert patch(uuid, state="fixed")[key] is not None

    def test_a_request_that_changes_nothing_is_a_no_op(
        self, api_client: TestClient, create: Callable[..., Any], patch: Callable[..., Any]
    ) -> None:
        created = create(title="t")

        assert patch(created["uuid"]) == created

    @pytest.mark.parametrize(
        ("before", "after"),
        [("detected", "fixed"), ("fixed", "detected"), ("false_positive", "active")],
    )
    def test_any_state_may_be_set_to_any_other(
        self,
        create: Callable[..., Any],
        patch: Callable[..., Any],
        before: str,
        after: str,
    ) -> None:
        # endpoints.md: transitions are unconstrained, including back out of a resolved state.
        uuid = create(state=before)["uuid"]

        assert patch(uuid, state=after)["state"] == after

    def test_a_null_state_is_rejected(
        self, api_client: TestClient, triage: dict[str, str], create: Callable[..., Any]
    ) -> None:
        # A regression is always in one of the five states, so there is nothing to clear.
        uuid = create()["uuid"]

        response = api_client.patch(f"{REGRESSIONS}/{uuid}", json={"state": None}, headers=triage)

        assert response.status_code == 400
        assert code_of(response) == "invalid_request"

    def test_an_unknown_state_is_rejected(
        self, api_client: TestClient, triage: dict[str, str], create: Callable[..., Any]
    ) -> None:
        uuid = create()["uuid"]

        response = api_client.patch(
            f"{REGRESSIONS}/{uuid}", json={"state": "wontfix"}, headers=triage
        )

        assert response.status_code == 400

    def test_leaves_the_indicators_alone(
        self, create: Callable[..., Any], patch: Callable[..., Any], data: None
    ) -> None:
        uuid = create(indicators=[LINUX_ONE, DARWIN_ONE])["uuid"]

        assert len(patch(uuid, title="t")["indicators"]) == 2

    def test_does_not_accept_indicators(
        self, api_client: TestClient, triage: dict[str, str], create: Callable[..., Any]
    ) -> None:
        # They are managed through the two batch routes, so a key that could not take effect is
        # refused rather than dropped.
        uuid = create()["uuid"]

        response = api_client.patch(
            f"{REGRESSIONS}/{uuid}", json={"indicators": []}, headers=triage
        )

        assert response.status_code == 400

    def test_is_404_for_a_commit_that_is_not_there(
        self, api_client: TestClient, triage: dict[str, str], create: Callable[..., Any]
    ) -> None:
        uuid = create()["uuid"]

        response = api_client.patch(
            f"{REGRESSIONS}/{uuid}", json={"commit": "nope"}, headers=triage
        )

        assert response.status_code == 404
        assert code_of(response) == "not_found"

    def test_is_404_for_a_regression_that_is_not_there(
        self, api_client: TestClient, triage: dict[str, str], suite: SuiteTables
    ) -> None:
        response = api_client.patch(
            f"{REGRESSIONS}/e6c9ba0a-0000-4000-8000-000000000000",
            json={"title": "t"},
            headers=triage,
        )

        assert response.status_code == 404

    def test_is_404_for_a_regression_that_is_not_there_even_with_an_empty_body(
        self, api_client: TestClient, triage: dict[str, str], suite: SuiteTables
    ) -> None:
        response = api_client.patch(
            f"{REGRESSIONS}/e6c9ba0a-0000-4000-8000-000000000000", json={}, headers=triage
        )

        assert response.status_code == 404


class TestDelete:
    def test_answers_204_and_removes_it(
        self, api_client: TestClient, triage: dict[str, str], create: Callable[..., Any]
    ) -> None:
        uuid = create()["uuid"]

        assert api_client.delete(f"{REGRESSIONS}/{uuid}", headers=triage).status_code == 204
        assert api_client.get(f"{REGRESSIONS}/{uuid}").status_code == 404

    def test_takes_its_indicators_with_it(
        self,
        api_client: TestClient,
        triage: dict[str, str],
        create: Callable[..., Any],
        data: None,
        db_engine: Engine,
        suite: SuiteTables,
    ) -> None:
        uuid = create(indicators=[LINUX_ONE, DARWIN_ONE])["uuid"]

        assert api_client.delete(f"{REGRESSIONS}/{uuid}", headers=triage).status_code == 204

        with db_engine.connect() as connection:
            remaining = connection.execute(
                select(func.count()).select_from(suite.regression_indicator)
            ).scalar_one()
        assert remaining == 0

    def test_leaves_the_machines_and_tests_it_named(
        self,
        api_client: TestClient,
        triage: dict[str, str],
        create: Callable[..., Any],
        data: None,
    ) -> None:
        uuid = create(indicators=[LINUX_ONE])["uuid"]

        api_client.delete(f"{REGRESSIONS}/{uuid}", headers=triage)

        assert api_client.get(f"{MACHINES}/linux").status_code == 200

    def test_needs_no_confirmation(
        self, api_client: TestClient, triage: dict[str, str], create: Callable[..., Any]
    ) -> None:
        # Unlike the destructive suite operations, which take `?confirm=true`.
        uuid = create()["uuid"]

        assert api_client.delete(f"{REGRESSIONS}/{uuid}", headers=triage).status_code == 204

    def test_is_404_for_one_that_is_not_there(
        self, api_client: TestClient, triage: dict[str, str], suite: SuiteTables
    ) -> None:
        response = api_client.delete(
            f"{REGRESSIONS}/e6c9ba0a-0000-4000-8000-000000000000", headers=triage
        )

        assert response.status_code == 404
        assert code_of(response) == "not_found"


class TestAddIndicators:
    @pytest.fixture
    def add(
        self, api_client: TestClient, triage: dict[str, str]
    ) -> Callable[[str, list[dict[str, str]]], Any]:
        def post(uuid: str, indicators: list[dict[str, str]]) -> Any:
            return api_client.post(
                f"{REGRESSIONS}/{uuid}/indicators",
                json={"indicators": indicators},
                headers=triage,
            )

        return post

    def test_answers_200_with_the_count_and_the_whole_list(
        self, create: Callable[..., Any], add: Callable[..., Any], data: None
    ) -> None:
        # 200 rather than 201: a batch whose indicators all already exist creates nothing.
        uuid = create(indicators=[LINUX_ONE])["uuid"]

        response = add(uuid, [DARWIN_ONE])

        assert response.status_code == 200
        assert response.json()["added"] == 1
        assert len(response.json()["indicators"]) == 2

    def test_the_body_carries_exactly_two_keys(
        self, create: Callable[..., Any], add: Callable[..., Any], data: None
    ) -> None:
        uuid = create()["uuid"]

        assert set(add(uuid, [LINUX_ONE]).json()) == {"added", "indicators"}

    def test_an_indicator_the_regression_already_has_is_silently_ignored(
        self, create: Callable[..., Any], add: Callable[..., Any], data: None
    ) -> None:
        uuid = create(indicators=[LINUX_ONE])["uuid"]

        response = add(uuid, [LINUX_ONE])

        assert response.status_code == 200
        assert response.json()["added"] == 0
        assert len(response.json()["indicators"]) == 1

    def test_counts_only_what_it_created(
        self, create: Callable[..., Any], add: Callable[..., Any], data: None
    ) -> None:
        uuid = create(indicators=[LINUX_ONE])["uuid"]

        assert add(uuid, [LINUX_ONE, DARWIN_ONE]).json()["added"] == 1

    def test_collapses_a_duplicate_within_the_batch(
        self, create: Callable[..., Any], add: Callable[..., Any], data: None
    ) -> None:
        uuid = create()["uuid"]

        assert add(uuid, [LINUX_ONE, LINUX_ONE]).json()["added"] == 1

    def test_two_regressions_may_share_an_indicator(
        self, create: Callable[..., Any], add: Callable[..., Any], data: None
    ) -> None:
        # D5's constraint is on (regression, machine, test, metric), so the same combination on a
        # different regression is a different indicator rather than a duplicate.
        create(indicators=[LINUX_ONE])
        second = create()["uuid"]

        assert add(second, [LINUX_ONE]).json()["added"] == 1

    def test_the_same_machine_and_test_under_another_metric_is_a_new_indicator(
        self, create: Callable[..., Any], add: Callable[..., Any], data: None
    ) -> None:
        uuid = create(indicators=[LINUX_ONE])["uuid"]

        assert add(uuid, [{**LINUX_ONE, "metric": "compile_time"}]).json()["added"] == 1

    def test_the_added_indicators_show_up_on_the_detail(
        self,
        api_client: TestClient,
        create: Callable[..., Any],
        add: Callable[..., Any],
        data: None,
    ) -> None:
        uuid = create()["uuid"]
        add(uuid, [LINUX_ONE, DARWIN_ONE])

        assert len(api_client.get(f"{REGRESSIONS}/{uuid}").json()["indicators"]) == 2

    def test_is_404_for_a_machine_that_is_not_there(
        self, create: Callable[..., Any], add: Callable[..., Any], data: None
    ) -> None:
        uuid = create()["uuid"]

        response = add(uuid, [{**LINUX_ONE, "machine": "nope"}])

        assert response.status_code == 404
        assert code_of(response) == "not_found"

    def test_is_404_for_a_test_that_is_not_there(
        self, create: Callable[..., Any], add: Callable[..., Any], data: None
    ) -> None:
        uuid = create()["uuid"]

        assert add(uuid, [{**LINUX_ONE, "test": "nope"}]).status_code == 404

    def test_is_400_for_a_metric_the_schema_does_not_declare(
        self, create: Callable[..., Any], add: Callable[..., Any], data: None
    ) -> None:
        uuid = create()["uuid"]

        response = add(uuid, [{**LINUX_ONE, "metric": "nope"}])

        assert response.status_code == 400
        assert code_of(response) == "invalid_request"

    def test_the_undeclared_metric_wins_over_the_absent_machine(
        self, create: Callable[..., Any], add: Callable[..., Any], data: None
    ) -> None:
        # endpoints.md settles the precedence: a metric the schema does not declare is a request
        # that could never be answered, whereas an absent machine is a fact about the suite.
        uuid = create()["uuid"]

        response = add(uuid, [{"machine": "nope", "test": "nope", "metric": "nope"}])

        assert response.status_code == 400

    def test_is_404_for_a_regression_that_is_not_there(
        self, add: Callable[..., Any], data: None
    ) -> None:
        response = add("e6c9ba0a-0000-4000-8000-000000000000", [LINUX_ONE])

        assert response.status_code == 404

    def test_rejects_an_empty_batch(
        self, create: Callable[..., Any], add: Callable[..., Any], data: None
    ) -> None:
        # A request that asks for nothing is a client bug rather than a no-op worth serving.
        uuid = create()["uuid"]

        assert add(uuid, []).status_code == 400

    def test_writes_nothing_when_part_of_the_batch_cannot_be_resolved(
        self,
        api_client: TestClient,
        create: Callable[..., Any],
        add: Callable[..., Any],
        data: None,
    ) -> None:
        uuid = create()["uuid"]

        assert add(uuid, [LINUX_ONE, {**LINUX_ONE, "test": "nope"}]).status_code == 404
        assert api_client.get(f"{REGRESSIONS}/{uuid}").json()["indicators"] == []


class TestRemoveIndicators:
    @pytest.fixture
    def remove(
        self, api_client: TestClient, triage: dict[str, str]
    ) -> Callable[[str, list[str]], Any]:
        def delete(uuid: str, indicator_uuids: list[str]) -> Any:
            return api_client.request(
                "DELETE",
                f"{REGRESSIONS}/{uuid}/indicators",
                json={"indicator_uuids": indicator_uuids},
                headers=triage,
            )

        return delete

    def test_answers_200_with_the_count_and_what_is_left(
        self, create: Callable[..., Any], remove: Callable[..., Any], data: None
    ) -> None:
        created = create(indicators=[LINUX_ONE, DARWIN_ONE])

        response = remove(created["uuid"], [created["indicators"][0]["uuid"]])

        assert response.status_code == 200
        assert response.json()["removed"] == 1
        assert [one["machine"] for one in response.json()["indicators"]] == ["darwin"]

    def test_the_body_carries_exactly_two_keys(
        self, create: Callable[..., Any], remove: Callable[..., Any], data: None
    ) -> None:
        created = create(indicators=[LINUX_ONE])

        body = remove(created["uuid"], [created["indicators"][0]["uuid"]]).json()

        assert set(body) == {"removed", "indicators"}

    def test_rejects_a_uuid_carrying_a_nul(
        self, create: Callable[..., Any], remove: Callable[..., Any], data: None
    ) -> None:
        # D3, in the one place a UUID arrives in a body rather than a path: a NUL is no UUID, but
        # it is also a value PostgreSQL refuses as a parameter, so without a check here the
        # comparison against the stored column would be a 500 rather than this 400.
        created = create(indicators=[LINUX_ONE])

        response = remove(created["uuid"], ["a\x00b"])

        assert response.status_code == 400
        assert response.json()["error"]["code"] == "invalid_request"

    def test_a_uuid_naming_no_indicator_is_ignored(
        self, create: Callable[..., Any], remove: Callable[..., Any], data: None
    ) -> None:
        # So that a retried removal is not an error.
        created = create(indicators=[LINUX_ONE])
        indicator = created["indicators"][0]["uuid"]

        assert remove(created["uuid"], [indicator]).json()["removed"] == 1
        assert remove(created["uuid"], [indicator]).json()["removed"] == 0

    def test_accepts_an_indicator_uuid_in_either_case(
        self, create: Callable[..., Any], remove: Callable[..., Any], data: None
    ) -> None:
        # A UUID in a body is normalized exactly as one in a path segment is; otherwise an
        # upper-cased one would be silently ignored, which `removed: 0` cannot be told apart from a
        # retry that had nothing left to do.
        created = create(indicators=[LINUX_ONE])

        response = remove(created["uuid"], [created["indicators"][0]["uuid"].upper()])

        assert response.json()["removed"] == 1

    def test_a_uuid_that_is_not_a_uuid_at_all_is_ignored(
        self, create: Callable[..., Any], remove: Callable[..., Any], data: None
    ) -> None:
        uuid = create(indicators=[LINUX_ONE])["uuid"]

        response = remove(uuid, ["not-a-uuid"])

        assert response.status_code == 200
        assert response.json()["removed"] == 0

    def test_will_not_reach_another_regressions_indicator(
        self,
        api_client: TestClient,
        create: Callable[..., Any],
        remove: Callable[..., Any],
        data: None,
    ) -> None:
        # An indicator's UUID is unique suite-wide, so the regression in the path has to be part of
        # the predicate rather than merely resolved for its 404.
        other = create(indicators=[LINUX_ONE])
        mine = create(indicators=[DARWIN_ONE])

        response = remove(mine["uuid"], [other["indicators"][0]["uuid"]])

        assert response.json()["removed"] == 0
        assert len(api_client.get(f"{REGRESSIONS}/{other['uuid']}").json()["indicators"]) == 1

    def test_leaves_a_regression_with_no_indicators_behind(
        self,
        api_client: TestClient,
        create: Callable[..., Any],
        remove: Callable[..., Any],
        data: None,
    ) -> None:
        # D5: an empty indicator set is a legal state.
        created = create(title="kept", indicators=[LINUX_ONE])

        remove(created["uuid"], [created["indicators"][0]["uuid"]])

        detail = api_client.get(f"{REGRESSIONS}/{created['uuid']}").json()
        assert detail["title"] == "kept"
        assert detail["indicators"] == []

    def test_is_404_for_a_regression_that_is_not_there(
        self, remove: Callable[..., Any], suite: SuiteTables
    ) -> None:
        response = remove("e6c9ba0a-0000-4000-8000-000000000000", ["whatever"])

        assert response.status_code == 404

    def test_rejects_an_empty_batch(
        self, create: Callable[..., Any], remove: Callable[..., Any]
    ) -> None:
        assert remove(create()["uuid"], []).status_code == 400


class TestCascades:
    """What happens to a regression when something it points at goes away (D5)."""

    def test_deleting_a_machine_removes_the_indicators_naming_it(
        self,
        api_client: TestClient,
        manage: dict[str, str],
        create: Callable[..., Any],
        data: None,
    ) -> None:
        uuid = create(indicators=[LINUX_ONE, DARWIN_ONE])["uuid"]

        assert api_client.delete(f"{MACHINES}/linux", headers=manage).status_code == 204

        indicators = api_client.get(f"{REGRESSIONS}/{uuid}").json()["indicators"]
        assert [one["machine"] for one in indicators] == ["darwin"]

    def test_deleting_a_machine_keeps_a_regression_left_with_nothing(
        self,
        api_client: TestClient,
        manage: dict[str, str],
        create: Callable[..., Any],
        data: None,
    ) -> None:
        # D5 is explicit: the regression keeps its title, bug, notes and commit, and an empty
        # indicator set is a legal state.
        uuid = create(title="kept", notes="n", commit="abc123", indicators=[LINUX_ONE])["uuid"]

        api_client.delete(f"{MACHINES}/linux", headers=manage)

        detail = api_client.get(f"{REGRESSIONS}/{uuid}").json()
        assert detail["title"] == "kept"
        assert detail["notes"] == "n"
        assert detail["commit"] == "abc123"
        assert detail["indicators"] == []

    def test_the_counts_follow_a_deleted_machine(
        self,
        api_client: TestClient,
        manage: dict[str, str],
        create: Callable[..., Any],
        data: None,
    ) -> None:
        create(indicators=[LINUX_ONE, LINUX_TWO, DARWIN_ONE])

        api_client.delete(f"{MACHINES}/linux", headers=manage)

        item = listed(api_client).json()["items"][0]
        assert (item["machine_count"], item["test_count"]) == (1, 1)

    def test_a_commit_a_regression_references_cannot_be_deleted(
        self,
        api_client: TestClient,
        manage: dict[str, str],
        create: Callable[..., Any],
        data: None,
    ) -> None:
        # endpoints.md answers R4's `in_use`, which tells the caller to detach the regression
        # rather than to retry.
        create(commit="abc123")

        response = api_client.delete(f"{COMMITS}/abc123", headers=manage)

        assert response.status_code == 409
        assert code_of(response) == "in_use"

    def test_the_commit_goes_once_the_regression_lets_go_of_it(
        self,
        api_client: TestClient,
        manage: dict[str, str],
        triage: dict[str, str],
        create: Callable[..., Any],
        data: None,
    ) -> None:
        uuid = create(commit="abc123")["uuid"]

        api_client.patch(f"{REGRESSIONS}/{uuid}", json={"commit": None}, headers=triage)

        assert api_client.delete(f"{COMMITS}/abc123", headers=manage).status_code == 204


class TestPagination:
    @pytest.fixture(autouse=True)
    def regressions(self, create: Callable[..., Any], data: None) -> list[str]:
        return [create(indicators=[LINUX_ONE])["uuid"] for _ in range(7)]

    def test_serves_one_page_at_a_time(self, api_client: TestClient) -> None:
        response = listed(api_client, "limit=3")

        assert len(response.json()["items"]) == 3
        assert response.json()["cursor"]["next"] is not None

    def test_pages_cover_every_regression_exactly_once(
        self, api_client: TestClient, regressions: list[str]
    ) -> None:
        walked = [item["uuid"] for item in walk_pages(api_client, REGRESSIONS, "limit=2")]

        assert sorted(walked) == sorted(regressions)

    def test_the_counts_survive_a_page_boundary(self, api_client: TestClient) -> None:
        for item in walk_pages(api_client, REGRESSIONS, "limit=2"):
            assert (item["machine_count"], item["test_count"]) == (1, 1)

    def test_the_filters_survive_a_page_boundary(
        self, api_client: TestClient, create: Callable[..., Any], regressions: list[str]
    ) -> None:
        for _ in range(4):
            create(indicators=[DARWIN_ONE])

        walked = walk_pages(api_client, REGRESSIONS, "machine=linux&limit=2")

        assert sorted(item["uuid"] for item in walked) == sorted(regressions)

    def test_refuses_a_cursor_issued_for_another_entitys_list(self, api_client: TestClient) -> None:
        cursor = listed(api_client, "limit=2").json()["cursor"]["next"]

        response = api_client.get(f"{COMMITS}?limit=2&cursor={cursor}")

        assert response.status_code == 400
        assert code_of(response) == "invalid_request"

    def test_takes_no_offset(self, api_client: TestClient) -> None:
        # R2 pairs `offset` with `total`, and a cursor-paginated list has neither.
        assert "total" not in listed(api_client).json()


class TestAuthorization:
    """R5: `read` for the GETs, `triage` for everything else."""

    @pytest.fixture
    def regression(self, create: Callable[..., Any]) -> str:
        uuid: str = create()["uuid"]
        return uuid

    @pytest.mark.parametrize("path", ["", "/{uuid}"])
    def test_a_get_needs_no_credential(
        self, api_client: TestClient, regression: str, path: str
    ) -> None:
        assert api_client.get(f"{REGRESSIONS}{path.format(uuid=regression)}").status_code == 200

    @pytest.mark.parametrize(("method", "path", "body"), WRITES)
    def test_a_write_is_401_without_a_credential(
        self,
        api_client: TestClient,
        regression: str,
        method: str,
        path: str,
        body: dict[str, Any] | None,
    ) -> None:
        url = f"{REGRESSIONS}{path.format(uuid=regression)}"

        assert api_client.request(method, url, json=body).status_code == 401

    @pytest.mark.parametrize(("method", "path", "body"), WRITES)
    def test_a_write_is_403_for_a_key_below_triage(
        self,
        api_client: TestClient,
        submitter: dict[str, str],
        regression: str,
        method: str,
        path: str,
        body: dict[str, Any] | None,
    ) -> None:
        url = f"{REGRESSIONS}{path.format(uuid=regression)}"

        assert api_client.request(method, url, json=body, headers=submitter).status_code == 403

    def test_a_manage_key_may_triage(
        self, api_client: TestClient, manage: dict[str, str], suite: SuiteTables
    ) -> None:
        # R5's hierarchy: a key grants its own scope and every lower one.
        assert api_client.post(REGRESSIONS, json={}, headers=manage).status_code == 201

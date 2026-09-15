"""The time-series endpoints (endpoints.md, Time Series).

Driven over the real application and a real database, because essentially everything interesting
here is what PostgreSQL does: the five-table join D10 specifies, the keyset that pages it, and the
geomean computed in SQL.

Four things get most of the attention.

The two ways a commit reaches a filter are deliberately different, and both are checked: `commit`
selects rows belonging to a commit, so R3 makes an unknown one an empty page, while `after_commit`
names a *position*, so an unknown one is a 404 and one without an ordinal is a 400.

Sorting by commit excludes the commits that have no ordinal and omitting `sort` excludes nothing.
That is D10's rule, it comes out of the shared keyset rather than out of this endpoint, and it is
the one thing a natural implementation of "order by ordinal" gets wrong.

The cursor arrives in the request body rather than in the query string. It is the same token under
the same contract (R2), so the tests that matter are the ones that would catch it drifting: pages
cover every point exactly once, and a cursor from another ordering is refused.

And the geomean skips zero and negative values, which means a (machine, commit) with nothing
positive to average forms no group at all rather than one with a null in it.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

import pytest
from fastapi.testclient import TestClient

from conftest import code_of, run_payload, walk_cursor
from lnt_v5.querying import DEFAULT_LIMIT, MAX_LIMIT
from lnt_v5.routes.commits import COMMITS_PATH
from lnt_v5.routes.runs import RUNS_PATH
from lnt_v5.routes.suites import SUITES_PATH
from lnt_v5.routes.timeseries import QUERY_PATH, TRENDS_PATH
from lnt_v5.suites.tables import SuiteTables

QUERY = QUERY_PATH.format(testsuite="nts")
TRENDS = TRENDS_PATH.format(testsuite="nts")
RUNS = RUNS_PATH.format(testsuite="nts")
COMMITS = COMMITS_PATH.format(testsuite="nts")

# One metric of each kind the two endpoints treat differently: a `real` and an `integer` are both
# numeric (D3), so both may be averaged, and a `text` is neither.
NTS: dict[str, Any] = {
    "name": "nts",
    "metrics": [
        {"name": "execution_time", "type": "real"},
        {"name": "compile_time", "type": "real"},
        {"name": "compile_status", "type": "integer"},
        {"name": "toolchain", "type": "text"},
    ],
}

# A test name with a slash in it: the reason R1 keeps test names out of every path, and the reason
# this endpoint takes them in a body.
SLASHED = "suite/one"

# The smallest body either endpoint accepts, which is all the access tests below need to reach one.
ANY_METRIC = {"metric": "execution_time"}


@pytest.fixture
def suite(make_api_suite: Callable[[dict[str, Any]], SuiteTables]) -> SuiteTables:
    return make_api_suite(NTS)


@pytest.fixture
def submit(
    api_client: TestClient, submitter: dict[str, str], suite: SuiteTables
) -> Callable[..., dict[str, Any]]:
    """Submit one run and hand back its detail body.

    A submission is the only thing that creates a test (D6), and it creates the machine and the
    commit in the same breath, so every fixture below is built out of these.
    """

    def post(machine: str, commit: str, *tests: dict[str, Any]) -> dict[str, Any]:
        body = run_payload(machine={"name": machine}, commit={"value": commit}, tests=list(tests))
        response = api_client.post(RUNS, json=body, headers=submitter)
        assert response.status_code == 201, response.text
        return dict(response.json())

    return post


@pytest.fixture
def place(api_client: TestClient, manage: dict[str, str]) -> Callable[..., None]:
    """Give a commit an ordinal, and optionally a tag. PATCH is the only path to either (D11)."""

    def patch(commit: str, ordinal: int | None = None, tag: str | None = None) -> None:
        body: dict[str, Any] = {}
        if ordinal is not None:
            body["ordinal"] = ordinal
        if tag is not None:
            body["tag"] = tag
        response = api_client.patch(f"{COMMITS}/{commit}", json=body, headers=manage)
        assert response.status_code == 200, response.text

    return patch


@pytest.fixture
def series(
    submit: Callable[..., dict[str, Any]], place: Callable[..., None]
) -> list[dict[str, Any]]:
    """Three ordered commits on one machine, one test, one run each.

    Returned as the run bodies, so that a test needing a real `submitted_at` or `run_uuid` has one
    without reading the database.
    """
    runs = [
        submit("linux", f"c{index}", {"name": "t", "execution_time": float(index)})
        for index in range(1, 4)
    ]
    for index in range(1, 4):
        place(f"c{index}", ordinal=index * 10)
    return runs


def query(api_client: TestClient, **body: Any) -> Any:
    return api_client.post(QUERY, json=body)


def points(api_client: TestClient, **body: Any) -> list[dict[str, Any]]:
    response = query(api_client, **body)
    assert response.status_code == 200, response.text
    return list(response.json()["items"])


def walk(api_client: TestClient, **body: Any) -> list[dict[str, Any]]:
    """Every point the query serves, following `cursor.next` to the end (R2).

    Through the shared walker, which takes a fetch callable for exactly this reason: the token has
    two carriers and one contract, and this is the list that carries it in a body.
    """
    return walk_cursor(
        lambda cursor: query(api_client, **body, **({} if cursor is None else {"cursor": cursor}))
    )


def trend_query(api_client: TestClient, **body: Any) -> Any:
    return api_client.post(TRENDS, json=body)


def trends(api_client: TestClient, **body: Any) -> list[dict[str, Any]]:
    response = trend_query(api_client, **body)
    assert response.status_code == 200, response.text
    return list(response.json()["items"])


class TestQueryPoint:
    def test_is_a_cursor_envelope_even_when_nothing_matches(
        self, api_client: TestClient, suite: SuiteTables
    ) -> None:
        response = query(api_client, metric="execution_time")

        assert response.status_code == 200
        assert response.json() == {"items": [], "cursor": {"next": None, "previous": None}}

    def test_carries_exactly_the_nine_keys_endpoints_md_gives_it(
        self,
        api_client: TestClient,
        submit: Callable[..., dict[str, Any]],
        place: Callable[..., None],
    ) -> None:
        run = submit("linux", "abc", {"name": SLASHED, "execution_time": 1.25})
        place("abc", ordinal=42, tag="release-18.1")

        assert points(api_client, metric="execution_time") == [
            {
                "test": SLASHED,
                "machine": "linux",
                "metric": "execution_time",
                "value": 1.25,
                "commit": "abc",
                "ordinal": 42,
                "run_uuid": run["uuid"],
                "submitted_at": run["submitted_at"],
                "tag": "release-18.1",
            }
        ]

    def test_denormalizes_the_commits_ordinal_and_tag_as_null_when_unset(
        self, api_client: TestClient, submit: Callable[..., dict[str, Any]]
    ) -> None:
        # R4 grants this endpoint the denormalization by name, and R4's general rule makes a
        # documented key present-and-null rather than absent.
        submit("linux", "abc", {"name": "t", "execution_time": 1.0})

        point = points(api_client, metric="execution_time")[0]

        assert point["ordinal"] is None
        assert point["tag"] is None

    def test_echoes_the_metric_the_request_named(
        self, api_client: TestClient, submit: Callable[..., dict[str, Any]]
    ) -> None:
        submit("linux", "abc", {"name": "t", "execution_time": 1.0, "compile_time": 2.0})

        assert [point["metric"] for point in points(api_client, metric="compile_time")] == [
            "compile_time"
        ]

    @pytest.mark.parametrize(
        ("metric", "value"),
        [("execution_time", 1.5), ("compile_status", 3), ("toolchain", "clang-21")],
    )
    def test_the_value_keeps_the_type_the_schema_declares(
        self, api_client: TestClient, submit: Callable[..., dict[str, Any]], metric: str, value: Any
    ) -> None:
        # D3 and R4: a value uses the JSON representation of its declared type and is never
        # stringified. A metric need not be numeric to be queried -- only to be averaged.
        submit("linux", "abc", {"name": "t", metric: value})

        assert [point["value"] for point in points(api_client, metric=metric)] == [value]

    def test_skips_the_samples_with_no_value_for_the_metric(
        self, api_client: TestClient, submit: Callable[..., dict[str, Any]]
    ) -> None:
        submit("linux", "abc", {"name": "measured", "execution_time": 1.0}, {"name": "not"})

        assert [point["test"] for point in points(api_client, metric="execution_time")] == [
            "measured"
        ]

    def test_serves_one_point_per_repetition(
        self, api_client: TestClient, submit: Callable[..., dict[str, Any]]
    ) -> None:
        # D6: an array value is one sample per element, and each is its own point.
        submit("linux", "abc", {"name": "t", "execution_time": [1.0, 2.0, 3.0]})

        values = [point["value"] for point in points(api_client, metric="execution_time")]

        assert sorted(values) == [1.0, 2.0, 3.0]


class TestQueryFilters:
    def test_keeps_only_the_named_machines_values(
        self, api_client: TestClient, submit: Callable[..., dict[str, Any]]
    ) -> None:
        submit("linux", "abc", {"name": "t", "execution_time": 1.0})
        submit("darwin", "abc", {"name": "t", "execution_time": 2.0})

        assert [
            p["value"] for p in points(api_client, metric="execution_time", machine="linux")
        ] == [1.0]

    def test_an_unknown_machine_is_404(self, api_client: TestClient, suite: SuiteTables) -> None:
        response = query(api_client, metric="execution_time", machine="nope")

        assert response.status_code == 404
        assert code_of(response) == "not_found"

    def test_the_test_list_is_a_disjunction(
        self, api_client: TestClient, submit: Callable[..., dict[str, Any]]
    ) -> None:
        submit(
            "linux",
            "abc",
            {"name": "a", "execution_time": 1.0},
            {"name": "b", "execution_time": 2.0},
            {"name": "c", "execution_time": 3.0},
        )

        served = points(api_client, metric="execution_time", test=["a", "c"])

        assert sorted(point["test"] for point in served) == ["a", "c"]

    def test_the_test_list_addresses_a_name_containing_a_slash(
        self, api_client: TestClient, submit: Callable[..., dict[str, Any]]
    ) -> None:
        # R1: no path could carry this name, which is why the filter lives in the body.
        submit("linux", "abc", {"name": SLASHED, "execution_time": 1.0}, {"name": "other"})

        assert [p["test"] for p in points(api_client, metric="execution_time", test=[SLASHED])] == [
            SLASHED
        ]

    def test_an_unknown_test_is_404(
        self, api_client: TestClient, submit: Callable[..., dict[str, Any]]
    ) -> None:
        # R3, the same answer a `test=` query parameter gets elsewhere.
        submit("linux", "abc", {"name": "t", "execution_time": 1.0})

        response = query(api_client, metric="execution_time", test=["t", "nope"])

        assert response.status_code == 404
        assert code_of(response) == "not_found"

    def test_an_empty_test_list_keeps_nothing(
        self, api_client: TestClient, submit: Callable[..., dict[str, Any]]
    ) -> None:
        # Deliberately not the same as omitting the key: a client that narrowed to an empty set
        # asked for nothing, and answering with the whole suite would be a far larger query.
        submit("linux", "abc", {"name": "t", "execution_time": 1.0})

        assert points(api_client, metric="execution_time", test=[]) == []

    def test_keeps_only_the_named_commits_values(
        self, api_client: TestClient, series: list[dict[str, Any]]
    ) -> None:
        assert [p["commit"] for p in points(api_client, metric="execution_time", commit="c2")] == [
            "c2"
        ]

    def test_an_unknown_commit_is_an_empty_page_rather_than_an_error(
        self, api_client: TestClient, series: list[dict[str, Any]]
    ) -> None:
        # R3 draws this asymmetry deliberately: a commit the suite has never seen is an ordinary
        # answer to "what was measured here", where a misspelled machine is not.
        response = query(api_client, metric="execution_time", commit="never-seen")

        assert response.status_code == 200
        assert response.json()["items"] == []

    def test_the_commit_ranges_are_exclusive_at_both_ends(
        self, api_client: TestClient, series: list[dict[str, Any]]
    ) -> None:
        served = points(api_client, metric="execution_time", after_commit="c1", before_commit="c3")

        assert [point["commit"] for point in served] == ["c2"]

    def test_a_commit_range_excludes_the_unordered_commits_whatever_the_sort(
        self,
        api_client: TestClient,
        series: list[dict[str, Any]],
        submit: Callable[..., dict[str, Any]],
    ) -> None:
        # endpoints.md: a commit with no ordinal is in no range of ordinals. Distinct from the
        # exclusion `sort=commit` causes -- `sort` is omitted here, and R2's "no data is excluded"
        # is about the ordering rather than about the filters beside it.
        submit("linux", "unordered", {"name": "t", "execution_time": 9.0})

        served = points(api_client, metric="execution_time", after_commit="c1")

        assert sorted(point["commit"] for point in served) == ["c2", "c3"]

    @pytest.mark.parametrize("bound", ["after_commit", "before_commit"])
    def test_a_range_bound_naming_no_commit_is_404(
        self, api_client: TestClient, series: list[dict[str, Any]], bound: str
    ) -> None:
        # Unlike the `commit` filter above: this one names a position rather than a set of rows,
        # and R4 gives an entity named by a request body a 404.
        response = query(api_client, metric="execution_time", **{bound: "never-seen"})

        assert response.status_code == 404
        assert code_of(response) == "not_found"

    @pytest.mark.parametrize("bound", ["after_commit", "before_commit"])
    def test_a_range_bound_on_a_commit_with_no_ordinal_is_400(
        self,
        api_client: TestClient,
        series: list[dict[str, Any]],
        submit: Callable[..., dict[str, Any]],
        bound: str,
    ) -> None:
        submit("linux", "unordered", {"name": "t", "execution_time": 9.0})

        response = query(api_client, metric="execution_time", **{bound: "unordered"})

        assert response.status_code == 400
        assert code_of(response) == "invalid_request"

    @pytest.mark.parametrize("bound", ["after_commit", "before_commit"])
    def test_an_exact_commit_cannot_be_combined_with_a_range(
        self, api_client: TestClient, series: list[dict[str, Any]], bound: str
    ) -> None:
        response = query(api_client, metric="execution_time", commit="c1", **{bound: "c2"})

        assert response.status_code == 400
        assert code_of(response) == "invalid_request"

    def test_the_time_ranges_are_exclusive_at_both_ends(
        self, api_client: TestClient, series: list[dict[str, Any]]
    ) -> None:
        served = points(
            api_client,
            metric="execution_time",
            after_time=series[0]["submitted_at"],
            before_time=series[2]["submitted_at"],
        )

        assert [point["commit"] for point in served] == ["c2"]

    def test_a_time_bound_is_read_as_iso_8601_and_never_as_an_epoch(
        self, api_client: TestClient, series: list[dict[str, Any]]
    ) -> None:
        # D3: reading a number as a Unix epoch would silently turn a mistyped value into 1970.
        response = query(api_client, metric="execution_time", after_time=1700000000)

        assert response.status_code == 400
        assert code_of(response) == "invalid_request"

    def test_answers_the_baseline_call_the_graph_page_makes(
        self, api_client: TestClient, submit: Callable[..., dict[str, Any]]
    ) -> None:
        # client/graph.md: a baseline is fetched with `{machine, metric, commit, test}` in one
        # body, which is the only request any client doc combines four filters in.
        baseline = submit("linux", "base", {"name": "a", "execution_time": 1.0}, {"name": "b"})
        submit("darwin", "base", {"name": "a", "execution_time": 2.0})
        submit("linux", "other", {"name": "a", "execution_time": 3.0})

        served = points(
            api_client, machine="linux", metric="execution_time", commit="base", test=["a"]
        )

        assert served == [
            {
                "test": "a",
                "machine": "linux",
                "metric": "execution_time",
                "value": 1.0,
                "commit": "base",
                "ordinal": None,
                "run_uuid": baseline["uuid"],
                "submitted_at": baseline["submitted_at"],
                "tag": None,
            }
        ]


class TestQueryMetric:
    def test_the_metric_is_required(self, api_client: TestClient, suite: SuiteTables) -> None:
        response = query(api_client, machine="linux")

        assert response.status_code == 400
        assert code_of(response) == "invalid_request"

    def test_an_undeclared_metric_is_400_rather_than_404(
        self, api_client: TestClient, suite: SuiteTables
    ) -> None:
        # R3: a metric names a column the schema declares rather than a row the suite holds, so a
        # request naming one that is not there could never be answered.
        response = query(api_client, metric="nope")

        assert response.status_code == 400
        assert code_of(response) == "invalid_request"

    @pytest.mark.parametrize("absent", [{"machine": "also-nope"}, {"test": ["also-nope"]}])
    def test_an_undeclared_metric_beats_an_absent_machine_or_test(
        self, api_client: TestClient, suite: SuiteTables, absent: dict[str, Any]
    ) -> None:
        # endpoints.md states this precedence for a request body naming both, and names `test`
        # alongside `machine`; the two resolve through different helpers, so both are checked.
        response = query(api_client, metric="nope", **absent)

        assert response.status_code == 400

    def test_a_key_the_body_does_not_define_is_400(
        self, api_client: TestClient, suite: SuiteTables
    ) -> None:
        response = query(api_client, metric="execution_time", machines=["linux"])

        assert response.status_code == 400
        assert code_of(response) == "invalid_request"

    def test_refuses_a_test_list_longer_than_r2s_page_ceiling(
        self, api_client: TestClient, suite: SuiteTables
    ) -> None:
        # The list expands into one statement, and an unbounded one would carry more bind
        # parameters than the protocol does.
        response = query(api_client, metric="execution_time", test=["t"] * (MAX_LIMIT + 1))

        assert response.status_code == 400
        assert code_of(response) == "invalid_request"


class TestQuerySort:
    def test_orders_by_ordinal_in_both_directions(
        self, api_client: TestClient, series: list[dict[str, Any]]
    ) -> None:
        ascending = points(api_client, metric="execution_time", sort="commit")
        descending = points(api_client, metric="execution_time", sort="-commit")

        assert [point["ordinal"] for point in ascending] == [10, 20, 30]
        assert [point["ordinal"] for point in descending] == [30, 20, 10]

    def test_sorting_by_commit_excludes_the_commits_with_no_ordinal(
        self,
        api_client: TestClient,
        series: list[dict[str, Any]],
        submit: Callable[..., dict[str, Any]],
    ) -> None:
        # D10: a commit with no ordinal has no position in that order, and a null sort key would
        # compare as unknown against a cursor and vanish from every page anyway.
        submit("linux", "unordered", {"name": "t", "execution_time": 9.0})

        served = points(api_client, metric="execution_time", sort="commit")

        assert [point["commit"] for point in served] == ["c1", "c2", "c3"]

    def test_omitting_the_sort_excludes_nothing(
        self,
        api_client: TestClient,
        series: list[dict[str, Any]],
        submit: Callable[..., dict[str, Any]],
    ) -> None:
        submit("linux", "unordered", {"name": "t", "execution_time": 9.0})

        served = points(api_client, metric="execution_time")

        assert sorted(point["commit"] for point in served) == ["c1", "c2", "c3", "unordered"]

    def test_orders_by_test_name_in_both_directions(
        self, api_client: TestClient, submit: Callable[..., dict[str, Any]]
    ) -> None:
        submit(
            "linux",
            "abc",
            {"name": "b", "execution_time": 1.0},
            {"name": "a", "execution_time": 2.0},
            {"name": "c", "execution_time": 3.0},
        )

        assert [p["test"] for p in points(api_client, metric="execution_time", sort="test")] == [
            "a",
            "b",
            "c",
        ]
        assert [p["test"] for p in points(api_client, metric="execution_time", sort="-test")] == [
            "c",
            "b",
            "a",
        ]

    def test_orders_by_submission_time_in_both_directions(
        self, api_client: TestClient, series: list[dict[str, Any]]
    ) -> None:
        oldest = points(api_client, metric="execution_time", sort="submitted_at")
        newest = points(api_client, metric="execution_time", sort="-submitted_at")

        assert [point["commit"] for point in oldest] == ["c1", "c2", "c3"]
        assert [point["commit"] for point in newest] == ["c3", "c2", "c1"]

    def test_a_sort_field_endpoints_md_does_not_name_is_400(
        self, api_client: TestClient, suite: SuiteTables
    ) -> None:
        response = query(api_client, metric="execution_time", sort="value")

        assert response.status_code == 400
        assert code_of(response) == "invalid_request"


class TestQueryPagination:
    @pytest.fixture
    def many(self, submit: Callable[..., dict[str, Any]], place: Callable[..., None]) -> None:
        for index in range(7):
            submit("linux", f"c{index}", {"name": "t", "execution_time": float(index)})
            place(f"c{index}", ordinal=index)

    def test_serves_one_page_at_a_time(self, api_client: TestClient, many: None) -> None:
        body = query(api_client, metric="execution_time", limit=3).json()

        assert len(body["items"]) == 3
        assert body["cursor"]["next"] is not None

    def test_serves_r2s_default_page_size_when_the_body_names_none(
        self, api_client: TestClient, submit: Callable[..., dict[str, Any]]
    ) -> None:
        # R2's 25, observed on a response rather than only in R8's document: `limit` is a key of
        # the body here, so the default is the model's rather than a query parameter's.
        submit(
            "linux",
            "abc",
            *({"name": f"t{index}", "execution_time": 1.0} for index in range(DEFAULT_LIMIT + 5)),
        )

        assert len(points(api_client, metric="execution_time")) == DEFAULT_LIMIT == 25

    @pytest.mark.parametrize("sort", [None, "commit", "-commit", "test", "-submitted_at"])
    def test_pages_cover_every_point_exactly_once(
        self, api_client: TestClient, many: None, sort: str | None
    ) -> None:
        served = walk(
            api_client, metric="execution_time", limit=2, **({} if sort is None else {"sort": sort})
        )

        assert sorted(point["value"] for point in served) == [float(index) for index in range(7)]

    def test_the_filters_survive_a_page_boundary(
        self, api_client: TestClient, many: None, submit: Callable[..., dict[str, Any]]
    ) -> None:
        submit("darwin", "c0", {"name": "t", "execution_time": 99.0})

        served = walk(api_client, metric="execution_time", machine="linux", limit=2)

        assert 99.0 not in [point["value"] for point in served]
        assert len(served) == 7

    def test_refuses_a_cursor_issued_for_the_other_direction(
        self, api_client: TestClient, many: None
    ) -> None:
        # R2: a cursor names a position in an *ordering*, and the fingerprint is what turns feeding
        # it to the reverse of that ordering into a 400 instead of a plausible page of wrong rows.
        cursor = query(api_client, metric="execution_time", sort="commit", limit=2).json()[
            "cursor"
        ]["next"]

        response = query(api_client, metric="execution_time", sort="-commit", cursor=cursor)

        assert response.status_code == 400
        assert code_of(response) == "invalid_request"

    def test_refuses_a_cursor_issued_for_another_list(
        self, api_client: TestClient, many: None
    ) -> None:
        cursor = api_client.get(f"{COMMITS}?limit=2").json()["cursor"]["next"]

        response = query(api_client, metric="execution_time", cursor=cursor)

        assert response.status_code == 400
        assert code_of(response) == "invalid_request"

    @pytest.mark.parametrize("limit", [0, 10001])
    def test_refuses_a_page_size_outside_r2s_bounds(
        self, api_client: TestClient, suite: SuiteTables, limit: int
    ) -> None:
        response = query(api_client, metric="execution_time", limit=limit)

        assert response.status_code == 400
        assert code_of(response) == "invalid_request"


class TestTrends:
    def test_is_an_unpaginated_envelope_even_when_nothing_matches(
        self, api_client: TestClient, suite: SuiteTables
    ) -> None:
        response = trend_query(api_client, metric="execution_time")

        assert response.status_code == 200
        assert response.json() == {"items": []}

    def test_carries_exactly_the_six_keys_endpoints_md_gives_it(
        self,
        api_client: TestClient,
        submit: Callable[..., dict[str, Any]],
        place: Callable[..., None],
    ) -> None:
        run = submit("linux", "abc", {"name": "t", "execution_time": 4.0})
        place("abc", ordinal=7, tag="release-18.1")

        assert trends(api_client, metric="execution_time") == [
            {
                "machine": "linux",
                "commit": "abc",
                "ordinal": 7,
                "submitted_at": run["submitted_at"],
                "tag": "release-18.1",
                "value": 4.0,
            }
        ]

    def test_is_the_geometric_mean_of_every_value_at_that_machine_and_commit(
        self,
        api_client: TestClient,
        submit: Callable[..., dict[str, Any]],
        place: Callable[..., None],
    ) -> None:
        submit(
            "linux",
            "abc",
            {"name": "a", "execution_time": 1.0},
            {"name": "b", "execution_time": 4.0},
        )
        place("abc", ordinal=1)

        assert trends(api_client, metric="execution_time")[0]["value"] == pytest.approx(2.0)

    def test_aggregates_across_every_run_at_that_machine_and_commit(
        self,
        api_client: TestClient,
        submit: Callable[..., dict[str, Any]],
        place: Callable[..., None],
    ) -> None:
        # Several runs per machine and commit are legal (endpoints.md, Runs), and a trend point
        # covers all of them rather than one.
        submit("linux", "abc", {"name": "t", "execution_time": 1.0})
        latest = submit("linux", "abc", {"name": "t", "execution_time": 9.0})
        place("abc", ordinal=1)

        item = trends(api_client, metric="execution_time")[0]

        assert item["value"] == pytest.approx(3.0)
        assert item["submitted_at"] == latest["submitted_at"]

    def test_skips_the_zero_and_negative_values(
        self,
        api_client: TestClient,
        submit: Callable[..., dict[str, Any]],
        place: Callable[..., None],
    ) -> None:
        submit(
            "linux",
            "abc",
            {"name": "a", "execution_time": 1.0},
            {"name": "b", "execution_time": 4.0},
            {"name": "c", "execution_time": 0.0},
            {"name": "d", "execution_time": -8.0},
        )
        place("abc", ordinal=1)

        assert trends(api_client, metric="execution_time")[0]["value"] == pytest.approx(2.0)

    def test_a_group_with_nothing_positive_is_absent_rather_than_null(
        self,
        api_client: TestClient,
        submit: Callable[..., dict[str, Any]],
        place: Callable[..., None],
    ) -> None:
        submit("linux", "good", {"name": "t", "execution_time": 2.0})
        submit("linux", "bad", {"name": "t", "execution_time": -2.0})
        place("good", ordinal=1)
        place("bad", ordinal=2)

        assert [item["commit"] for item in trends(api_client, metric="execution_time")] == ["good"]

    def test_an_integer_metric_is_averaged_in_floating_point(
        self,
        api_client: TestClient,
        submit: Callable[..., dict[str, Any]],
        place: Callable[..., None],
    ) -> None:
        # D3: the geomean of integers is not an integer, and endpoints.md returns it as a real.
        submit(
            "linux",
            "abc",
            {"name": "a", "compile_status": 2},
            {"name": "b", "compile_status": 8},
        )
        place("abc", ordinal=1)

        assert trends(api_client, metric="compile_status")[0]["value"] == pytest.approx(4.0)

    def test_excludes_the_commits_with_no_ordinal(
        self,
        api_client: TestClient,
        submit: Callable[..., dict[str, Any]],
        place: Callable[..., None],
    ) -> None:
        submit("linux", "ordered", {"name": "t", "execution_time": 1.0})
        submit("linux", "unordered", {"name": "t", "execution_time": 2.0})
        place("ordered", ordinal=1)

        assert [item["commit"] for item in trends(api_client, metric="execution_time")] == [
            "ordered"
        ]

    def test_orders_by_machine_and_then_by_ordinal(
        self,
        api_client: TestClient,
        submit: Callable[..., dict[str, Any]],
        place: Callable[..., None],
    ) -> None:
        for machine in ("linux", "darwin"):
            for index in (2, 1):
                submit(machine, f"c{index}", {"name": "t", "execution_time": float(index)})
        place("c1", ordinal=1)
        place("c2", ordinal=2)

        served = trends(api_client, metric="execution_time")

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
            submit(machine, "abc", {"name": "t", "execution_time": 1.0})
        place("abc", ordinal=1)

        served = trends(api_client, metric="execution_time", machine=["linux", "windows"])

        assert [item["machine"] for item in served] == ["linux", "windows"]

    def test_an_unknown_machine_is_404(self, api_client: TestClient, suite: SuiteTables) -> None:
        response = trend_query(api_client, metric="execution_time", machine=["nope"])

        assert response.status_code == 404
        assert code_of(response) == "not_found"

    def test_an_empty_machine_list_keeps_nothing(
        self,
        api_client: TestClient,
        submit: Callable[..., dict[str, Any]],
        place: Callable[..., None],
    ) -> None:
        submit("linux", "abc", {"name": "t", "execution_time": 1.0})
        place("abc", ordinal=1)

        assert trends(api_client, metric="execution_time", machine=[]) == []

    def test_an_untracked_machine_is_returned_when_it_is_named(
        self,
        api_client: TestClient,
        manage: dict[str, str],
        submit: Callable[..., dict[str, Any]],
        place: Callable[..., None],
    ) -> None:
        # endpoints.md: `tracked` governs *automatic* selection (D5), and a machine named here was
        # chosen deliberately. The Dashboard applies the flag when it picks the names.
        submit("retired", "abc", {"name": "t", "execution_time": 1.0})
        place("abc", ordinal=1)
        patched = api_client.patch(
            f"{SUITES_PATH}/nts/machines/retired", json={"tracked": False}, headers=manage
        )
        assert patched.status_code == 200, patched.text

        assert [item["machine"] for item in trends(api_client, metric="execution_time")] == [
            "retired"
        ]
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
            submit("linux", f"c{index}", {"name": "t", "execution_time": 1.0})
            place(f"c{index}", ordinal=index)

        served = trends(api_client, metric="execution_time", last_n=2)

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
        submit("linux", "abc", {"name": "t", "execution_time": 1.0})
        place("abc", ordinal=1)

        assert len(trends(api_client, metric="execution_time", last_n=1000)) == 1
        assert len(trends(api_client, metric="execution_time")) == 1

    def test_last_n_counts_over_the_suites_commits_rather_than_over_the_matches(
        self,
        api_client: TestClient,
        submit: Callable[..., dict[str, Any]],
        place: Callable[..., None],
    ) -> None:
        # endpoints.md: "the last N commits" spans the same range on every card, so a machine that
        # stopped reporting inside it yields a trendline that stops rather than one stretched back.
        for index in range(4):
            submit("linux", f"c{index}", {"name": "t", "execution_time": 1.0})
            place(f"c{index}", ordinal=index)
        submit("retired", "c0", {"name": "t", "execution_time": 1.0})

        served = trends(api_client, metric="execution_time", machine=["retired"], last_n=2)

        assert served == []

    @pytest.mark.parametrize("last_n", [0, 10001])
    def test_refuses_a_last_n_outside_its_bounds(
        self, api_client: TestClient, suite: SuiteTables, last_n: int
    ) -> None:
        response = trend_query(api_client, metric="execution_time", last_n=last_n)

        assert response.status_code == 400
        assert code_of(response) == "invalid_request"

    def test_refuses_a_machine_list_longer_than_r2s_page_ceiling(
        self, api_client: TestClient, suite: SuiteTables
    ) -> None:
        response = trend_query(api_client, metric="execution_time", machine=["m"] * (MAX_LIMIT + 1))

        assert response.status_code == 400
        assert code_of(response) == "invalid_request"


class TestTrendsMetric:
    def test_the_metric_is_required(self, api_client: TestClient, suite: SuiteTables) -> None:
        response = trend_query(api_client)

        assert response.status_code == 400
        assert code_of(response) == "invalid_request"

    def test_an_undeclared_metric_is_400(self, api_client: TestClient, suite: SuiteTables) -> None:
        response = trend_query(api_client, metric="nope")

        assert response.status_code == 400
        assert code_of(response) == "invalid_request"

    def test_a_non_numeric_metric_is_400(self, api_client: TestClient, suite: SuiteTables) -> None:
        # D3: a geomean is arithmetic, and `text` is not a number. The type system deliberately
        # goes no further than that -- an `integer` encoding an enum is the author's problem.
        response = trend_query(api_client, metric="toolchain")

        assert response.status_code == 400
        assert code_of(response) == "invalid_request"

    def test_a_non_numeric_metric_beats_an_absent_machine(
        self, api_client: TestClient, suite: SuiteTables
    ) -> None:
        response = trend_query(api_client, metric="toolchain", machine=["also-nope"])

        assert response.status_code == 400

    def test_a_key_the_body_does_not_define_is_400(
        self, api_client: TestClient, suite: SuiteTables
    ) -> None:
        response = trend_query(api_client, metric="execution_time", test=["t"])

        assert response.status_code == 400
        assert code_of(response) == "invalid_request"


@pytest.mark.parametrize("path", [QUERY, TRENDS])
class TestAccess:
    """R5: both are read-only POSTs, so both allow an anonymous caller."""

    def test_needs_no_credential(
        self, api_client: TestClient, suite: SuiteTables, path: str
    ) -> None:
        assert api_client.post(path, json=ANY_METRIC).status_code == 200

    def test_a_bad_token_is_401_even_though_the_endpoint_is_read_scoped(
        self,
        api_client: TestClient,
        suite: SuiteTables,
        bearer: Callable[[str], dict[str, str]],
        path: str,
    ) -> None:
        # R5: a bad credential is never silently downgraded to anonymous access.
        response = api_client.post(path, json=ANY_METRIC, headers=bearer("f" * 64))

        assert response.status_code == 401
        assert code_of(response) == "unauthorized"

    def test_is_404_for_a_suite_that_is_not_there(self, api_client: TestClient, path: str) -> None:
        response = api_client.post(path.replace("/nts/", "/nope/"), json=ANY_METRIC)

        assert response.status_code == 404
        assert code_of(response) == "not_found"

    def test_is_not_shadowed_by_the_spa_catch_all(
        self, api_client: TestClient, suite: SuiteTables, path: str
    ) -> None:
        assert "<title>LNT</title>" not in api_client.post(path, json=ANY_METRIC).text

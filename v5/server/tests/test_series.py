"""`GET /series` (E9), over a real database: a machine's series, streamed as NDJSON."""

from __future__ import annotations

import gzip
import json
from collections.abc import Callable, Generator, Iterator
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from conftest import code_of, entry, run_payload, vary
from lnt_v5.routes import series as series_module
from lnt_v5.routes.commits import COMMITS_PATH
from lnt_v5.routes.machines import MACHINES_PATH
from lnt_v5.routes.runs import RUNS_PATH
from lnt_v5.routes.series import NDJSON, SERIES_PATH, SeriesInterruptedError
from lnt_v5.routes.suites import SUITES_PATH
from lnt_v5.routes.timeseries import QUERY_PATH
from lnt_v5.suites.tables import SuiteTables

SERIES = SERIES_PATH.format(testsuite="nts")
QUERY = QUERY_PATH.format(testsuite="nts")
RUNS = RUNS_PATH.format(testsuite="nts")
COMMITS = COMMITS_PATH.format(testsuite="nts")
MACHINES = MACHINES_PATH.format(testsuite="nts")

# What every request below sends, unless it says otherwise.
PARAMS = {"metric": "execution_time", "machine": "linux"}

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
) -> Callable[..., dict[str, Any]]:
    """Submit one run and hand back its detail body."""

    def post(machine: str, commit: str, *tests: dict[str, Any], **overrides: Any) -> dict[str, Any]:
        body = run_payload(
            machine={"name": machine}, commit={"value": commit}, tests=list(tests), **overrides
        )
        response = api_client.post(RUNS, json=body, headers=submitter)
        assert response.status_code == 201, response.text
        return dict(response.json())

    return post


@pytest.fixture
def place(api_client: TestClient, manage: dict[str, str]) -> Callable[[str, int], None]:
    """Give a commit an ordinal (O6)."""

    def patch(commit: str, ordinal: int) -> None:
        response = api_client.patch(
            f"{COMMITS}/{commit}", json={"ordinal": ordinal}, headers=manage
        )
        assert response.status_code == 200, response.text

    return patch


def get(api_client: TestClient, **params: Any) -> Any:
    return api_client.get(SERIES, params=PARAMS | params)


def lines(api_client: TestClient, **params: Any) -> list[dict[str, Any]]:
    response = get(api_client, **params)
    assert response.status_code == 200, response.text
    assert response.text == "" or response.text.endswith("\n")
    return [json.loads(line) for line in response.text.splitlines()]


def keys(served: list[dict[str, Any]]) -> list[tuple[str, str, Any]]:
    return [(line["test"], line["commit"], line["value"]) for line in served]


@pytest.fixture
def history(
    submit: Callable[..., dict[str, Any]], place: Callable[[str, int], None]
) -> list[dict[str, Any]]:
    """Two machines, two tests, three ordered commits submitted out of order, and an unordered one.

    The test names sort differently by code point than in most locales.
    """
    runs = []
    for index in (3, 1, 2):
        for machine in ("linux", "mac"):
            runs.append(
                submit(
                    machine,
                    f"c{index}",
                    entry("b", {"execution_time": float(index)}),
                    entry("B", {"execution_time": 10.0 * index}, {"execution_time": 10.0 * index}),
                )
            )
    for index in (1, 2, 3):
        place(f"c{index}", index * 10)
    submit("linux", "unordered", entry("b", {"execution_time": 9.0}))
    return runs


class TestSeriesResponse:
    def test_is_ndjson_of_query_points(
        self, api_client: TestClient, history: list[dict[str, Any]]
    ) -> None:
        response = get(api_client)

        assert response.status_code == 200
        assert response.headers["content-type"] == NDJSON
        queried = api_client.post(
            QUERY,
            json={"metric": "execution_time", "machine": "linux", "sort": "commit", "limit": 100},
        ).json()["items"]
        # The same objects, key for key and in the same key order, as `POST /query` returns.
        assert sorted(response.text.splitlines()) == sorted(
            json.dumps(point, separators=(",", ":")) for point in queried
        )

    def test_is_empty_when_nothing_matches(
        self, api_client: TestClient, history: list[dict[str, Any]]
    ) -> None:
        response = get(api_client, metric="compile_time")

        assert response.status_code == 200
        assert response.headers["content-type"] == NDJSON
        assert response.content == b""

    def test_is_empty_when_the_machine_has_no_run(
        self,
        api_client: TestClient,
        manage: dict[str, str],
        history: list[dict[str, Any]],
    ) -> None:
        assert api_client.post(MACHINES, json={"name": "new"}, headers=manage).status_code == 201

        assert lines(api_client, machine="new") == []

    def test_is_compressed_on_request(
        self, api_client: TestClient, history: list[dict[str, Any]]
    ) -> None:
        plain = get(api_client)
        with api_client.stream(
            "GET",
            SERIES,
            params=PARAMS,
            headers={"Accept-Encoding": "gzip"},
        ) as compressed:
            raw = b"".join(compressed.iter_raw())

        assert compressed.headers["content-encoding"] == "gzip"
        assert "Accept-Encoding" in vary(compressed)
        assert gzip.decompress(raw) == plain.content

    def test_carries_the_caching_headers(
        self, api_client: TestClient, history: list[dict[str, Any]]
    ) -> None:
        response = get(api_client)

        assert response.headers["cache-control"] == "no-cache, max-age=0"
        assert "Authorization" in vary(response)

    def test_answers_head_like_get(
        self, api_client: TestClient, history: list[dict[str, Any]]
    ) -> None:
        response = api_client.head(SERIES, params=PARAMS)

        assert response.status_code == 200
        assert response.headers["content-type"] == NDJSON
        assert response.content == b""


class TestSeriesOrder:
    def test_is_by_test_name_by_code_point_then_by_ordinal(
        self, api_client: TestClient, history: list[dict[str, Any]]
    ) -> None:
        assert keys(lines(api_client)) == [
            ("B", "c1", 10.0),
            ("B", "c1", 10.0),
            ("B", "c2", 20.0),
            ("B", "c2", 20.0),
            ("B", "c3", 30.0),
            ("B", "c3", 30.0),
            ("b", "c1", 1.0),
            ("b", "c2", 2.0),
            ("b", "c3", 3.0),
        ]

    def test_breaks_ties_between_runs_of_one_commit_by_uuid(
        self,
        api_client: TestClient,
        submit: Callable[..., dict[str, Any]],
        place: Callable[[str, int], None],
    ) -> None:
        uuids = ["ffffffff-0000-4000-8000-000000000000", "00000000-0000-4000-8000-000000000000"]
        for uuid in uuids:
            submit("linux", "c1", entry("t", {"execution_time": 1.0}), uuid=uuid)
        place("c1", 1)

        assert [line["run_uuid"] for line in lines(api_client)] == sorted(uuids)

    def test_puts_unordered_commits_last_only_when_asked(
        self, api_client: TestClient, history: list[dict[str, Any]]
    ) -> None:
        assert "unordered" not in {line["commit"] for line in lines(api_client)}

        served = lines(api_client, include_unordered="true")

        assert keys(served)[-4:] == [
            ("b", "c1", 1.0),
            ("b", "c2", 2.0),
            ("b", "c3", 3.0),
            ("b", "unordered", 9.0),
        ]
        assert served[-1]["ordinal"] is None

    def test_does_not_depend_on_the_batch_or_chunk_size(
        self,
        api_client: TestClient,
        history: list[dict[str, Any]],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        whole = get(api_client, include_unordered="true").content
        # One test per batch, and every batch sent in a chunk of its own.
        monkeypatch.setattr(series_module, "BATCH_ROWS", 1)
        monkeypatch.setattr(series_module, "CHUNK_BYTES", 1)

        assert get(api_client, include_unordered="true").content == whole


class TestSeriesFilters:
    def test_returns_only_the_named_tests(
        self, api_client: TestClient, history: list[dict[str, Any]]
    ) -> None:
        assert {line["test"] for line in lines(api_client, test=["b"])} == {"b"}
        assert {line["test"] for line in lines(api_client, test=["b", "B"])} == {"b", "B"}

    def test_returns_only_the_machine(
        self, api_client: TestClient, history: list[dict[str, Any]]
    ) -> None:
        assert {line["machine"] for line in lines(api_client, machine="mac")} == {"mac"}

    def test_returns_one_commit(
        self, api_client: TestClient, history: list[dict[str, Any]]
    ) -> None:
        assert keys(lines(api_client, commit="c2")) == [("B", "c2", 20.0)] * 2 + [("b", "c2", 2.0)]

    def test_returns_an_unordered_commit_only_when_asked(
        self, api_client: TestClient, history: list[dict[str, Any]]
    ) -> None:
        assert lines(api_client, commit="unordered") == []
        assert keys(lines(api_client, commit="unordered", include_unordered="true")) == [
            ("b", "unordered", 9.0)
        ]

    def test_an_unknown_commit_is_empty(
        self, api_client: TestClient, history: list[dict[str, Any]]
    ) -> None:
        assert lines(api_client, commit="nope") == []

    def test_bounds_the_commits(
        self, api_client: TestClient, history: list[dict[str, Any]]
    ) -> None:
        assert {line["commit"] for line in lines(api_client, after_commit="c1")} == {"c2", "c3"}
        assert {line["commit"] for line in lines(api_client, before_commit="c3")} == {"c1", "c2"}

    def test_bounds_the_submission_time(
        self, api_client: TestClient, history: list[dict[str, Any]]
    ) -> None:
        linux = [run for run in history if run["machine"] == "linux"]

        served = lines(api_client, submitted_before=linux[1]["submitted_at"])

        assert {line["run_uuid"] for line in served} == {linux[0]["uuid"]}

    def test_bounds_the_measurement_time(
        self, api_client: TestClient, history: list[dict[str, Any]]
    ) -> None:
        linux = [run for run in history if run["machine"] == "linux"]

        served = lines(api_client, measured_after=linux[1]["measured_at"])

        assert {line["run_uuid"] for line in served} == {linux[2]["uuid"]}


class TestSeriesErrors:
    @pytest.mark.parametrize("missing", ["metric", "machine"])
    def test_requires_the_metric_and_the_machine(
        self, api_client: TestClient, history: list[dict[str, Any]], missing: str
    ) -> None:
        params = {key: value for key, value in PARAMS.items() if key != missing}

        response = api_client.get(SERIES, params=params)

        assert response.status_code == 400
        assert code_of(response) == "invalid_request"

    def test_an_unknown_metric_is_400(
        self, api_client: TestClient, history: list[dict[str, Any]]
    ) -> None:
        assert get(api_client, metric="nope").status_code == 400

    @pytest.mark.parametrize(
        "params",
        [{"machine": "nope"}, {"test": ["b", "nope"]}, {"after_commit": "nope"}],
    )
    def test_an_unknown_entity_is_404(
        self, api_client: TestClient, history: list[dict[str, Any]], params: dict[str, Any]
    ) -> None:
        response = get(api_client, **params)

        assert response.status_code == 404
        assert code_of(response) == "not_found"

    def test_an_unknown_suite_is_404(self, api_client: TestClient) -> None:
        response = api_client.get(
            SERIES_PATH.format(testsuite="nope"), params={"metric": "m", "machine": "linux"}
        )

        assert response.status_code == 404

    @pytest.mark.parametrize(
        "params",
        [
            {"commit": "c1", "after_commit": "c2"},
            {"commit": "c1", "before_commit": "c2"},
            {"include_unordered": "true", "after_commit": "c1"},
            {"include_unordered": "true", "before_commit": "c3"},
            {"after_commit": "unordered"},
            {"machine": ["linux", "mac"]},
            {"limit": "10"},
            {"submitted_before": "1700000000"},
        ],
    )
    def test_refuses_an_invalid_request(
        self, api_client: TestClient, history: list[dict[str, Any]], params: dict[str, Any]
    ) -> None:
        response = get(api_client, **params)

        assert response.status_code == 400
        assert code_of(response) == "invalid_request"


@pytest.fixture
def captured(monkeypatch: pytest.MonkeyPatch) -> list[Generator[bytes]]:
    """The response bodies the endpoint builds, kept to be driven by hand rather than served.

    The test client reads a body to the end before it returns, so it can neither stop half-way
    nor let anything happen between two batches.
    """
    bodies: list[Generator[bytes]] = []
    real = series_module.stream

    def keep(*args: Any) -> Iterator[bytes]:
        bodies.append(real(*args))
        return iter(())

    monkeypatch.setattr(series_module, "stream", keep)
    # One test per batch, each sent as soon as it is read.
    monkeypatch.setattr(series_module, "BATCH_ROWS", 1)
    monkeypatch.setattr(series_module, "CHUNK_BYTES", 1)
    return bodies


class TestSeriesStreaming:
    def test_sends_the_headers_before_reading_anything(
        self,
        api_client: TestClient,
        history: list[dict[str, Any]],
        captured: list[Generator[bytes]],
    ) -> None:
        get(api_client)

        assert next(captured[0]) == b""

    def test_holds_no_connection_between_chunks(
        self,
        api_app: FastAPI,
        api_client: TestClient,
        history: list[dict[str, Any]],
        captured: list[Generator[bytes]],
    ) -> None:
        get(api_client)
        body = captured[0]
        pool = api_app.state.engine.pool

        next(body)
        first = next(body)
        assert first.decode().splitlines()[0].startswith('{"test":"B"')
        assert pool.checkedout() == 0
        # A client that goes away: the body is closed half-way.
        body.close()
        assert pool.checkedout() == 0

    def test_aborts_when_the_machine_is_deleted(
        self,
        api_client: TestClient,
        manage: dict[str, str],
        history: list[dict[str, Any]],
        captured: list[Generator[bytes]],
    ) -> None:
        get(api_client)
        body = captured[0]
        next(body)
        next(body)

        assert api_client.delete(f"{MACHINES}/linux", headers=manage).status_code == 204

        # The next batch would be empty rather than fail.
        with pytest.raises(SeriesInterruptedError, match="deleted"):
            next(body)

    def test_aborts_when_a_metric_is_removed_and_added_back(
        self,
        api_client: TestClient,
        manage: dict[str, str],
        history: list[dict[str, Any]],
        captured: list[Generator[bytes]],
    ) -> None:
        get(api_client)
        body = captured[0]
        next(body)
        next(body)

        schema = f"{SUITES_PATH}/nts/schema"
        removed = api_client.patch(
            f"{schema}?confirm=true",
            json={"metrics": {"remove": ["execution_time"]}},
            headers=manage,
        )
        assert removed.status_code == 200, removed.text
        added = api_client.patch(
            schema,
            json={"metrics": {"add": [{"name": "execution_time", "type": "real"}]}},
            headers=manage,
        )
        assert added.status_code == 200, added.text

        # The column is back, empty: the next batch would be empty rather than fail.
        with pytest.raises(SeriesInterruptedError, match="schema"):
            next(body)

    def test_a_failure_mid_stream_reaches_the_server(
        self,
        api_client: TestClient,
        history: list[dict[str, Any]],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """Raised out of the body, which is what makes the server abort the response."""

        def fail(*args: Any) -> None:
            raise SeriesInterruptedError("boom")

        monkeypatch.setattr(series_module.Series, "check", fail)

        with pytest.raises(SeriesInterruptedError):
            get(api_client)

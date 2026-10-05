"""Real `nts` runs from lnt.llvm.org, submitted and read back through the API.

The other modules cover each endpoint's rules with synthetic data. This one is about real data end
to end instead: test names full of punctuation, kilobytes of multi-line compiler provenance in
`run_parameters`, metrics that only some tests carry, and repetitions within a run, for three
machines over three commits. data/nts/README.md says where the data comes from.

Each run is submitted as its file's bytes rather than re-serialized, so that the server receives
exactly what a producer sent. Most expectations are derived from the submissions, so that a test
says "what was submitted reads back" rather than restating hundreds of values. The derivations
deliberately share no code with the server, since they are what it is checked against. A few values
are written out by hand, so that a mistake made the same way on both sides of a comparison cannot go
unnoticed.
"""

from __future__ import annotations

import json
import math
import statistics
from collections.abc import Callable
from pathlib import Path
from typing import Any
from urllib.parse import urlencode

import pytest
from fastapi.testclient import TestClient

from conftest import code_of, walk_cursor, walk_pages
from lnt_v5.routes.commits import COMMITS_PATH
from lnt_v5.routes.machines import MACHINES_PATH
from lnt_v5.routes.runs import RUNS_PATH
from lnt_v5.routes.samples import SAMPLES_PATH
from lnt_v5.routes.tests import TESTS_PATH
from lnt_v5.routes.timeseries import QUERY_PATH, TRENDS_PATH
from lnt_v5.suites.tables import SuiteTables

DATA = Path(__file__).parent / "data" / "nts"
SCHEMA: dict[str, Any] = json.loads((DATA / "schema.json").read_text())
RUN_FILES = sorted((DATA / "runs").glob("*.json"))
# Each submission, keyed by its file's stem, in the order of `RUN_FILES`.
BY_FILE: dict[str, dict[str, Any]] = {path.stem: json.loads(path.read_text()) for path in RUN_FILES}
SUBMISSIONS = list(BY_FILE.values())

RUNS = RUNS_PATH.format(testsuite="nts")
MACHINES = MACHINES_PATH.format(testsuite="nts")
COMMITS = COMMITS_PATH.format(testsuite="nts")
TESTS = TESTS_PATH.format(testsuite="nts")
QUERY = QUERY_PATH.format(testsuite="nts")
TRENDS = TRENDS_PATH.format(testsuite="nts")

MACHINE_NAMES = sorted({run["machine"]["name"] for run in SUBMISSIONS})
# The commit objects the submissions carry, oldest first. Every machine ran at the same three.
ORDERED_COMMITS = sorted(
    {run["commit"]["value"]: run["commit"] for run in SUBMISSIONS}.values(),
    key=lambda commit: commit["ordinal"],
)

NAMD = "External/SPEC/CFP2017rate/508.namd_r/508.namd_r"
MEMCMP = "MicroBenchmarks/MemFunctions/MemFunctions.test:BM_MemCmp<1, EqZero, First>"


def samples(entry: dict[str, Any]) -> list[dict[str, Any]]:
    """The samples a test entry stands for (O1), shaped like the sample list's items.

    One per array element, with the entry's scalars repeated on each.
    """
    metrics = {key: value for key, value in entry.items() if key != "name"}
    count = max((len(value) for value in metrics.values() if isinstance(value, list)), default=1)
    return [
        {
            "test": entry["name"],
            "metrics": {
                key: value[index] if isinstance(value, list) else value
                for key, value in metrics.items()
            },
        }
        for index in range(count)
    ]


def canonical(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """The items in an order of their own, for comparing lists the API leaves unordered.

    Keyed on sorted keys, so that two equal dicts whose keys were inserted in another order still
    sort alike.
    """
    return sorted(items, key=lambda item: json.dumps(item, sort_keys=True))


def run_geomean(run: dict[str, Any], metric: str) -> float:
    """O9 under the default `median` aggregation.

    A test's samples reduce to their median, and the run's value is the geomean of those, skipping
    any that are not positive.
    """
    medians = [
        statistics.median(values)
        for entry in run["tests"]
        if (values := [s["metrics"][metric] for s in samples(entry) if metric in s["metrics"]])
    ]
    logs = [math.log(value) for value in medians if value > 0]
    return math.exp(sum(logs) / len(logs))


def body_of(response: Any) -> Any:
    """The body of a response, having checked that it is a 200.

    So that a request that failed is reported as such, rather than as a key missing from its body.
    """
    assert response.status_code == 200, response.text
    return response.json()


def submit(api_client: TestClient, submitter: dict[str, str], path: Path) -> Any:
    """POST a run file as it is."""
    headers = submitter | {"Content-Type": "application/json"}
    return api_client.post(RUNS, content=path.read_bytes(), headers=headers)


@pytest.fixture
def suite(make_api_suite: Callable[[dict[str, Any]], SuiteTables]) -> SuiteTables:
    return make_api_suite(SCHEMA)


@pytest.fixture
def submitted(api_client: TestClient, submitter: dict[str, str], suite: SuiteTables) -> list[Any]:
    """Every run submitted, and the responses, in the order of `SUBMISSIONS`."""
    responses = [submit(api_client, submitter, path) for path in RUN_FILES]
    for response in responses:
        assert response.status_code == 201, response.text
    return responses


class TestSubmission:
    def test_every_run_is_stored_under_its_own_uuid(self, submitted: list[Any]) -> None:
        for run, response in zip(SUBMISSIONS, submitted, strict=True):
            assert response.headers["Location"] == f"{RUNS}/{run['uuid']}"

    def test_resubmitting_a_run_is_refused_as_a_duplicate(
        self, api_client: TestClient, submitter: dict[str, str], submitted: list[Any]
    ) -> None:
        response = submit(api_client, submitter, RUN_FILES[0])

        assert response.status_code == 409
        assert code_of(response) == "duplicate"
        assert len(walk_pages(api_client, RUNS)) == len(SUBMISSIONS)


class TestReadBack:
    def test_every_run_reads_back_as_sent(
        self, api_client: TestClient, submitted: list[Any]
    ) -> None:
        for run in SUBMISSIONS:
            body = body_of(api_client.get(f"{RUNS}/{run['uuid']}"))

            assert {key: body[key] for key in ("uuid", "machine", "commit", "run_parameters")} == {
                "uuid": run["uuid"],
                "machine": run["machine"]["name"],
                "commit": run["commit"]["value"],
                "run_parameters": run["run_parameters"],
            }

    def test_every_repetition_reads_back_as_a_sample(
        self, api_client: TestClient, submitted: list[Any]
    ) -> None:
        for run in SUBMISSIONS:
            # At the default page size, so that the walk crosses several pages of real names.
            served = walk_pages(api_client, SAMPLES_PATH.format(testsuite="nts", uuid=run["uuid"]))

            expected = [sample for entry in run["tests"] for sample in samples(entry)]
            assert canonical(served) == canonical(expected)

    def test_the_submissions_created_the_machines(
        self, api_client: TestClient, submitted: list[Any]
    ) -> None:
        body = body_of(api_client.get(MACHINES))

        assert body["total"] == len(MACHINE_NAMES)
        assert [machine["name"] for machine in body["items"]] == MACHINE_NAMES
        assert all(m["tracked"] and m["last_run_at"] is not None for m in body["items"])

    def test_the_submissions_created_the_commits_in_ordinal_order(
        self, api_client: TestClient, submitted: list[Any]
    ) -> None:
        assert walk_pages(api_client, COMMITS, "sort=ordinal") == [
            {"value": c["value"], "ordinal": c["ordinal"], "tag": None, "fields": c["fields"]}
            for c in ORDERED_COMMITS
        ]

    def test_a_commit_links_to_its_neighbours(
        self, api_client: TestClient, submitted: list[Any]
    ) -> None:
        oldest, middle, newest = (commit["value"] for commit in ORDERED_COMMITS)

        body = body_of(api_client.get(f"{COMMITS}/{middle}"))

        assert body["previous"]["value"] == oldest
        assert body["next"]["value"] == newest

    def test_values_copied_by_hand_from_lnt_llvm_org(
        self, api_client: TestClient, submitted: list[Any]
    ) -> None:
        uuid = BY_FILE["r598181-sifive"]["uuid"]
        samples_path = SAMPLES_PATH.format(testsuite="nts", uuid=uuid)

        namd = [
            s["metrics"]
            for s in body_of(api_client.get(samples_path, params={"test": NAMD}))["items"]
        ]
        assert sorted(metrics["execution_time"] for metrics in namd) == [77.3951, 77.4685, 77.6171]
        others = [{k: v for k, v in metrics.items() if k != "execution_time"} for metrics in namd]
        assert others == 3 * [{"code_size": 383518, "hash": "9cfd3c5460f1d1930fe34bf9bc55b91a"}]

        memcmp = body_of(api_client.get(samples_path, params={"test": MEMCMP}))["items"]
        assert sorted(s["metrics"]["execution_time"] for s in memcmp) == [
            11881.278538812785,
            11882.448840961193,
            11884.851777649495,
        ]

        commit = body_of(api_client.get(f"{COMMITS}/dc0abebc8e834bceea9a467f07e124ab944e9be9"))
        assert commit["ordinal"] == 598181
        assert commit["fields"] == {"llvm_project_revision": "r598181"}


class TestTimeSeries:
    def test_a_query_reads_back_across_commits_in_ordinal_order(
        self, api_client: TestClient, submitted: list[Any]
    ) -> None:
        machine = MACHINE_NAMES[0]
        body = {"metric": "execution_time", "machine": machine, "test": [NAMD], "sort": "commit"}

        served = walk_cursor(
            lambda cursor: api_client.post(
                QUERY, json=body if cursor is None else body | {"cursor": cursor}
            )
        )

        assert [point["ordinal"] for point in served] == sorted(p["ordinal"] for p in served)
        expected = [
            {
                "test": NAMD,
                "machine": machine,
                "metric": "execution_time",
                "value": sample["metrics"]["execution_time"],
                "commit": run["commit"]["value"],
                "ordinal": run["commit"]["ordinal"],
                "run_uuid": run["uuid"],
                "tag": None,
            }
            for run in SUBMISSIONS
            if run["machine"]["name"] == machine
            for entry in run["tests"]
            if entry["name"] == NAMD
            for sample in samples(entry)
        ]
        # `submitted_at` is the server's clock, which nothing submitted can predict.
        stripped = [{k: v for k, v in point.items() if k != "submitted_at"} for point in served]
        assert canonical(stripped) == canonical(expected)

    def test_trends_are_the_geomean_of_each_runs_per_test_medians(
        self, api_client: TestClient, submitted: list[Any]
    ) -> None:
        response = api_client.get(
            TRENDS,
            params=[("metric", "execution_time"), *(("machine", name) for name in MACHINE_NAMES)],
        )

        items = body_of(response)["items"]
        # One run per machine and commit here, so each trend point is that one run's geomean.
        expected = sorted(
            (
                {
                    "machine": run["machine"]["name"],
                    "commit": run["commit"]["value"],
                    "ordinal": run["commit"]["ordinal"],
                    "value": run_geomean(run, "execution_time"),
                }
                for run in SUBMISSIONS
            ),
            key=lambda item: (item["machine"], item["ordinal"]),
        )
        assert [{k: item[k] for k in ("machine", "commit", "ordinal")} for item in items] == [
            {k: item[k] for k in ("machine", "commit", "ordinal")} for item in expected
        ]
        assert [item["value"] for item in items] == pytest.approx(
            [item["value"] for item in expected], rel=1e-9
        )


class TestTests:
    def test_every_submitted_test_is_listed(
        self, api_client: TestClient, submitted: list[Any]
    ) -> None:
        names = {entry["name"] for run in SUBMISSIONS for entry in run["tests"]}

        assert sorted(test["name"] for test in walk_pages(api_client, TESTS)) == sorted(names)

    @pytest.mark.parametrize("metric", ["execution_time", "code_size", "hash"])
    def test_the_list_is_filtered_by_machine_and_metric(
        self, api_client: TestClient, submitted: list[Any], metric: str
    ) -> None:
        machine = MACHINE_NAMES[0]
        names = {
            entry["name"]
            for run in SUBMISSIONS
            if run["machine"]["name"] == machine
            for entry in run["tests"]
            if metric in entry
        }

        served = walk_pages(api_client, TESTS, urlencode({"machine": machine, "metric": metric}))

        assert sorted(test["name"] for test in served) == sorted(names)

    def test_a_declared_metric_no_bot_reports_has_no_tests(
        self, api_client: TestClient, submitted: list[Any]
    ) -> None:
        assert body_of(api_client.get(TESTS, params={"metric": "compile_time"}))["items"] == []

    def test_the_list_is_searched_case_insensitively(
        self, api_client: TestClient, submitted: list[Any]
    ) -> None:
        body = body_of(api_client.get(TESTS, params={"search": "eqzero, first"}))

        assert body["items"] == [{"name": MEMCMP}]

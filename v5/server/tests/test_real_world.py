"""Real runs from LLVM's LNT v4 instance, submitted and read back through the API.

The other modules cover each endpoint's rules with synthetic data. This one is about real data end
to end instead, from two suites whose producers differ in the shapes they send. `nts` carries test
names full of punctuation, kilobytes of multi-line compiler provenance in `run_parameters`, metrics
that only some tests carry, and repetitions within a run. `libcxx` carries populated machine fields,
several runs per machine and commit instead of repetitions, runs with no tests at all, and tests
that only some machines run. The README beside each suite's data says where it comes from.

Each run is submitted as its file's bytes rather than re-serialized, so that the server receives
exactly what a producer sent. Most expectations are derived from the submissions, so that a test
says "what was submitted reads back" rather than restating hundreds of values; those tests run
against both suites. The derivations deliberately share no code with the server, since they are
what it is checked against. A few values are written out by hand, so that a mistake made the same
way on both sides of a comparison cannot go unnoticed.
"""

from __future__ import annotations

import json
import math
import statistics
from collections import defaultdict
from collections.abc import Callable
from dataclasses import dataclass
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

DATA = Path(__file__).parent / "data"

NAMD = "External/SPEC/CFP2017rate/508.namd_r/508.namd_r"
MEMCMP = "MicroBenchmarks/MemFunctions/MemFunctions.test:BM_MemCmp<1, EqZero, First>"
PRINT = 'std::print("Hello,_World!")'
VPRINT = 'std::vprint_unicode("Hello,_World!")'
BITSET = "BM_BitsetToString<1048576>/Dense_(90%)/90"
FROM_SYS = "BM_from_sys/1970/threads:4"


@dataclass(frozen=True)
class Dataset:
    """One suite's real runs, as data/ holds them, and what the tests need to know about them."""

    name: str
    schema: dict[str, Any]
    files: list[Path]
    # Each submission, keyed by its file's stem, in the order of `files`.
    by_file: dict[str, dict[str, Any]]
    # A test every machine measured, whose time series is queried.
    series_test: str
    # A `search=` term for the test list, and the names it matches.
    search: tuple[str, list[str]]

    @property
    def submissions(self) -> list[dict[str, Any]]:
        return list(self.by_file.values())

    @property
    def machine_names(self) -> list[str]:
        return sorted({run["machine"]["name"] for run in self.submissions})

    @property
    def ordered_commits(self) -> list[dict[str, Any]]:
        """The commit objects the submissions carry, oldest first."""
        commits = {run["commit"]["value"]: run["commit"] for run in self.submissions}
        return sorted(commits.values(), key=lambda commit: commit["ordinal"])

    def declared(self, kind: str, fields: dict[str, Any]) -> dict[str, Any]:
        """`fields` as a response carries it: every declared field, null where unset (I4)."""
        return {entry["name"]: fields.get(entry["name"]) for entry in self.schema[kind]}

    def url(self, template: str, **params: str) -> str:
        return template.format(testsuite=self.name, **params)


def load(name: str, *, series_test: str, search: tuple[str, list[str]]) -> Dataset:
    files = sorted((DATA / name / "runs").glob("*.json"))
    return Dataset(
        name=name,
        schema=json.loads((DATA / name / "schema.json").read_text()),
        files=files,
        by_file={path.stem: json.loads(path.read_text()) for path in files},
        series_test=series_test,
        search=search,
    )


DATASETS = {
    dataset.name: dataset
    for dataset in [
        load("nts", series_test=NAMD, search=("eqzero, first", [MEMCMP])),
        load("libcxx", series_test=BITSET, search=("HELLO,_WORLD", [PRINT, VPRINT])),
    ]
}

EVERY_SUITE = pytest.mark.parametrize("dataset", sorted(DATASETS), indirect=True)


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


def geomean(values: list[float]) -> float | None:
    """The geometric mean of the positive values, or None if there are none."""
    logs = [math.log(value) for value in values if value > 0]
    return math.exp(sum(logs) / len(logs)) if logs else None


def run_geomean(run: dict[str, Any], metric: str) -> float | None:
    """O9 under the default `median` aggregation: the geomean of each test's median."""
    return geomean(
        [
            statistics.median(values)
            for entry in run["tests"]
            if (values := [s["metrics"][metric] for s in samples(entry) if metric in s["metrics"]])
        ]
    )


def trend(dataset: Dataset, metric: str) -> list[dict[str, Any]]:
    """E9's trend items: the geomean of the run geomeans at each machine and commit.

    A machine and commit with no run geomean -- every run there empty -- has no item.
    """
    run_geomeans: defaultdict[tuple[str, str, int], list[float]] = defaultdict(list)
    for run in dataset.submissions:
        if (value := run_geomean(run, metric)) is not None:
            key = (run["machine"]["name"], run["commit"]["value"], run["commit"]["ordinal"])
            run_geomeans[key].append(value)
    return [
        {"machine": machine, "commit": commit, "ordinal": ordinal, "value": geomean(values)}
        for (machine, commit, ordinal), values in sorted(
            run_geomeans.items(), key=lambda item: (item[0][0], item[0][2])
        )
    ]


def body_of(response: Any) -> Any:
    """The body of a response, having checked that it is a 200.

    So that a request that failed is reported as such, rather than as a key missing from its body.
    """
    assert response.status_code == 200, response.text
    return response.json()


def submit(api_client: TestClient, submitter: dict[str, str], dataset: Dataset, path: Path) -> Any:
    """POST a run file as it is."""
    headers = submitter | {"Content-Type": "application/json"}
    return api_client.post(dataset.url(RUNS_PATH), content=path.read_bytes(), headers=headers)


def query(api_client: TestClient, dataset: Dataset, body: dict[str, Any]) -> list[Any]:
    """Every point `POST /query` serves for the body, following the cursor to the end."""
    return walk_cursor(
        lambda cursor: api_client.post(
            dataset.url(QUERY_PATH), json=body if cursor is None else body | {"cursor": cursor}
        )
    )


@pytest.fixture
def dataset(request: pytest.FixtureRequest) -> Dataset:
    return DATASETS[request.param]


@pytest.fixture
def submitted(
    api_client: TestClient,
    submitter: dict[str, str],
    make_api_suite: Callable[[dict[str, Any]], SuiteTables],
    dataset: Dataset,
) -> list[Any]:
    """The suite created, and every run submitted; the responses, in the order of `files`."""
    make_api_suite(dataset.schema)
    responses = [submit(api_client, submitter, dataset, path) for path in dataset.files]
    for response in responses:
        assert response.status_code == 201, response.text
    return responses


@EVERY_SUITE
class TestSubmission:
    def test_every_run_is_stored_under_its_own_uuid(
        self, dataset: Dataset, submitted: list[Any]
    ) -> None:
        for run, response in zip(dataset.submissions, submitted, strict=True):
            assert response.headers["Location"] == f"{dataset.url(RUNS_PATH)}/{run['uuid']}"

    def test_resubmitting_a_run_is_refused_as_a_duplicate(
        self,
        api_client: TestClient,
        submitter: dict[str, str],
        dataset: Dataset,
        submitted: list[Any],
    ) -> None:
        response = submit(api_client, submitter, dataset, dataset.files[0])

        assert response.status_code == 409
        assert code_of(response) == "duplicate"
        assert len(walk_pages(api_client, dataset.url(RUNS_PATH))) == len(dataset.submissions)


@EVERY_SUITE
class TestReadBack:
    def test_every_run_reads_back_as_sent(
        self, api_client: TestClient, dataset: Dataset, submitted: list[Any]
    ) -> None:
        for run in dataset.submissions:
            body = body_of(api_client.get(f"{dataset.url(RUNS_PATH)}/{run['uuid']}"))

            assert {key: body[key] for key in ("uuid", "machine", "commit", "run_parameters")} == {
                "uuid": run["uuid"],
                "machine": run["machine"]["name"],
                "commit": run["commit"]["value"],
                "run_parameters": run["run_parameters"],
            }

    def test_every_sample_reads_back(
        self, api_client: TestClient, dataset: Dataset, submitted: list[Any]
    ) -> None:
        for run in dataset.submissions:
            # At the default page size, so that the walk crosses several pages of real names.
            served = walk_pages(api_client, dataset.url(SAMPLES_PATH, uuid=run["uuid"]))

            expected = [sample for entry in run["tests"] for sample in samples(entry)]
            assert canonical(served) == canonical(expected)

    def test_the_submissions_created_the_machines(
        self, api_client: TestClient, dataset: Dataset, submitted: list[Any]
    ) -> None:
        fields = {
            run["machine"]["name"]: run["machine"].get("fields", {}) for run in dataset.submissions
        }

        body = body_of(api_client.get(dataset.url(MACHINES_PATH)))

        assert body["total"] == len(dataset.machine_names)
        assert all(machine["last_run_at"] is not None for machine in body["items"])
        served = [{k: v for k, v in m.items() if k != "last_run_at"} for m in body["items"]]
        assert served == [
            {
                "name": name,
                "tracked": True,
                "fields": dataset.declared("machine_fields", fields[name]),
            }
            for name in dataset.machine_names
        ]

    def test_the_submissions_created_the_commits_in_ordinal_order(
        self, api_client: TestClient, dataset: Dataset, submitted: list[Any]
    ) -> None:
        assert walk_pages(api_client, dataset.url(COMMITS_PATH), "sort=ordinal") == [
            {
                "value": c["value"],
                "ordinal": c["ordinal"],
                "tag": None,
                "fields": dataset.declared("commit_fields", c["fields"]),
            }
            for c in dataset.ordered_commits
        ]

    def test_each_commit_links_to_its_neighbours(
        self, api_client: TestClient, dataset: Dataset, submitted: list[Any]
    ) -> None:
        values = [commit["value"] for commit in dataset.ordered_commits]
        for index, value in enumerate(values):
            body = body_of(api_client.get(f"{dataset.url(COMMITS_PATH)}/{value}"))

            previous = values[index - 1] if index > 0 else None
            following = values[index + 1] if index + 1 < len(values) else None
            assert (body["previous"] or {}).get("value") == previous
            assert (body["next"] or {}).get("value") == following

    def test_commits_are_searched_by_their_svn_revision(
        self, api_client: TestClient, dataset: Dataset, submitted: list[Any]
    ) -> None:
        for commit in dataset.ordered_commits:
            # No SHA contains an `r`, so only the field can match.
            revision = commit["fields"]["svn_revision"]

            served = walk_pages(
                api_client, dataset.url(COMMITS_PATH), urlencode({"search": revision})
            )

            assert [c["value"] for c in served] == [commit["value"]]

    def test_the_runs_of_each_machine_at_each_commit_are_listed(
        self, api_client: TestClient, dataset: Dataset, submitted: list[Any]
    ) -> None:
        for machine in dataset.machine_names:
            for commit in dataset.ordered_commits:
                expected = {
                    run["uuid"]
                    for run in dataset.submissions
                    if run["machine"]["name"] == machine
                    and run["commit"]["value"] == commit["value"]
                }

                query = urlencode({"machine": machine, "commit": commit["value"]})
                served = walk_pages(api_client, dataset.url(RUNS_PATH), query)

                assert {run["uuid"] for run in served} == expected


@EVERY_SUITE
class TestTimeSeries:
    def test_a_query_reads_back_across_commits_in_ordinal_order(
        self, api_client: TestClient, dataset: Dataset, submitted: list[Any]
    ) -> None:
        test = dataset.series_test
        for machine in dataset.machine_names:
            served = query(
                api_client,
                dataset,
                {"metric": "execution_time", "machine": machine, "test": [test], "sort": "commit"},
            )

            assert [point["ordinal"] for point in served] == sorted(p["ordinal"] for p in served)
            expected = [
                {
                    "test": test,
                    "machine": machine,
                    "metric": "execution_time",
                    "value": sample["metrics"]["execution_time"],
                    "commit": run["commit"]["value"],
                    "ordinal": run["commit"]["ordinal"],
                    "run_uuid": run["uuid"],
                    "tag": None,
                }
                for run in dataset.submissions
                if run["machine"]["name"] == machine
                for entry in run["tests"]
                if entry["name"] == test
                for sample in samples(entry)
            ]
            # `submitted_at` is the server's clock, which nothing submitted can predict.
            stripped = [{k: v for k, v in point.items() if k != "submitted_at"} for point in served]
            assert canonical(stripped) == canonical(expected)

    def test_trends_are_the_geomean_of_the_run_geomeans(
        self, api_client: TestClient, dataset: Dataset, submitted: list[Any]
    ) -> None:
        response = api_client.get(
            dataset.url(TRENDS_PATH),
            params=[("metric", "execution_time"), *(("machine", m) for m in dataset.machine_names)],
        )

        items = body_of(response)["items"]
        expected = trend(dataset, "execution_time")
        assert [{k: item[k] for k in ("machine", "commit", "ordinal")} for item in items] == [
            {k: item[k] for k in ("machine", "commit", "ordinal")} for item in expected
        ]
        assert [item["value"] for item in items] == pytest.approx(
            [item["value"] for item in expected], rel=1e-9
        )


@EVERY_SUITE
class TestTests:
    def test_every_submitted_test_is_listed(
        self, api_client: TestClient, dataset: Dataset, submitted: list[Any]
    ) -> None:
        names = {entry["name"] for run in dataset.submissions for entry in run["tests"]}

        served = walk_pages(api_client, dataset.url(TESTS_PATH))

        assert sorted(test["name"] for test in served) == sorted(names)

    def test_the_list_is_filtered_by_machine_and_metric(
        self, api_client: TestClient, dataset: Dataset, submitted: list[Any]
    ) -> None:
        # Every declared metric, including those no producer reports, which list no test.
        for machine in dataset.machine_names:
            for metric in (entry["name"] for entry in dataset.schema["metrics"]):
                names = {
                    entry["name"]
                    for run in dataset.submissions
                    if run["machine"]["name"] == machine
                    for entry in run["tests"]
                    if metric in entry
                }

                query = urlencode({"machine": machine, "metric": metric})
                served = walk_pages(api_client, dataset.url(TESTS_PATH), query)

                assert sorted(test["name"] for test in served) == sorted(names), (machine, metric)

    def test_the_list_is_searched_case_insensitively(
        self, api_client: TestClient, dataset: Dataset, submitted: list[Any]
    ) -> None:
        term, names = dataset.search

        body = body_of(api_client.get(dataset.url(TESTS_PATH), params={"search": term}))

        assert sorted(test["name"] for test in body["items"]) == sorted(names)


@pytest.mark.parametrize("dataset", ["nts"], indirect=True)
class TestNts:
    def test_values_copied_by_hand_from_the_v4_instance(
        self, api_client: TestClient, dataset: Dataset, submitted: list[Any]
    ) -> None:
        samples_path = dataset.url(SAMPLES_PATH, uuid=dataset.by_file["r598181-sifive"]["uuid"])

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

        commit = body_of(
            api_client.get(f"{dataset.url(COMMITS_PATH)}/dc0abebc8e834bceea9a467f07e124ab944e9be9")
        )
        assert commit["ordinal"] == 598181
        assert commit["fields"] == {"svn_revision": "r598181"}


@pytest.mark.parametrize("dataset", ["libcxx"], indirect=True)
class TestLibcxx:
    # The commit at which every run, on every machine, reported no tests.
    FAILED = "97367d1046a2ec81e9b4e708ae7acdc83d99dcf7"

    def test_values_copied_by_hand_from_the_v4_instance(
        self, api_client: TestClient, dataset: Dataset, submitted: list[Any]
    ) -> None:
        # v4 run 339, on the Linux machine.
        samples_path = dataset.url(SAMPLES_PATH, uuid=dataset.by_file["r554973-linux-1"]["uuid"])

        for test, value in [(PRINT, 532.9731275614754), (FROM_SYS, 152.59618881588426)]:
            body = body_of(api_client.get(samples_path, params={"test": test}))
            assert body["items"] == [{"test": test, "metrics": {"execution_time": value}}]

        machine = body_of(api_client.get(f"{dataset.url(MACHINES_PATH)}/macos-26.5-arm64-20260812"))
        assert machine["fields"] == {
            "hardware": "Apple M4",
            "os": "macOS 26.5 (25F71)",
            "test_suite_commit": "8bb5e216937e6b541f351aa1637c67e85a43ada0",
            "compiler": "Apple clang version 21.0.0 (clang-2100.1.1.101)",
            "sdk": "26.5",
        }

    def test_a_commit_at_which_every_run_failed_has_runs_but_no_data(
        self, api_client: TestClient, dataset: Dataset, submitted: list[Any]
    ) -> None:
        runs = walk_pages(api_client, dataset.url(RUNS_PATH), urlencode({"commit": self.FAILED}))

        assert len(runs) == 11
        for run in runs:
            assert walk_pages(api_client, dataset.url(SAMPLES_PATH, uuid=run["uuid"])) == []

        response = api_client.get(
            dataset.url(TRENDS_PATH),
            params=[("metric", "execution_time"), *(("machine", m) for m in dataset.machine_names)],
        )
        assert self.FAILED not in {item["commit"] for item in body_of(response)["items"]}

    def test_machines_and_their_runs_are_searched_by_hardware(
        self, api_client: TestClient, dataset: Dataset, submitted: list[Any]
    ) -> None:
        macs = ["macos-26.5-arm64-20260812", "macos-26.5-arm64-hardenedfast-20260821"]

        machines = body_of(
            api_client.get(dataset.url(MACHINES_PATH), params={"search": "apple m4"})
        )
        assert [machine["name"] for machine in machines["items"]] == macs

        runs = walk_pages(api_client, dataset.url(RUNS_PATH), urlencode({"search": "APPLE M4"}))
        assert sorted(run["uuid"] for run in runs) == sorted(
            run["uuid"] for run in dataset.submissions if run["machine"]["name"] in macs
        )

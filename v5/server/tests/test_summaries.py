"""D15's run summaries: the two-stage geomean, and what a submission stores."""

from __future__ import annotations

import math
from collections.abc import Callable
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import Engine, select

from conftest import run_payload
from lnt_v5.routes.runs import RUNS_PATH
from lnt_v5.routes.suites import SUITES_PATH
from lnt_v5.suites.aggregation import SampleAggregation, geomean
from lnt_v5.suites.schema import Metric
from lnt_v5.suites.submission import SubmittedTest
from lnt_v5.suites.summaries import summarize
from lnt_v5.suites.tables import SuiteTables

TIME = Metric.model_validate({"name": "time", "type": "real"})
COUNT = Metric.model_validate({"name": "count", "type": "integer"})
LABEL = Metric.model_validate({"name": "label", "type": "text"})


def entry(name: str, *samples: dict[str, Any]) -> SubmittedTest:
    """A test entry as validation produces it: every sample carries every metric (see D6)."""
    every = {"time": None, "count": None, "label": None}
    return SubmittedTest(name=name, samples=[every | sample for sample in samples], profile=None)


def summarized(*tests: SubmittedTest, metrics: list[Metric] | None = None) -> dict[Any, float]:
    return {
        (name, aggregation): value
        for name, aggregation, value in summarize(metrics or [TIME, COUNT, LABEL], tests)
    }


class TestAggregation:
    @pytest.mark.parametrize(
        ("aggregation", "values", "expected"),
        [
            ("median", [6.0, 1.0, 2.0], 2.0),
            # The mean of the middle two, for an even number of values.
            ("median", [1.0, 2.0, 4.0, 10.0], 3.0),
            ("mean", [6.0, 1.0, 2.0], 3.0),
            ("min", [6.0, 1.0, 2.0], 1.0),
            ("max", [6.0, 1.0, 2.0], 6.0),
        ],
    )
    def test_each_aggregation(self, aggregation: str, values: list[float], expected: float) -> None:
        assert SampleAggregation(aggregation)(values) == expected

    def test_the_geomean_skips_zero_and_negative_values(self) -> None:
        assert geomean([2.0, 8.0, 0.0, -4.0]) == pytest.approx(4.0)

    def test_there_is_no_geomean_of_nothing_positive(self) -> None:
        assert geomean([0.0, -1.0]) is None
        assert geomean([]) is None


class TestSummarize:
    def test_aggregates_each_test_before_taking_the_geomean_across_tests(self) -> None:
        # One test measured three times and one measured once count equally: the geomean of the two
        # medians (2 and 8), not of the four samples.
        summaries = summarized(
            entry("a", {"time": 1.0}, {"time": 2.0}, {"time": 3.0}), entry("b", {"time": 8.0})
        )

        assert summaries["time", SampleAggregation.MEDIAN] == pytest.approx(4.0)
        assert summaries["time", SampleAggregation.MAX] == pytest.approx(math.sqrt(3.0 * 8.0))

    def test_a_test_with_no_value_for_the_metric_takes_no_part(self) -> None:
        summaries = summarized(entry("a", {"time": 4.0}), entry("b", {"count": 7}))

        assert summaries["time", SampleAggregation.MEAN] == pytest.approx(4.0)
        assert summaries["count", SampleAggregation.MEAN] == pytest.approx(7.0)

    def test_skips_the_tests_whose_aggregate_is_not_positive(self) -> None:
        # The median of [-1, 3] is 1 and its min is -1, so only the min skips the test.
        summaries = summarized(entry("a", {"time": -1.0}, {"time": 3.0}), entry("b", {"time": 4.0}))

        assert summaries["time", SampleAggregation.MEDIAN] == pytest.approx(2.0)
        assert summaries["time", SampleAggregation.MIN] == pytest.approx(4.0)

    def test_nothing_positive_has_no_geomean(self) -> None:
        summaries = summarized(entry("a", {"time": -1.0}, {"time": 3.0}))

        assert ("time", SampleAggregation.MIN) not in summaries
        assert ("time", SampleAggregation.MAX) in summaries

    def test_an_integer_metric_is_averaged_in_floating_point(self) -> None:
        summaries = summarized(entry("a", {"count": 1}, {"count": 2}), entry("b", {"count": 6}))

        assert summaries["count", SampleAggregation.MEAN] == pytest.approx(3.0)

    def test_only_numeric_metrics_have_one(self) -> None:
        summaries = summarized(entry("a", {"label": "x", "time": 1.0}))

        assert {name for name, _ in summaries} == {"time"}

    def test_a_run_with_no_tests_has_none(self) -> None:
        assert summarized() == {}


class TestSubmission:
    @pytest.fixture
    def suite(self, make_api_suite: Callable[[dict[str, Any]], SuiteTables]) -> SuiteTables:
        return make_api_suite(
            {
                "name": "nts",
                "metrics": [
                    {"name": "time", "type": "real"},
                    {"name": "size", "type": "integer"},
                ],
            }
        )

    def stored(self, db_engine: Engine, suite: SuiteTables) -> dict[Any, float]:
        summaries, metric = suite.run_summary, suite.metric
        with db_engine.connect() as connection:
            rows = connection.execute(
                select(metric.c.name, summaries.c.sample_agg, summaries.c.geomean).join(
                    metric, metric.c.id == summaries.c.metric_id
                )
            ).all()
        return {(name, aggregation): value for name, aggregation, value in rows}

    def submit(
        self, api_client: TestClient, submitter: dict[str, str], *tests: dict[str, Any]
    ) -> dict[str, Any]:
        response = api_client.post(
            RUNS_PATH.format(testsuite="nts"),
            json=run_payload(tests=list(tests)),
            headers=submitter,
        )
        assert response.status_code == 201, response.text
        return dict(response.json())

    def test_stores_every_metric_and_aggregation_the_run_has_a_geomean_for(
        self,
        api_client: TestClient,
        submitter: dict[str, str],
        db_engine: Engine,
        suite: SuiteTables,
    ) -> None:
        self.submit(
            api_client,
            submitter,
            {"name": "a", "time": [1.0, 2.0, 3.0]},
            {"name": "b", "time": 8.0, "size": 5},
        )

        stored = self.stored(db_engine, suite)

        assert set(stored) == {
            (name, aggregation) for name in ("time", "size") for aggregation in SampleAggregation
        }
        assert stored["time", SampleAggregation.MEDIAN] == pytest.approx(4.0)
        assert stored["size", SampleAggregation.MAX] == pytest.approx(5.0)

    def test_deleting_the_run_deletes_them(
        self,
        api_client: TestClient,
        submitter: dict[str, str],
        manage: dict[str, str],
        db_engine: Engine,
        suite: SuiteTables,
    ) -> None:
        run = self.submit(api_client, submitter, {"name": "a", "time": 1.0})

        response = api_client.delete(
            f"{RUNS_PATH.format(testsuite='nts')}/{run['uuid']}", headers=manage
        )

        assert response.status_code == 204
        assert self.stored(db_engine, suite) == {}

    def test_removing_the_metric_deletes_its_summaries(
        self,
        api_client: TestClient,
        submitter: dict[str, str],
        manage: dict[str, str],
        db_engine: Engine,
        suite: SuiteTables,
    ) -> None:
        self.submit(api_client, submitter, {"name": "a", "time": 1.0, "size": 2})

        response = api_client.patch(
            f"{SUITES_PATH}/nts/schema?confirm=true",
            json={"metrics": {"remove": ["size"]}},
            headers=manage,
        )

        assert response.status_code == 200, response.text
        assert {name for name, _ in self.stored(db_engine, suite)} == {"time"}

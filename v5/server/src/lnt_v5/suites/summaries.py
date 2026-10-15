"""O9's `{suite}.run_summary`: statistics of each run per numeric metric and sample aggregation.

`GET /trends` plots a geomean per machine and commit, and computing it from `{suite}.sample` would
read every sample of every run in the window -- millions of rows for one Dashboard card. A run's
samples never change after submission, so its summaries are computed once, here, and trends combines
a handful of them per commit instead. The geomean is the only statistic a summary holds so far.

Computed from the validated submission, before the write transaction opens, and only inserted
inside it.
"""

from __future__ import annotations

from collections.abc import Sequence

from sqlalchemy import Connection, Insert

from lnt_v5.suites.aggregation import SampleAggregation, geomean
from lnt_v5.suites.bulk import unnest_insert
from lnt_v5.suites.entities import identifiers
from lnt_v5.suites.registry import Suite
from lnt_v5.suites.schema import NUMERIC_TYPES, Metric
from lnt_v5.suites.scope import schema_changed
from lnt_v5.suites.submission import SubmittedTest

# A run's summary of one metric under one aggregation: `(metric, aggregation, geomean)`.
Summary = tuple[str, SampleAggregation, float]


def summarize(metrics: Sequence[Metric], tests: Sequence[SubmittedTest]) -> list[Summary]:
    """The run's summary of every numeric metric under every aggregation it has a geomean for (O9).
    A metric with no positive aggregate under some aggregation has none."""
    summaries: list[Summary] = []
    for metric in metrics:
        if metric.type not in NUMERIC_TYPES:
            continue
        measured = [
            values
            for test in tests
            if (values := [s[metric.name] for s in test.samples if s[metric.name] is not None])
        ]
        for aggregation in SampleAggregation:
            value = geomean(aggregation(values) for values in measured)
            if value is not None:
                summaries.append((metric.name, aggregation, value))
    return summaries


def add(connection: Connection, suite: Suite, run_id: int, summaries: Sequence[Summary]) -> None:
    """Store a newly submitted run's summaries, as `summarize` computed them, in one statement.

    A metric removed since the payload was validated is D2's retryable 409, which the sample
    insert before this already reports.
    """
    if not summaries:
        return
    ids = identifiers(
        connection,
        suite.tables.metric.c.name,
        sorted({name for name, _, _ in summaries}),
        lambda _: schema_changed(suite.schema.name),
    )
    connection.execute(
        suite.derived(_insert),
        {
            "run_id": run_id,
            "metric_id": [ids[name] for name, _, _ in summaries],
            "sample_agg": [aggregation for _, aggregation, _ in summaries],
            "geomean": [value for _, _, value in summaries],
        },
    )


def _insert(suite: Suite) -> Insert:
    return unnest_insert(
        suite.tables.run_summary, ["metric_id", "sample_agg", "geomean"], constants=["run_id"]
    )

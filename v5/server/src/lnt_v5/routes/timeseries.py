"""Time series (E9).

`GET /trends` combines the runs' geomeans (O9) into one per (machine, commit). `GET /series` lives
in `series.py`, and takes from here the point it streams (`DataPoint`) and the filters it selects
runs with (`run_conditions`).
"""

from __future__ import annotations

from collections.abc import Collection
from datetime import datetime
from typing import Annotated, Any

from fastapi import APIRouter, Query
from pydantic import BaseModel, Field
from sqlalchemy import (
    Column,
    ColumnElement,
    Connection,
    Row,
    Select,
    Table,
    func,
    select,
)

from lnt_v5 import examples
from lnt_v5.auth import require_scope
from lnt_v5.db import EngineDep
from lnt_v5.errors import ApiError, ErrorCode
from lnt_v5.querying import MAX_LIMIT, exclusive_range
from lnt_v5.responses import Items
from lnt_v5.routes.commits import commit_ordinal
from lnt_v5.routes.machines import machine_ids
from lnt_v5.routes.suites import SUITES_PATH
from lnt_v5.scopes import Scope
from lnt_v5.suites.aggregation import SampleAggregation
from lnt_v5.suites.entities import DeclaredValue, declared_entry
from lnt_v5.suites.registry import RegistryDep, Suite
from lnt_v5.suites.schema import NUMERIC_TYPES, Metric
from lnt_v5.suites.scope import ProjectName, SuiteName, suite_responses, suite_scope
from lnt_v5.suites.tables import geomean_column

TRENDS_PATH = f"{SUITES_PATH}/{{suite}}/trends"

router = APIRouter(prefix=f"{SUITES_PATH}/{{suite}}", tags=["Time Series"])

# `GET /trends` is unpaginated, so an omitted window must still be bounded. 500 is the Dashboard's
# default range.
DEFAULT_LAST_N = 500

_NO_TREND_ENTITY = "The test suite, or one of the machines, doesn't exist."

# endpoints.md: `commit` names a point and the bounds name a range, so a request takes one or the
# other.
ONE_KIND_OF_COMMIT_FILTER = (
    "'commit' selects one commit and 'after_commit'/'before_commit' select a range of them, so a "
    "request may use one or the other but not both"
)

# The docstrings of the models and endpoints below, and the field descriptions, are published, as
# the descriptions I8's document gives them, so they are written for API users.

_TAG = "The commit's tag. Null if it has none."


# A line of `GET /series`. Carries the commit's `ordinal` and `tag`, the denormalization I4 grants
# time-series points, and echoes `metric` so that each line is self-descriptive.
class DataPoint(BaseModel):
    """One measured value, with the test, machine, commit and run it comes from."""

    test: str = Field(description="The name of the test.", examples=[examples.TEST])
    machine: str = Field(description="The name of the machine.", examples=[examples.MACHINE])
    metric: str = Field(
        description="The name of the metric (the one in the request).",
        examples=[examples.METRIC],
    )
    value: DeclaredValue = Field(
        description="The measured value. Never null.",
        examples=[examples.SAMPLE_METRICS["execution_time"]],
    )
    commit: str = Field(
        description="The value of the commit the run measured.",
        examples=[examples.COMMIT],
    )
    ordinal: int | None = Field(
        description=(
            "The commit's ordinal. Null if it has none, which can't happen when filtering on a "
            "range of commits, or with `has_ordinal=true`."
        ),
        examples=[examples.ORDINAL],
    )
    run_uuid: str = Field(description="The UUID of the run.", examples=[examples.RUN_UUID])
    submitted_at: datetime = Field(description="When the run was submitted.")
    measured_at: datetime = Field(
        description="When the run was measured.", examples=[examples.MEASURED_AT]
    )
    tag: str | None = Field(description=_TAG, examples=[examples.TAG])


class TrendPoint(BaseModel):
    """One machine's trend value at one commit."""

    machine: str = Field(description="The name of the machine.", examples=[examples.MACHINE])
    commit: str = Field(
        description="The value of the commit.",
        examples=[examples.COMMIT],
    )
    ordinal: int = Field(
        description="The commit's ordinal. Never null: trends only include commits that have one.",
        examples=[examples.ORDINAL],
    )
    measured_at: datetime = Field(
        description="When the most recently measured of the runs behind this value was measured.",
        examples=[examples.MEASURED_AT],
    )
    tag: str | None = Field(description=_TAG, examples=[examples.TAG])
    value: float = Field(
        description=(
            "The trend value: the geometric mean of the machine's runs at this commit (see the "
            "operation's description). Always a floating-point number, even for an `integer` "
            "metric."
        )
    )


class Trends:
    """One metric's run geomeans under one sample aggregation (O9), combined per (machine, commit)
    by a second geomean."""

    def __init__(self, suite: Suite, metric: Metric, aggregation: SampleAggregation) -> None:
        summaries = suite.tables.run_summary
        metrics = suite.tables.metric
        self._run: Table = suite.tables.run
        self._commit: Table = suite.tables.commit
        self._machine: Table = suite.tables.machine
        self.ordinal: Column[Any] = self._commit.c.ordinal
        run_geomean = summaries.c[geomean_column(aggregation)]
        self._source = summaries.join(metrics, metrics.c.id == summaries.c.metric_id).join(
            self._run, self._run.c.id == summaries.c.run_id
        )
        # A run may have a summary of the metric but no geomean under this aggregation. Those runs
        # are left out of the window, and of each group too: the geomean would skip their nulls by
        # itself, but `latest` would not, and a group of nothing but nulls would be a null value.
        self._measured = [metrics.c.name == metric.name, run_geomean.is_not(None)]
        # Every run geomean is positive, so `ln` is always defined.
        self.geomean = func.exp(func.avg(func.ln(run_geomean)))
        self.latest = func.max(self._run.c.measured_at)

    def window(self, machines: Collection[int], last_n: int) -> Select[Any]:
        """The ids of the `last_n` most recent commits, by ordinal, at which any of `machines` has a
        run geomean for the metric under the aggregation. Counted over the machines together, so
        that their trendlines share one window."""
        has_value = (
            select(self._run.c.id)
            .select_from(self._source)
            .where(
                self._run.c.commit_id == self._commit.c.id,
                self._run.c.machine_id.in_(machines),
                *self._measured,
            )
            .exists()
        )
        # Not correlated with the commit of the statement it filters.
        return (
            select(self._commit.c.id)
            .where(self.ordinal.is_not(None), has_value)
            .order_by(self.ordinal.desc())
            .limit(last_n)
            .correlate(None)
        )

    def select(self, machines: Collection[int], last_n: int) -> Select[Any]:
        """One row per (machine, commit) with a value, ordered by machine then ordinal.

        Grouping by the primary keys alone is enough: PostgreSQL treats the other selected columns
        as functionally dependent on them.
        """
        return (
            select(
                self._machine.c.name,
                self._commit.c.commit,
                self.ordinal,
                self._commit.c.tag,
                self.latest,
                self.geomean,
            )
            .select_from(
                self._source.join(self._commit, self._commit.c.id == self._run.c.commit_id).join(
                    self._machine, self._machine.c.id == self._run.c.machine_id
                )
            )
            .where(
                *self._measured,
                self._run.c.machine_id.in_(machines),
                self._commit.c.id.in_(self.window(machines, last_n)),
            )
            .group_by(self._machine.c.id, self._commit.c.id)
            .order_by(self._machine.c.name, self.ordinal)
        )

    def read(self, row: Row[Any]) -> TrendPoint:
        values = row._mapping
        return TrendPoint.model_construct(
            machine=values[self._machine.c.name],
            commit=values[self._commit.c.commit],
            ordinal=values[self.ordinal],
            measured_at=values[self.latest],
            tag=values[self._commit.c.tag],
            value=values[self.geomean],
        )


def run_conditions(
    connection: Connection,
    suite: Suite,
    *,
    commit: str | None,
    after_commit: str | None,
    before_commit: str | None,
    submitted_after: datetime | None,
    submitted_before: datetime | None,
    measured_after: datetime | None,
    measured_before: datetime | None,
) -> list[ColumnElement[bool]]:
    """The filters of `GET /series` that select runs, as conditions on `run` and its commit.

    `commit=` matches by value, so that an unknown commit is an empty result rather than 404 (I3).
    The commit bounds are by ordinal, and resolving one is what answers I3's 404 or 400.
    """
    run, commits = suite.tables.run, suite.tables.commit
    conditions: list[ColumnElement[bool]] = []
    if commit is not None:
        conditions.append(commits.c.commit == commit)
    conditions += exclusive_range(
        commits.c.ordinal,
        None if after_commit is None else commit_ordinal(connection, suite, after_commit),
        None if before_commit is None else commit_ordinal(connection, suite, before_commit),
    )
    conditions += exclusive_range(run.c.submitted_at, submitted_after, submitted_before)
    conditions += exclusive_range(run.c.measured_at, measured_after, measured_before)
    return conditions


def _numeric(suite: Suite, name: str) -> Metric:
    """The metric a trend is taken of, which must be declared and numeric (D3); 400 otherwise."""
    metric = declared_entry(suite.schema, Metric, name)
    if metric.type not in NUMERIC_TYPES:
        raise ApiError(
            ErrorCode.INVALID_REQUEST,
            f"Metric '{name}' is declared '{metric.type.value}' in test suite "
            f"'{suite.full_name}', and a geomean is defined only over the numeric types: "
            f"{', '.join(sorted(NUMERIC_TYPES))}",
        )
    return metric


# No `tracked` filter: that flag governs automatic machine selection (D5), which the Dashboard
# applies when it picks the machines it names here.
@router.get(
    "/trends",
    dependencies=[require_scope(Scope.READ)],
    summary="Get a metric's trend across machines",
    responses=suite_responses(not_found=_NO_TREND_ENTITY),
)
def query_trends(
    project: ProjectName,
    testsuite: SuiteName,
    engine: EngineDep,
    registry: RegistryDep,
    metric: Annotated[
        str,
        Query(
            description=(
                "A `real` or `integer` metric. Returns 400 if the suite's schema doesn't define "
                "it, or defines it with another type."
            )
        ),
    ],
    machine: Annotated[
        list[str],
        Query(
            description=(
                "The machines to return trends for. Repeat the parameter for several machines. "
                "Returns 404 if any of them doesn't exist. Untracked machines can be used too."
            ),
        ),
    ],
    sample_agg: Annotated[
        SampleAggregation,
        Query(description="How to combine a test's samples in a run into a single value."),
    ] = SampleAggregation.MEDIAN,
    last_n: Annotated[
        int,
        Query(
            ge=1,
            le=MAX_LIMIT,
            description=(
                "Only include the N most recent commits (by ordinal) that have data on any of the "
                "machines. All machines share this window, so a machine that stopped reporting "
                "has no values for the latest commits."
            ),
        ),
    ] = DEFAULT_LAST_N,
) -> Items[TrendPoint]:
    """A summary of one metric over time, for a few machines: one value per machine and commit,
    sorted by machine name and then by ordinal. Only commits with an ordinal are included.

    Each value is computed in three steps:

    1. For each test in a run, the samples are combined into one value with `sample_agg`.
    2. The run's value is the geometric mean of those per-test values, ignoring values that are
       zero or negative.
    3. The trend value is the geometric mean of the run values of the machine's runs at that
       commit.

    Machines and commits without any positive value are left out.
    """
    with (
        engine.connect() as connection,
        suite_scope(registry, connection, project, testsuite) as suite,
    ):
        trends = Trends(suite, _numeric(suite, metric), sample_agg)
        machines = machine_ids(connection, suite, machine).values()
        rows = connection.execute(trends.select(machines, last_n)).all()
        return Items(items=[trends.read(row) for row in rows])

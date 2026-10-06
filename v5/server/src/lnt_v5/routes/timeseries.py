"""Time series (E9).

`POST /query` pages through O5's `Sample JOIN Run JOIN Commit`. It is a `read`-scoped POST because
its test list does not fit a query string, so its cursor and page size travel in the body (I2).
`GET /trends` combines the runs' geomeans (O9) into one per (machine, commit).
"""

from __future__ import annotations

from collections.abc import Collection
from datetime import datetime
from typing import Annotated, Any, Literal, Self

from fastapi import APIRouter, Body, Query
from pydantic import BaseModel, ConfigDict, Field, model_validator
from sqlalchemy import (
    Column,
    ColumnElement,
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
from lnt_v5.querying import (
    DEFAULT_LIMIT,
    MAX_LIMIT,
    BodyCursor,
    BodyLimit,
    Keyset,
    SortKey,
    cursor_page,
    exclusive_range,
    sort_order,
)
from lnt_v5.responses import CursorPage, Items
from lnt_v5.routes.commits import commit_ordinal
from lnt_v5.routes.machines import machine_id, machine_ids
from lnt_v5.routes.suites import SUITES_PATH
from lnt_v5.routes.tests import test_ids
from lnt_v5.scopes import Scope
from lnt_v5.suites.aggregation import SampleAggregation
from lnt_v5.suites.entities import DatetimeValue, DeclaredValue, Named, declared_entry
from lnt_v5.suites.registry import RegistryDep, Suite
from lnt_v5.suites.schema import NUMERIC_TYPES, Metric
from lnt_v5.suites.scope import SuiteName, suite_responses, suite_scope

QUERY_PATH = f"{SUITES_PATH}/{{testsuite}}/query"
TRENDS_PATH = f"{SUITES_PATH}/{{testsuite}}/trends"

router = APIRouter(prefix=f"{SUITES_PATH}/{{testsuite}}", tags=["Time Series"])

# endpoints.md names these three fields and no others, and I3's `-` prefix spells each of them
# backwards. A literal rather than a free string, so I8's document enumerates them and an unknown
# one is a 400 before the endpoint runs -- the same treatment the run and commit lists get.
QuerySort = Literal["test", "-test", "commit", "-commit", "submitted_at", "-submitted_at"]

# `GET /trends` is unpaginated, so an omitted window must still be bounded. 500 is the Dashboard's
# default range.
DEFAULT_LAST_N = 500

_NO_QUERY_ENTITY = (
    "The test suite doesn't exist, or the body names a machine, a test, or an `after_commit` or "
    "`before_commit` that doesn't exist."
)
_NO_TREND_ENTITY = "The test suite, or one of the machines, doesn't exist."

# Built from `examples.py`, like every example in I8's document.
_QUERY_EXAMPLES = {
    "series": {
        "summary": "One test's execution time on one machine, in commit order",
        "value": {
            "metric": examples.METRIC,
            "machine": examples.MACHINE,
            "test": [examples.TEST],
            "sort": "commit",
        },
    },
    "range": {
        "summary": "Every test's instruction count after a given commit",
        "value": {
            "metric": examples.OTHER_METRIC,
            "after_commit": examples.COMMIT,
            "sort": "commit",
            "limit": 1000,
        },
    },
}

# The docstrings of the models and endpoints below, and the field descriptions, are published, as
# the descriptions I8's document gives them, so they are written for API users.

_TAG = "The commit's tag. Null if it has none."


# Carries the commit's `ordinal` and `tag`, the denormalization I4 grants this endpoint, and echoes
# `metric` so that each point is self-descriptive.
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
            "The commit's ordinal. Null if it has none, which can't happen when sorting by commit "
            "or filtering on a range of commits."
        ),
        examples=[examples.ORDINAL],
    )
    run_uuid: str = Field(description="The UUID of the run.", examples=[examples.RUN_UUID])
    submitted_at: datetime = Field(description="When the run was submitted.")
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
    submitted_at: datetime = Field(
        description="When the most recent of the runs behind this value was submitted."
    )
    tag: str | None = Field(description=_TAG, examples=[examples.TAG])
    value: float = Field(
        description=(
            "The trend value: the geometric mean of the machine's runs at this commit (see the "
            "operation's description). Always a floating-point number, even for an `integer` "
            "metric."
        )
    )


class QueryRequest(BaseModel):
    """Which data points to return. Only `metric` is required; the other keys narrow down the
    results."""

    model_config = ConfigDict(extra="forbid")

    metric: Named = Field(
        description=(
            "The metric to return values for. Returns 400 if the suite's schema doesn't define it."
        )
    )
    machine: Named | None = Field(
        default=None,
        description=(
            "Only return values from this machine. Returns 404 if the machine doesn't exist."
        ),
    )
    # Bounded at I2's page ceiling, for the same reason `POST /commits/resolve` is: the list
    # expands into one statement, and an unbounded one would expand into a statement with more
    # bind parameters than the protocol carries.
    test: list[Named] | None = Field(
        default=None,
        max_length=MAX_LIMIT,
        description=(
            f"Only return values for these tests (at most {MAX_LIMIT}). Returns 404 if any of them "
            "doesn't exist. An empty list returns nothing; leave the key out to include all tests."
        ),
    )
    commit: Named | None = Field(
        default=None,
        description=(
            "Only return values from runs of this commit. If the commit doesn't exist, the result "
            "is empty. Can't be combined with `after_commit` or `before_commit`."
        ),
    )
    after_commit: Named | None = Field(
        default=None,
        description=(
            "Only return values from commits after this one (exclusive), by ordinal. Commits "
            "without an ordinal are left out. Returns 404 if the commit doesn't exist, and 400 if "
            "it has no ordinal."
        ),
    )
    before_commit: Named | None = Field(
        default=None,
        description=(
            "Only return values from commits before this one (exclusive), by ordinal. Commits "
            "without an ordinal are left out. Returns 404 if the commit doesn't exist, and 400 if "
            "it has no ordinal."
        ),
    )
    after_time: DatetimeValue | None = Field(
        default=None,
        description="Only return values from runs submitted after this time (exclusive).",
    )
    before_time: DatetimeValue | None = Field(
        default=None,
        description="Only return values from runs submitted before this time (exclusive).",
    )
    sort: QuerySort | None = Field(
        default=None,
        description=(
            "Sort by test name, by commit (that is, by ordinal) or by submission time. Sorting by "
            "commit leaves out commits without an ordinal. Without it, the order is unspecified "
            "but stable, which is the fastest way to page through all values."
        ),
    )
    limit: BodyLimit = DEFAULT_LIMIT
    cursor: BodyCursor = None

    @model_validator(mode="after")
    def _one_kind_of_commit_filter(self) -> Self:
        """endpoints.md: `commit` names a point and the bounds name a range, so never both."""
        if self.commit is not None and (
            self.after_commit is not None or self.before_commit is not None
        ):
            raise ValueError(
                "'commit' selects one commit and 'after_commit'/'before_commit' select a range of "
                "them, so a request may use one or the other but not both"
            )
        return self


class Points:
    """O5's join as rows: one data point per sample that has a value for the metric."""

    def __init__(self, suite: Suite, metric: Metric) -> None:
        self.table: Table = suite.tables.sample
        self._run: Table = suite.tables.run
        self._commit: Table = suite.tables.commit
        self._machine: Table = suite.tables.machine
        self._test: Table = suite.tables.test
        self.metric = metric.name
        self.value: Column[Any] = self.table.c[metric.name]
        # The two columns the range filters bound.
        self.ordinal: Column[Any] = self._commit.c.ordinal
        self.submitted_at: Column[Any] = self._run.c.submitted_at
        # Sorting by `commit` means by ordinal: only a commit's position is an order (D1).
        self._sortable: dict[str, Column[Any]] = {
            "test": self._test.c.name,
            "commit": self.ordinal,
            "submitted_at": self.submitted_at,
        }

    def select(self) -> Select[Any]:
        """Every column a point is rendered from, plus the sample id the cursor orders by. A sample
        with no value for the metric is not a point."""
        return (
            select(
                self.table.c.id,
                self._test.c.name,
                self._machine.c.name,
                self.value,
                self._commit.c.commit,
                self.ordinal,
                self._commit.c.tag,
                self._run.c.uuid,
                self.submitted_at,
            )
            .select_from(
                self.table.join(self._run, self._run.c.id == self.table.c.run_id)
                .join(self._commit, self._commit.c.id == self._run.c.commit_id)
                .join(self._machine, self._machine.c.id == self._run.c.machine_id)
                .join(self._test, self._test.c.id == self.table.c.test_id)
            )
            .where(self.value.is_not(None))
        )

    def keyset(self, sort: QuerySort | None) -> Keyset:
        """O5's ordering: the caller's sort, then the sample's id as the unique tiebreaker.

        `Keyset.defined` drops the rows whose sort key is null, which is what excludes unordered
        commits under `sort=commit` (O5). The sort key and the tiebreaker live on different tables,
        so the cursor comparison is not a pure index condition; PostgreSQL still drives the join
        from the sort column's index and finishes with an incremental sort, so a page stops early.
        """
        if sort is None:
            return Keyset(tiebreaker=self.table.c.id)
        field, descending = sort_order(sort)
        return Keyset(SortKey(self._sortable[field], descending), tiebreaker=self.table.c.id)

    def measured_on(self, machine: int) -> ColumnElement[bool]:
        """I3's `machine=`, by id so that it uses D5's `(machine_id, submitted_at)` index."""
        return self._run.c.machine_id == machine

    def measured_for(self, tests: Collection[int]) -> ColumnElement[bool]:
        """endpoints.md's `test` list: a disjunction, landing on D5's `(test_id, run_id)` index.

        Sorted because the ids are bound in the order given, and that order is part of the cursor's
        scope (`cursor_page`). The ids come from a lookup with no ORDER BY, whose row order follows
        the plan PostgreSQL picks, so an identical request could otherwise have its cursor refused.
        """
        return self.table.c.test_id.in_(sorted(tests))

    def at_commit(self, value: str) -> ColumnElement[bool]:
        """I3's `commit=`, by value so that an unknown commit is an empty page rather than 404."""
        return self._commit.c.commit == value

    def read(self, row: Row[Any]) -> DataPoint:
        # By column object rather than by name: several joined tables have a `name`, and a metric
        # may be called `commit` or `tag`. `_mapping` builds a view per access, so bind it once.
        # Not validated, like every other stored row the API reads back.
        values = row._mapping
        return DataPoint.model_construct(
            test=values[self._test.c.name],
            machine=values[self._machine.c.name],
            metric=self.metric,
            value=values[self.value],
            commit=values[self._commit.c.commit],
            ordinal=values[self.ordinal],
            run_uuid=values[self._run.c.uuid],
            submitted_at=values[self.submitted_at],
            tag=values[self._commit.c.tag],
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
        self._source = summaries.join(metrics, metrics.c.id == summaries.c.metric_id).join(
            self._run, self._run.c.id == summaries.c.run_id
        )
        self._measured = [metrics.c.name == metric.name, summaries.c.sample_agg == aggregation]
        # Every run geomean is positive, so `ln` is always defined.
        self.geomean = func.exp(func.avg(func.ln(summaries.c.geomean)))
        self.latest = func.max(self._run.c.submitted_at)

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
            submitted_at=values[self.latest],
            tag=values[self._commit.c.tag],
            value=values[self.geomean],
        )


def _numeric(suite: Suite, name: str) -> Metric:
    """The metric a trend is taken of, which must be declared and numeric (D3); 400 otherwise."""
    metric = declared_entry(suite.schema, Metric, name)
    if metric.type not in NUMERIC_TYPES:
        raise ApiError(
            ErrorCode.INVALID_REQUEST,
            f"Metric '{name}' is declared '{metric.type.value}' in test suite "
            f"'{suite.schema.name}', and a geomean is defined only over the numeric types: "
            f"{', '.join(sorted(NUMERIC_TYPES))}",
        )
    return metric


# The metric is resolved first, so an undeclared one is a 400 even if the body also names an absent
# machine or test. The spec leaves that order open.
@router.post(
    "/query",
    dependencies=[require_scope(Scope.READ)],
    summary="Get a metric's values over time",
    responses=suite_responses(not_found=_NO_QUERY_ENTITY),
)
def query_points(
    testsuite: SuiteName,
    body: Annotated[QueryRequest, Body(openapi_examples=_QUERY_EXAMPLES)],
    engine: EngineDep,
    registry: RegistryDep,
) -> CursorPage[DataPoint]:
    """The values of one metric, one page at a time, with the test, machine, commit and run of
    each. Use this to chart a metric over time.

    This is a POST only because the list of tests can be too long for a URL; it doesn't change
    anything. `limit` and `cursor` go in the body too.
    """
    with engine.connect() as connection, suite_scope(registry, connection, testsuite) as suite:
        points = Points(suite, declared_entry(suite.schema, Metric, body.metric))
        conditions: list[ColumnElement[bool]] = []
        if body.machine is not None:
            conditions.append(points.measured_on(machine_id(connection, suite, body.machine)))
        if body.test is not None:
            conditions.append(points.measured_for(test_ids(connection, suite, body.test).values()))
        if body.commit is not None:
            conditions.append(points.at_commit(body.commit))
        after, before = body.after_commit, body.before_commit
        conditions += exclusive_range(
            points.ordinal,
            None if after is None else commit_ordinal(connection, suite, after),
            None if before is None else commit_ordinal(connection, suite, before),
        )
        conditions += exclusive_range(points.submitted_at, body.after_time, body.before_time)

        return cursor_page(
            connection,
            points.select().where(*conditions),
            points.keyset(body.sort),
            body.limit,
            body.cursor,
            points.read,
        )


# No `tracked` filter: that flag governs automatic machine selection (D5), which the Dashboard
# applies when it picks the machines it names here.
@router.get(
    "/trends",
    dependencies=[require_scope(Scope.READ)],
    summary="Get a metric's trend across machines",
    responses=suite_responses(not_found=_NO_TREND_ENTITY),
)
def query_trends(
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
    with engine.connect() as connection, suite_scope(registry, connection, testsuite) as suite:
        trends = Trends(suite, _numeric(suite, metric), sample_agg)
        machines = machine_ids(connection, suite, machine).values()
        rows = connection.execute(trends.select(machines, last_n)).all()
        return Items(items=[trends.read(row) for row in rows])

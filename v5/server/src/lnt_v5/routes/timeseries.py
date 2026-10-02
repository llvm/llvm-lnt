"""Time series (endpoints.md, Time Series).

`POST /query` pages through D10's `Sample JOIN Run JOIN Commit`. It is a `read`-scoped POST because
its test list does not fit a query string, so its cursor and page size travel in the body (R2).
`GET /trends` combines the runs' geomeans (D15) into one per (machine, commit).
"""

from __future__ import annotations

from collections.abc import Collection
from datetime import datetime
from typing import Annotated, Any, Literal, Self

from fastapi import APIRouter, Query
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
from lnt_v5.suites.scope import SUITE_NOT_FOUND, suite_responses, suite_scope

QUERY_PATH = f"{SUITES_PATH}/{{testsuite}}/query"
TRENDS_PATH = f"{SUITES_PATH}/{{testsuite}}/trends"

router = APIRouter(prefix=f"{SUITES_PATH}/{{testsuite}}", tags=["Time Series"])

# endpoints.md names these three fields and no others, and R3's `-` prefix spells each of them
# backwards. A literal rather than a free string, so R8's document enumerates them and an unknown
# one is a 400 before the endpoint runs -- the same treatment the run and commit lists get.
QuerySort = Literal["test", "-test", "commit", "-commit", "submitted_at", "-submitted_at"]

# `GET /trends` is unpaginated, so an omitted window must still be bounded. 500 is the Dashboard's
# default range.
DEFAULT_LAST_N = 500

_NO_QUERY_ENTITY = (
    f"{SUITE_NOT_FOUND} Or the machine, a test, or a range-bounding commit the body names is not "
    "in it."
)
_NO_TREND_ENTITY = f"{SUITE_NOT_FOUND} Or a machine the request names is not in it."


class DataPoint(BaseModel):
    """One measured value, placed in the time series.

    Carries the commit's `ordinal` and `tag`, the denormalization R4 grants this endpoint, and
    echoes `metric` so that each point is self-descriptive.
    """

    test: str = Field(description="The name of the test this value was measured for.")
    machine: str = Field(description="The name of the machine it was measured on.")
    metric: str = Field(description="The metric it measures -- the one the request asked for.")
    value: DeclaredValue = Field(
        description=(
            "The measured value, in the JSON representation of the metric's declared type (D3). "
            "Never null: a sample with no value for the metric is not a point in its series."
        )
    )
    commit: str = Field(description="The identity string of the commit the run belongs to.")
    ordinal: int | None = Field(
        description=(
            "That commit's position in the suite's order, or null if it has none. Never null when "
            "the request sorts by commit or bounds a commit range, which exclude the commits that "
            "have no ordinal."
        )
    )
    run_uuid: str = Field(description="The UUID of the run this value came from.")
    submitted_at: datetime = Field(description="When the server accepted that run.")
    tag: str | None = Field(
        description="That commit's human-readable label, or null if it has none."
    )


class TrendPoint(BaseModel):
    """One (machine, commit) group's geomean. Unlike a data point, it does not echo `metric`."""

    machine: str = Field(description="The name of the machine these values were measured on.")
    commit: str = Field(description="The identity string of the commit they were measured at.")
    ordinal: int = Field(
        description=(
            "That commit's position in the suite's order. Never null: this endpoint includes only "
            "commits that have one, since a trendline is drawn along that order."
        )
    )
    submitted_at: datetime = Field(
        description="When the server accepted the most recent of the runs behind this value."
    )
    tag: str | None = Field(
        description="That commit's human-readable label, or null if it has none."
    )
    value: float = Field(
        description=(
            "The geometric mean of the geomeans of the runs at this machine and commit, for the "
            "metric and sample aggregation the request names (D15). Always a real, even where the "
            "metric is declared 'integer' (D3)."
        )
    )


class QueryRequest(BaseModel):
    """The body of `POST /api/suites/{testsuite}/query`."""

    model_config = ConfigDict(extra="forbid")

    metric: Named = Field(
        description="A metric name this test suite's schema declares. 400 if it declares no such."
    )
    machine: Named | None = Field(
        default=None,
        description="Keep only values measured on this machine. 404 if there is no such machine.",
    )
    # Bounded at R2's page ceiling, for the same reason `POST /commits/resolve` is: the list
    # expands into one statement, and an unbounded one would expand into a statement with more
    # bind parameters than the protocol carries.
    test: list[Named] | None = Field(
        default=None,
        max_length=MAX_LIMIT,
        description=(
            f"Keep only values measured for one of these tests, at most {MAX_LIMIT} of them. 404 "
            "if any of them names no test. An empty list keeps nothing, which is not the same as "
            "omitting the key."
        ),
    )
    commit: Named | None = Field(
        default=None,
        description=(
            "Keep only values from runs on this exact commit. A value no commit has matches "
            "nothing, rather than being an error. Cannot be combined with the two bounds below."
        ),
    )
    after_commit: Named | None = Field(
        default=None,
        description=(
            "Keep only values from commits strictly after this one in ordinal order. 404 if there "
            "is no such commit, 400 if it has no ordinal to bound a range with."
        ),
    )
    before_commit: Named | None = Field(
        default=None, description="The same, strictly before this one in ordinal order."
    )
    after_time: DatetimeValue | None = Field(
        default=None,
        description="Keep only values from runs submitted strictly after this instant.",
    )
    before_time: DatetimeValue | None = Field(
        default=None, description="The same, strictly before this instant."
    )
    sort: QuerySort | None = Field(
        default=None,
        description=(
            "Order by test name, by commit (meaning by ordinal) or by submission time, ascending "
            "or descending. Sorting by commit excludes the commits that have no ordinal, since "
            "they have no place in that order. Omit for an arbitrary but stable order, which "
            "excludes nothing and is the cheapest way to walk the whole series."
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
    """D10's join as rows: one data point per sample that has a value for the metric."""

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
        """D10's ordering: the caller's sort, then the sample's id as the unique tiebreaker.

        `Keyset.defined` drops the rows whose sort key is null, which is what excludes unordered
        commits under `sort=commit` (D10). The sort key and the tiebreaker live on different tables,
        so the cursor comparison is not a pure index condition; PostgreSQL still drives the join
        from the sort column's index and finishes with an incremental sort, so a page stops early.
        """
        if sort is None:
            return Keyset(tiebreaker=self.table.c.id)
        field, descending = sort_order(sort)
        return Keyset(SortKey(self._sortable[field], descending), tiebreaker=self.table.c.id)

    def measured_on(self, machine: int) -> ColumnElement[bool]:
        """R3's `machine=`, by id so that it uses D5's `(machine_id, submitted_at)` index."""
        return self._run.c.machine_id == machine

    def measured_for(self, tests: Collection[int]) -> ColumnElement[bool]:
        """endpoints.md's `test` list: a disjunction, landing on D5's `(test_id, run_id)` index.

        Sorted because the ids are bound in the order given, and that order is part of the cursor's
        scope (`cursor_page`). The ids come from a lookup with no ORDER BY, whose row order follows
        the plan PostgreSQL picks, so an identical request could otherwise have its cursor refused.
        """
        return self.table.c.test_id.in_(sorted(tests))

    def at_commit(self, value: str) -> ColumnElement[bool]:
        """R3's `commit=`, by value so that an unknown commit is an empty page rather than 404."""
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
    """One metric's run geomeans under one sample aggregation (D15), combined per (machine, commit)
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


@router.post(
    "/query",
    dependencies=[require_scope(Scope.READ)],
    summary="Query time-series data points",
    responses=suite_responses(not_found=_NO_QUERY_ENTITY),
)
def query_points(
    testsuite: str,
    body: QueryRequest,
    engine: EngineDep,
    registry: RegistryDep,
) -> CursorPage[DataPoint]:
    """One metric's measured values, filtered, ordered and cursor-paginated (R2, R3, D10).

    The metric is resolved first, so an undeclared one is a 400 even if the body also names an
    absent machine or test. The spec leaves that order open.
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


@router.get(
    "/trends",
    dependencies=[require_scope(Scope.READ)],
    summary="Query geomean-aggregated trend data",
    responses=suite_responses(not_found=_NO_TREND_ENTITY),
)
def query_trends(
    testsuite: str,
    engine: EngineDep,
    registry: RegistryDep,
    metric: Annotated[
        str,
        Query(
            description=(
                "A numeric metric name this test suite's schema declares (D3). 400 if it declares "
                "no such metric, and 400 if the one it declares is 'text' or 'datetime'."
            )
        ),
    ],
    machine: Annotated[
        list[str],
        Query(
            description=(
                "A machine to return trends for. Repeat the parameter for several machines. 404 if "
                "any of them names no machine. Tracked or not, a machine named here is returned."
            ),
        ),
    ],
    sample_agg: Annotated[
        SampleAggregation,
        Query(description="How each test's samples within a run are reduced to one value (D15)."),
    ] = SampleAggregation.MEDIAN,
    last_n: Annotated[
        int,
        Query(
            ge=1,
            le=MAX_LIMIT,
            description=(
                "Keep only the N most recent commits, by ordinal, at which any of the named "
                "machines has a run geomean (D15) for the metric under the sample aggregation. "
                f"Defaults to {DEFAULT_LAST_N}, so that the response is always bounded."
            ),
        ),
    ] = DEFAULT_LAST_N,
) -> Items[TrendPoint]:
    """One geomean per machine and commit, for the Dashboard's sparklines (R2, R3, D15).

    No `tracked` filter: that flag governs automatic machine selection (D5), which the Dashboard
    applies when it picks the machines it names here.
    """
    with engine.connect() as connection, suite_scope(registry, connection, testsuite) as suite:
        trends = Trends(suite, _numeric(suite, metric), sample_agg)
        machines = machine_ids(connection, suite, machine).values()
        rows = connection.execute(trends.select(machines, last_n)).all()
        return Items(items=[trends.read(row) for row in rows])

"""Time series: the two reads that answer "how has this metric moved" (endpoints.md, Time Series).

D10 makes this the primary query pattern in the whole system, and the shape it gives it is one join:
`Sample JOIN Run JOIN Commit`, narrowed by machine and test, ordered by the commit's ordinal.
`POST /query` is that join served a page at a time; `POST /trends` is the same join collapsed to one
geomean per (machine, commit), for the Dashboard's sparklines. `_Series` below is where the join
itself lives, so that the two cannot drift apart on it.

Both are POSTs and both are `read`-scoped: R5 says the method implies nothing about the scope, and
names `POST /commits/resolve` as the same shape. The cursor and the page size therefore travel in
the body, which R2 covers -- the same opaque token under the same contract, carried by the only
thing this request has.
"""

from __future__ import annotations

from collections.abc import Collection
from datetime import datetime
from typing import Annotated, Any, Literal, Self

from fastapi import APIRouter
from pydantic import BaseModel, ConfigDict, Field, model_validator
from sqlalchemy import (
    Column,
    ColumnElement,
    Connection,
    Double,
    Join,
    Row,
    Select,
    Table,
    func,
    select,
)
from sqlalchemy import cast as sql_cast

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
    Timestamp,
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
from lnt_v5.suites.entities import DeclaredValue, Named, declared_entry
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

# What `POST /trends` bounds itself to when a request names no window of its own. This response is
# unpaginated and `read`-scoped, so an omitted `last_n` must not mean "aggregate the whole suite":
# with no machine filter either, that is every sample row in the instance in one JSON body. 500 is
# the Dashboard's own default range (client/dashboard.md), and it is the only number any client
# asks for by default, so it is the one an omitted window falls back to.
DEFAULT_LAST_N = 500

_NO_QUERY_ENTITY = (
    f"{SUITE_NOT_FOUND} Or the machine, a test, or a range-bounding commit the body names is not "
    "in it."
)
_NO_TREND_ENTITY = f"{SUITE_NOT_FOUND} Or a machine the body names is not in it."


class DataPoint(BaseModel):
    """One measured value, placed in the time series (endpoints.md, Time Series).

    R4's reference rule holds -- `test`, `machine` and `commit` are the other entity's identifier
    under a key named after it, and the run's UUID says so in its key -- with the denormalization
    R4 also grants this endpoint by name: `ordinal` and `tag` belong to the commit and ride along
    anyway, because a client cannot place a point on an axis without them.

    `metric` is echoed on every point even though the request names exactly one. That is
    deliberate too: a point is then self-descriptive, so a client merging the answers to several
    queries into one chart does not have to remember which request each point came from.
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
            "That commit's position in the suite's order, or null if it has none. Null only when "
            "the request did not sort by commit, which excludes the commits that have no ordinal."
        )
    )
    run_uuid: str = Field(description="The UUID of the run this value came from.")
    submitted_at: datetime = Field(description="When the server accepted that run.")
    tag: str | None = Field(description="That commit's editorial label, or null if it has none.")


class TrendPoint(BaseModel):
    """One (machine, commit) group's geomean (endpoints.md, Time Series).

    Unlike a data point, this carries no `metric`: an item is one point of one machine's trendline
    for the metric the request named, and there is no second metric in the response to tell it
    apart from.
    """

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
    tag: str | None = Field(description="That commit's editorial label, or null if it has none.")
    value: float = Field(
        description=(
            "The geometric mean of every positive value measured for this machine and commit. "
            "Always a real, even where the metric is declared 'integer' (D3)."
        )
    )


class QueryRequest(BaseModel):
    """The body of `POST /api/suites/{testsuite}/query`.

    `metric` is the only required key: everything else narrows a series that is otherwise the whole
    suite's. R3 explains why the two ranges are spelled out rather than taking the generic
    `after=`/`before=` -- this is the one endpoint that bounds a commit-ordinal range and a
    submission-time range at once, so one pair of names could not carry both.
    """

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
    after_time: Timestamp | None = Field(
        default=None,
        description="Keep only values from runs submitted strictly after this instant.",
    )
    before_time: Timestamp | None = Field(
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
        """endpoints.md: `commit` names a point and the bounds name a range, so never both.

        Rejected rather than resolved in some order, because the two readings of a request that
        sends both -- the commit, or the range -- are equally plausible and the caller meant one of
        them.
        """
        if self.commit is not None and (
            self.after_commit is not None or self.before_commit is not None
        ):
            raise ValueError(
                "'commit' selects one commit and 'after_commit'/'before_commit' select a range of "
                "them, so a request may use one or the other but not both"
            )
        return self


class TrendsRequest(BaseModel):
    """The body of `POST /api/suites/{testsuite}/trends`.

    `machine` is a list here, where `POST /query` takes one name: the Dashboard draws one trendline
    per machine on every card and asks for all of them in one call.

    This endpoint deliberately does not filter on `tracked`. That flag governs *automatic* machine
    selection (D5), and a machine named here was chosen deliberately -- the Dashboard applies
    `tracked` when it picks the names, through `GET /machines?tracked=true&sort=-last_run_at`, and
    what it then asks for is exactly what it picked.
    """

    model_config = ConfigDict(extra="forbid")

    metric: Named = Field(
        description=(
            "A numeric metric name this test suite's schema declares (D3). 400 if it declares no "
            "such metric, and 400 if the one it declares is 'text' or 'datetime': a geomean is "
            "arithmetic, and those are not numbers."
        )
    )
    machine: list[Named] | None = Field(
        default=None,
        max_length=MAX_LIMIT,
        description=(
            f"Keep only these machines' values, at most {MAX_LIMIT} of them. 404 if any of them "
            "names no machine. An empty list keeps nothing, which is not the same as omitting the "
            "key. Tracked or not, a machine named here is returned."
        ),
    )
    last_n: Annotated[int, Field(ge=1, le=MAX_LIMIT)] = Field(
        default=DEFAULT_LAST_N,
        description=(
            "Keep only the most recent N commits by ordinal, counted over the commits the suite "
            f"holds rather than over what the other filters leave. Defaults to {DEFAULT_LAST_N}, "
            "the Dashboard's own range, so that a request naming no window still gets a bounded "
            "response."
        ),
    )


class _Series:
    """The join D10 specifies, and the tables it spans (D10).

    One instance per request, built around the one metric the request names: `value` is that
    metric's column on `{suite}.sample`, which is not a column any static model could describe.

    `sample` is named first because it is the table the filters narrow hardest, and D5 keeps
    `(test_id, run_id)` on it for exactly this direction -- though `select_from` fixes the SQL and
    not the plan, and PostgreSQL will drive from `{suite}.run` or `{suite}.commit` instead when
    that is cheaper. Every join but the first is by primary key whichever way round it is taken.
    The two readers below select different things from this join and page differently, but the join
    is one thing and is stated once, so a change to the foreign keys cannot reach one and miss the
    other.
    """

    def __init__(self, suite: Suite, metric: Metric) -> None:
        self.table: Table = suite.tables.sample
        self._run: Table = suite.tables.run
        self._commit: Table = suite.tables.commit
        self._machine: Table = suite.tables.machine
        self.value: Column[Any] = self.table.c[metric.name]
        # The two columns a range filter bounds. Public because `exclusive_range` takes a column
        # rather than a predicate -- R3's ranges are the same shape whichever column they bound.
        self.ordinal: Column[Any] = self._commit.c.ordinal
        self.submitted_at: Column[Any] = self._run.c.submitted_at

    def source(self) -> Join:
        return (
            self.table.join(self._run, self._run.c.id == self.table.c.run_id)
            .join(self._commit, self._commit.c.id == self._run.c.commit_id)
            .join(self._machine, self._machine.c.id == self._run.c.machine_id)
        )

    def measured_on(self, machines: Collection[int]) -> ColumnElement[bool]:
        """R3's `machine=`, over however many machines the endpoint lets a request name.

        `POST /query` names one and `POST /trends` a list, and a one-element `IN` plans exactly as
        an equality does, so the two need one spelling rather than two. By id rather than by the
        joined name, so the filter lands on the leading column of D5's `(machine_id, submitted_at)`
        index -- and so an unknown name is R3's 404, raised where the ids are resolved.
        """
        return self._run.c.machine_id.in_(machines)


class Points(_Series):
    """The series as rows: one data point per sample that has a value for the metric."""

    def __init__(self, suite: Suite, metric: Metric) -> None:
        super().__init__(suite, metric)
        self.metric = metric.name
        self._test: Table = suite.tables.test
        # Resolved here rather than at the route, so that the three names endpoints.md gives `sort`
        # and the columns they mean are stated once. `commit` means the *ordinal*: D1 separates a
        # commit's identity from its position, and only the position is an order.
        self._sortable: dict[str, Column[Any]] = {
            "test": self._test.c.name,
            "commit": self.ordinal,
            "submitted_at": self.submitted_at,
        }

    def select(self) -> Select[Any]:
        """Every column a point is rendered from, plus the sample id the cursor orders by.

        `value IS NOT NULL` is part of the query rather than a filter the caller asks for: a sample
        that recorded nothing for this metric is not a point in its series, and R4 promises `value`
        is there on every point returned.
        """
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
            .select_from(self.source().join(self._test, self._test.c.id == self.table.c.test_id))
            .where(self.value.is_not(None))
        )

    def keyset(self, sort: QuerySort | None) -> Keyset:
        """D10's ordering: the caller's sort, then the sample's id as the unique tiebreaker.

        None of the three sort fields is unique -- a commit carries many tests, a test spans many
        commits, and two runs can be accepted in the same instant -- so each needs the tiebreaker
        under it. With no `sort` it is the whole order, which is the arbitrary but deterministic one
        R2 allows, and which excludes nothing: it is the only key, and a primary key is never null.
        Sorting by commit excludes the commits with no ordinal, and that falls out of the keyset
        rather than being asked for here -- `Keyset.defined` drops the rows where a sort key is null
        (D10).

        One note on cost, which is this list's alone. The caller's sort key lives on
        `{suite}.commit`, `{suite}.test` or `{suite}.run` while the tiebreaker is
        `{suite}.sample.id`, so the cursor's row comparison spans two tables and is not the exact
        index condition it is on the run list, where D5 adds `(submitted_at, id)` for that. It does
        not degrade to a full sort per page: each of the three sort columns is indexed on its own
        table -- `uq_commit_ordinal`, `uq_test_name`, `(submitted_at, id)` -- so PostgreSQL drives
        the join from that index and finishes with an incremental sort over the tiebreaker alone,
        which stops as soon as the page is full. The unsorted mode is better still, being a
        single-table `sample.id > ?` on the primary key.
        """
        if sort is None:
            return Keyset(tiebreaker=self.table.c.id)
        field, descending = sort_order(sort)
        return Keyset(SortKey(self._sortable[field], descending), tiebreaker=self.table.c.id)

    def measured_for(self, tests: Collection[int]) -> ColumnElement[bool]:
        """endpoints.md's `test` list: a disjunction, landing on D5's `(test_id, run_id)` index."""
        return self.table.c.test_id.in_(tests)

    def at_commit(self, value: str) -> ColumnElement[bool]:
        """R3's `commit=`, over the join `select` already makes.

        By the joined value rather than by a resolved id, which is what makes a value no commit has
        an empty page rather than a 404 -- the asymmetry R3 draws between this filter and the two
        range bounds beside it.
        """
        return self._commit.c.commit == value

    def read(self, row: Row[Any]) -> DataPoint:
        # By column object rather than by name throughout: the row spans five tables, two of them
        # have a `name`, and a metric may legally be called `commit`, `ordinal`, `tag` or `uuid` --
        # D5 only reserves `{suite}.sample`'s own built-ins against a metric's name. The mapping is
        # bound once rather than per column, because `Row._mapping` builds a new view on every
        # access and this is the one reader that runs over pages of ten thousand rows.
        values = row._mapping
        return DataPoint(
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


class Trends(_Series):
    """The same series collapsed to one geomean per (machine, commit).

    Separate from `Points` rather than derived from it: this one has no cursor and no test
    dimension, and selects aggregates where the other selects rows. What the two do share -- the
    join and the machine filter -- they share through `_Series` rather than by restating it.
    """

    def __init__(self, suite: Suite, metric: Metric) -> None:
        super().__init__(suite, metric)
        # D3's geomean, in SQL. `ln` is defined only for a positive value, so the `value > 0` in
        # `select` below is what makes this total -- and `exp(avg(...))` therefore never yields
        # NULL. A (machine, commit) with nothing positive to average forms no group at all and is
        # absent from the response, rather than present with a null where a geomean would be.
        #
        # Cast because an `integer` metric is aggregated in floating point and returned as a real,
        # which endpoints.md states and D3 justifies: an integer geomean is not an integer, and
        # PostgreSQL would otherwise be left to pick between `ln(numeric)` and `ln(double)` from an
        # integer argument.
        self.geomean = func.exp(func.avg(func.ln(sql_cast(self.value, Double))))
        self.latest = func.max(self.submitted_at)

    def select(self) -> Select[Any]:
        """One row per (machine, commit) that has at least one positive value for the metric.

        Grouped by the two primary keys alone. PostgreSQL recognizes that a table's other columns
        are functionally dependent on its primary key, so `machine.name` and the commit's three
        columns are selectable without being grouped by -- which is both shorter and a narrower
        grouping key than repeating them would be.

        Ordered by machine and then by ordinal: the response is unpaginated, so it needs no keyset,
        but a client rendering one line per machine should not have to sort it first.
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
            .select_from(self.source())
            .where(self.value > 0, self.ordinal.is_not(None))
            .group_by(self._machine.c.id, self._commit.c.id)
            .order_by(self._machine.c.name, self.ordinal)
        )

    def cutoff(self, connection: Connection, last_n: int) -> int | None:
        """The lowest ordinal among the suite's `last_n` most recent commits, or None if it has
        fewer than that many.

        Counted over the suite's commits rather than over the rows the other filters leave, so that
        "the last 500 commits" means the same range on every card of the Dashboard -- a machine that
        stopped reporting inside that range shows a trendline that stops, rather than one silently
        stretched back over older commits to make up the count.

        A separate statement rather than a scalar subquery, because "fewer commits than asked for"
        has to mean "keep everything": as a subquery it would yield NULL, and `ordinal >= NULL` is
        unknown for every row, which would empty the response instead of filling it. It costs one
        bounded backward scan of the unique index D5 puts on `{suite}.commit.ordinal`.
        """
        return connection.execute(
            select(self.ordinal)
            .where(self.ordinal.is_not(None))
            .order_by(self.ordinal.desc())
            .offset(last_n - 1)
            .limit(1)
        ).scalar_one_or_none()

    def read(self, row: Row[Any]) -> TrendPoint:
        values = row._mapping
        return TrendPoint(
            machine=values[self._machine.c.name],
            commit=values[self._commit.c.commit],
            ordinal=values[self.ordinal],
            submitted_at=values[self.latest],
            tag=values[self._commit.c.tag],
            value=values[self.geomean],
        )


def _numeric(suite: Suite, name: str) -> Metric:
    """The metric a trend is taken of: declared, and one D3 calls numeric.

    Two 400s from one place, because they are one question to the caller -- is this a metric this
    suite can average? R3 already makes an undeclared metric a 400 rather than a 404, since it names
    a column the schema declares rather than a row the suite holds; a `text` or `datetime` metric is
    the same kind of answer, a request that no data could satisfy.
    """
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
    testsuite: str, body: QueryRequest, engine: EngineDep, registry: RegistryDep
) -> CursorPage[DataPoint]:
    """One metric's measured values, filtered, ordered and cursor-paginated (R2, R3, D10).

    `read`-scoped despite being a POST: the body is a filter too large for a query string, not a
    change (R5) -- the same shape as `POST /commits/resolve`.

    The metric is resolved first, and that ordering is the precedence endpoints.md states for a
    request that gets more than one thing wrong: an undeclared metric is a 400 and beats the 404 an
    absent machine or test earns, because a metric the schema does not declare is a request that
    could never be answered whereas an absent machine is a fact about the suite.
    """
    with engine.connect() as connection, suite_scope(registry, connection, testsuite) as suite:
        points = Points(suite, declared_entry(suite.schema, Metric, body.metric))
        conditions: list[ColumnElement[bool]] = []
        if body.machine is not None:
            conditions.append(points.measured_on([machine_id(connection, suite, body.machine)]))
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


@router.post(
    "/trends",
    dependencies=[require_scope(Scope.READ)],
    summary="Query geomean-aggregated trend data",
    responses=suite_responses(not_found=_NO_TREND_ENTITY),
)
def query_trends(
    testsuite: str, body: TrendsRequest, engine: EngineDep, registry: RegistryDep
) -> Items[TrendPoint]:
    """One geomean per machine and commit, for the Dashboard's sparklines (R2, R3, D3).

    Unpaginated, because the result is bounded by (machines x `last_n`) -- a few thousand rows at
    the ceiling, and a few hundred for the Dashboard, which asks for five machines and five hundred
    commits.
    """
    with engine.connect() as connection, suite_scope(registry, connection, testsuite) as suite:
        trends = Trends(suite, _numeric(suite, body.metric))
        conditions: list[ColumnElement[bool]] = []
        if body.machine is not None:
            conditions.append(
                trends.measured_on(machine_ids(connection, suite, body.machine).values())
            )
        cutoff = trends.cutoff(connection, body.last_n)
        if cutoff is not None:
            conditions.append(trends.ordinal >= cutoff)

        rows = connection.execute(trends.select().where(*conditions)).all()
        return Items(items=[trends.read(row) for row in rows])

"""Regressions: the triage records an external detector keeps (E8).

O3 settles what this is: v5 detects nothing on its own, so every regression and every indicator
arrives from a process that analysed the time series elsewhere and decided something changed. These
endpoints are CRUD over what it decided, and nothing more.

Four things here are worth attention.

A state is stored as an integer and spoken as a string (D5). Both spellings and the translation
between them live in `suites/states.py`, so neither this module nor the DDL builder writes either
out.

The list item and the detail body are not one plus a key, the way a run's are: the list carries the
two counts and no `notes`, and the detail carries `notes` and the indicators and no counts. `notes`
is detail-only for exactly the reason `run_parameters` is -- it is unbounded and no list view
renders it.

`machine_count` and `test_count` describe the *regression*, not the query, so they count every
indicator it has however the request filtered. They ride on the list query as a LATERAL aggregate:
a page is twenty-five regressions, and counting per item would be fifty statements to answer one
request.

The two indicator routes answer 200 rather than 201 or 204, and neither is an error when it changes
nothing. That is deliberate: a batch whose indicators all already exist creates nothing, and a
retried removal names UUIDs that are already gone.
"""

from __future__ import annotations

from collections.abc import Collection, Sequence
from contextlib import AbstractContextManager, nullcontext
from datetime import datetime
from typing import Annotated, Any, Literal
from uuid import uuid4

from fastapi import APIRouter, Body, Path, Query, Response
from pydantic import BaseModel, ConfigDict, Field, StringConstraints
from sqlalchemy import (
    ColumnElement,
    Connection,
    Row,
    Select,
    Table,
    delete,
    func,
    insert,
    or_,
    select,
    true,
    update,
)
from sqlalchemy.dialects.postgresql import insert as upsert

from lnt_v5 import examples
from lnt_v5.auth import require_scope
from lnt_v5.db import EngineDep, reporting_violation
from lnt_v5.errors import ApiError, ErrorCode
from lnt_v5.patching import omit_defaults
from lnt_v5.querying import (
    DEFAULT_LIMIT,
    MAX_LIMIT,
    BodyCursor,
    BodyLimit,
    Cursor,
    Keyset,
    Limit,
    SortKey,
    cursor_page,
    search_condition,
    sort_order,
    uuid_prefix,
)
from lnt_v5.responses import CursorPage
from lnt_v5.routes.commits import Commits, commit_id
from lnt_v5.routes.machines import machine_id, machine_ids
from lnt_v5.routes.suites import SUITES_PATH
from lnt_v5.routes.tests import test_id, test_ids
from lnt_v5.scopes import Scope
from lnt_v5.strings import Storable
from lnt_v5.suites.entities import (
    CLIENT_UUID_FORMAT,
    ClientUuid,
    Named,
    UuidKey,
    declared_by_name,
    declared_entry,
    identifier,
    identifiers,
    location_of,
    undeclared,
)
from lnt_v5.suites.registry import RegistryDep, Suite
from lnt_v5.suites.schema import Metric
from lnt_v5.suites.scope import (
    SUITE_SCHEMA_CHANGED,
    SuiteName,
    schema_changed,
    suite_responses,
    suite_scope,
)
from lnt_v5.suites.states import RegressionStateName
from lnt_v5.suites.tables import (
    NAME_LENGTH,
    REGRESSION_COMMIT_CONSTRAINT,
    REGRESSION_INDICATOR_CONSTRAINT,
    REGRESSION_INDICATOR_MACHINE_CONSTRAINT,
    REGRESSION_INDICATOR_METRIC_CONSTRAINT,
    REGRESSION_INDICATOR_REGRESSION_CONSTRAINT,
    REGRESSION_UUID_CONSTRAINT,
)

REGRESSIONS_PATH = f"{SUITES_PATH}/{{testsuite}}/regressions"
INDICATORS_PATH = f"{REGRESSIONS_PATH}/{{uuid}}/indicators"
INDICATOR_LOOKUP_PATH = f"{REGRESSIONS_PATH}/indicators/query"

router = APIRouter(prefix=REGRESSIONS_PATH, tags=["Regressions"])

RegressionSort = Literal["created_at", "-created_at"]

# The largest batch of indicators one request may carry, which is I2's page ceiling for the same
# reason `POST /commits/resolve` takes it: a batch expands into one statement, and an unbounded one
# would expand into a statement with more bind parameters than the protocol carries.
MAX_INDICATORS = MAX_LIMIT

# Every operation here reaches the suite's own tables, so every one can answer both of the failures
# `suite_scope` produces; each widens the wording with the cases it adds of its own.
_NO_REGRESSION = "The test suite or the regression doesn't exist."
_NO_FILTERED_ENTITY = "The test suite, or a machine or test given as a filter, doesn't exist."
_NO_NAMED_ENTITY = "The test suite, or a commit, machine or test named in the body, doesn't exist."
_NO_INDICATOR_TARGET = (
    "The test suite, the regression, or a machine or test named by an indicator, doesn't exist."
)

# The path segment naming a regression.
RegressionKey = Annotated[UuidKey, Path(description="The regression's UUID (not case-sensitive).")]

# Built from `examples.py`, like every example in I8's document, and naming the machine and test
# that the run example in `routes/runs.py` creates.
_EXAMPLE_INDICATOR = {
    "machine": examples.MACHINE,
    "test": examples.TEST,
    "metric": examples.METRIC,
}

_CREATE_EXAMPLES = {
    "regression": {
        "summary": "A regression with a suspected commit and one indicator",
        "value": {
            "title": examples.REGRESSION_TITLE,
            "commit": examples.COMMIT,
            "indicators": [_EXAMPLE_INDICATOR],
        },
    },
    "empty": {
        "summary": "A regression to fill in later",
        "value": {"title": "Noisy std::stable_sort results on macOS"},
    },
}

_UPDATE_EXAMPLES = {
    "triage": {
        "summary": "Confirm a regression and link its bug",
        "value": {"state": "active", "bug": examples.BUG},
    },
    "detach": {"summary": "Clear the suspected commit", "value": {"commit": None}},
}

_ADD_EXAMPLES = {
    "indicators": {
        "summary": "Add two indicators",
        "value": {
            "indicators": [
                _EXAMPLE_INDICATOR,
                {**_EXAMPLE_INDICATOR, "metric": examples.OTHER_METRIC},
            ]
        },
    }
}

_REMOVE_EXAMPLES = {
    "indicators": {
        "summary": "Remove an indicator",
        "value": {"indicator_uuids": [examples.INDICATOR_UUID]},
    }
}

_QUERY_EXAMPLES = {
    "tracked": {
        "summary": "Which of these are already part of an open regression?",
        "value": {
            "machine": [examples.MACHINE],
            "test": [examples.TEST, examples.OTHER_TEST],
            "metric": examples.METRIC,
            "state": ["detected", "active"],
        },
    }
}

# The docstrings of the models and endpoints below, and the field descriptions, are published, as
# the descriptions I8's document gives them, so they are written for API users.

Title = Annotated[
    str,
    StringConstraints(min_length=1, max_length=NAME_LENGTH),
    Storable,
    Field(
        description="A short summary of the regression. Null if it has none.",
        examples=[examples.REGRESSION_TITLE],
    ),
]

Bug = Annotated[
    str,
    StringConstraints(min_length=1, max_length=NAME_LENGTH),
    Storable,
    Field(
        description="A link to the regression's bug report. Null if it has none.",
        examples=[examples.BUG],
    ),
]

Notes = Annotated[
    str,
    Storable,
    Field(
        description=(
            "Notes from the investigation, such as A/B results or bisection findings. Null if "
            "there are none. Not included in the regression list."
        ),
        examples=["Bisected to the commit. Only the 8-element case regressed, by about 15%."],
    ),
]


# I4's reference rule throughout: each part is the other entity's identifier under a key named after
# it, rather than a nested object. A metric is declared by the suite's schema rather than created
# like a machine or a test, but is referenced the same way underneath (D5).
class Indicator(BaseModel):
    """A machine, test and metric where a regression was seen."""

    uuid: str = Field(
        description="The indicator's UUID, generated by the server.",
        examples=[examples.INDICATOR_UUID],
    )
    machine: str = Field(description="The name of the machine.", examples=[examples.MACHINE])
    test: str = Field(description="The name of the test.", examples=[examples.TEST])
    metric: str = Field(description="The name of the metric.", examples=[examples.METRIC])


# I3 makes a name that is not there a 404 for the machine and the test, which nothing here creates,
# but a 400 for the metric: a metric is a column the schema declares rather than a row the suite
# holds.
class IndicatorObject(BaseModel):
    """A machine, test and metric where a regression was seen. The machine and the test must
    already exist, and the metric must be defined in the suite's schema."""

    model_config = ConfigDict(extra="forbid")

    machine: Named = Field(description="The name of the machine.")
    test: Named = Field(description="The name of the test.")
    metric: Named = Field(description="The name of the metric.")


class _Regression(BaseModel):
    """What the list item and the detail body both carry.

    Not published on its own: the two bodies genuinely differ -- the list has the counts, the detail
    has `notes` and the indicators -- so neither is the other plus a key, and this exists so that
    the keys they do share are described once.
    """

    uuid: str = Field(
        description=(
            "The regression's UUID, either chosen when it was created or generated by the server. "
            "Always in lowercase."
        ),
        examples=[examples.REGRESSION_UUID],
    )
    title: Title | None
    bug: Bug | None
    state: RegressionStateName = Field(description="The state of the regression.")
    commit: str | None = Field(
        description=(
            "The value of the commit suspected of causing the regression. Null if it isn't known."
        ),
        examples=[examples.COMMIT],
    )
    created_at: datetime = Field(description="When the regression was created. Set by the server.")


# The two counts describe the regression rather than the request: they count the distinct machines
# and tests across *every* indicator it has, whatever `machine=` or `test=` narrowed the results
# down to.
class Regression(_Regression):
    """A performance regression being investigated. In the list, notes and indicators are left
    out, and the number of machines and tests involved is given instead."""

    machine_count: int = Field(
        description=(
            "The number of different machines in the regression's indicators, regardless of the "
            "request's filters."
        )
    )
    test_count: int = Field(
        description=(
            "The number of different tests in the regression's indicators, regardless of the "
            "request's filters."
        )
    )


class RegressionDetail(_Regression):
    """A performance regression being investigated, with its notes and indicators."""

    notes: Notes | None
    indicators: list[Indicator] = Field(
        description=(
            "The machines, tests and metrics where the regression was seen, oldest first. Can be "
            "empty: a regression can be created without indicators, and its indicators are "
            "deleted along with their machine, or when their metric is removed from the schema."
        )
    )


class _RegressionBody(BaseModel):
    """The five keys `POST` and `PATCH` both accept, which endpoints.md gives them identically.

    Not published on its own. What the two do with an omitted key differs -- `POST` falls back to
    the defaults here, `PATCH` dumps with `exclude_unset` and leaves the stored value alone -- but
    what they accept does not, and stating it twice would let them drift on a field they are
    specified to share.

    Four of the five are nullable and a null clears the stored value on `PATCH`, the same
    convention as `PATCH /api/suites/{testsuite}/commits/{value}`. `state` is the exception,
    because a regression is always in one of the five states; sending `state: null` is a 400.
    """

    model_config = ConfigDict(extra="forbid")

    title: Title | None = None
    bug: Bug | None = None
    notes: Notes | None = None
    state: RegressionStateName = Field(
        default=RegressionStateName.DETECTED,
        description=(
            "The state of the regression. Can't be null. New regressions are `detected` unless "
            "another state is given."
        ),
    )
    commit: Named | None = Field(
        default=None,
        description=(
            "The value of the commit suspected of causing the regression. Returns 404 if the "
            "commit doesn't exist."
        ),
    )


class RegressionCreate(_RegressionBody):
    """A new regression. All keys are optional, so a regression can be recorded right away and
    filled in as the investigation progresses."""

    uuid: ClientUuid | None = Field(
        default=None,
        description=(
            f"The regression's UUID. {CLIENT_UUID_FORMAT} Choosing it yourself makes it safe to "
            "retry the request: if a regression with this UUID already exists, you get a 409 "
            "`duplicate`."
        ),
    )

    indicators: list[IndicatorObject] = Field(
        default_factory=list,
        max_length=MAX_INDICATORS,
        description=(
            f"The machines, tests and metrics where the regression was seen, at most "
            f"{MAX_INDICATORS}. Duplicates are ignored."
        ),
    )


# Indicators are deliberately absent: they are managed through the two routes below, which are batch
# operations with counts of their own rather than a whole-list replacement. Sending one here is a
# 400, rather than a key that could not take effect being silently dropped.
class RegressionUpdate(_RegressionBody):
    """Changes to a regression. Only include what you want to change. Set a key to null to clear
    it (except `state`, which can't be null). Indicators have their own operations."""

    model_config = ConfigDict(json_schema_extra=omit_defaults)


class IndicatorAddition(BaseModel):
    """The indicators to add to a regression."""

    model_config = ConfigDict(extra="forbid")

    indicators: list[IndicatorObject] = Field(
        min_length=1,
        max_length=MAX_INDICATORS,
        description=(
            f"The indicators to add, from 1 to {MAX_INDICATORS} of them. Indicators the regression "
            "already has, and duplicates, are ignored."
        ),
    )


class IndicatorRemoval(BaseModel):
    """The indicators to remove from a regression."""

    model_config = ConfigDict(extra="forbid")

    indicator_uuids: list[UuidKey] = Field(
        min_length=1,
        max_length=MAX_INDICATORS,
        description=(
            f"The UUIDs of the indicators to remove, from 1 to {MAX_INDICATORS} of them (not "
            "case-sensitive). UUIDs that don't match an indicator of this regression are ignored, "
            "so it is safe to retry a removal."
        ),
    )


class IndicatorsAdded(BaseModel):
    """The number of indicators added, and the regression's indicators afterwards."""

    added: int = Field(description="The number of indicators that were actually added.")
    indicators: list[Indicator] = Field(
        description="All the regression's indicators after the change, oldest first."
    )


class IndicatorsRemoved(BaseModel):
    """The number of indicators removed, and the regression's indicators afterwards."""

    removed: int = Field(description="The number of indicators that were actually removed.")
    indicators: list[Indicator] = Field(
        description="All the regression's indicators after the change, oldest first."
    )


# The regression is referenced by its UUID and nothing else (E8). A client that needs its title,
# state or commit joins on that UUID with the regression list, which already carries them.
class RegressionIndicator(Indicator):
    """An indicator, with the UUID of its regression. To get the regression's title, state and
    commit, look it up by UUID in the regression list."""

    regression_uuid: str = Field(
        description="The UUID of the regression.", examples=[examples.REGRESSION_UUID]
    )


# A body rather than query parameters for the reason `POST /query` takes one. The lists are bounded
# at I2's page ceiling for that endpoint's reason too: each expands into one statement, and an
# unbounded one would carry more bind parameters than the protocol does.
class IndicatorQuery(BaseModel):
    """Which indicators to return. All keys are optional, and only indicators that match every
    key given are returned."""

    model_config = ConfigDict(extra="forbid")

    machine: list[Named] | None = Field(
        default=None,
        max_length=MAX_LIMIT,
        description=(
            f"Only return indicators for one of these machines (at most {MAX_LIMIT}). Returns 404 "
            "if any of them doesn't exist. An empty list returns nothing; leave the key out to "
            "include all machines."
        ),
    )
    test: list[Named] | None = Field(
        default=None,
        max_length=MAX_LIMIT,
        description=(
            f"Only return indicators for one of these tests (at most {MAX_LIMIT}). Returns 404 if "
            "any of them doesn't exist. An empty list returns nothing; leave the key out to "
            "include all tests."
        ),
    )
    metric: Named | None = Field(
        default=None,
        description=(
            "Only return indicators for this metric. Returns 400 if the suite's schema doesn't "
            "define it."
        ),
    )
    state: list[RegressionStateName] | None = Field(
        default=None,
        max_length=MAX_LIMIT,
        description=(
            "Only return indicators of regressions in one of these states. An empty list returns "
            "nothing."
        ),
    )
    commit: Named | None = Field(
        default=None,
        description=(
            "Only return indicators of regressions whose suspected commit is this one. If the "
            "commit doesn't exist, the result is empty."
        ),
    )
    limit: BodyLimit = DEFAULT_LIMIT
    cursor: BodyCursor = None


class Regressions:
    """The queries every regression response is built from, and how to read their rows back.

    Held together rather than written per endpoint so that the list and the detail cannot drift
    apart on the columns they name or the way they read one -- the same arrangement as `Machines`,
    `Commits` and `Runs`.

    The internal `id` rides along with the rest. It is never rendered -- I1 keeps auto-increment ids
    out of the API entirely -- but it is the unique tiebreaker O5 requires under the cursor, and
    the whole of the order when the list is asked for no `sort`.
    """

    def __init__(self, suite: Suite) -> None:
        self.suite = suite
        self.schema = suite.schema
        self.table: Table = suite.tables.regression
        self._indicator: Table = suite.tables.regression_indicator
        self._commit: Table = suite.tables.commit
        self._machine: Table = suite.tables.machine
        self._metric: Table = suite.tables.metric
        self._test: Table = suite.tables.test
        # Both counts from one pass over a regression's indicators, carried by the list query
        # itself. An aggregate with no GROUP BY always yields exactly one row, so a regression with
        # no indicators gets (0, 0) from an ordinary join rather than needing an outer one.
        self._counts = (
            select(
                func.count(self._indicator.c.machine_id.distinct()).label("machines"),
                func.count(self._indicator.c.test_id.distinct()).label("tests"),
            )
            .where(self._indicator.c.regression_id == self.table.c.id)
            .lateral("counts")
        )
        self.machine_count = self._counts.c.machines
        self.test_count = self._counts.c.tests

    def select(self) -> Select[Any]:
        """What both bodies carry: the regression's own columns, plus the commit it may name.

        Outer, because `commit_id` is nullable -- a regression need not name a commit (D5).
        """
        return select(
            self.table.c.id,
            self.table.c.uuid,
            self.table.c.title,
            self.table.c.bug,
            self.table.c.state,
            self.table.c.created_at,
            self._commit.c.commit,
        ).select_from(
            self.table.outerjoin(self._commit, self._commit.c.id == self.table.c.commit_id)
        )

    def listed(self) -> Select[Any]:
        """The list query: the shared columns and the two counts, deliberately without `notes`."""
        return (
            self.select()
            .add_columns(self.machine_count, self.test_count)
            .join(self._counts, true())
        )

    def keyset(self, sort: RegressionSort | None) -> Keyset:
        """O5's ordering for this list: the caller's sort, then the internal tiebreaker.

        `created_at` is not unique -- nothing stops two regressions being created in the same
        instant -- so it cannot be the whole order on its own. Nor can the id stand in for it, the
        way it does for a commit's `first_seen`: `created_at` is when the creating transaction began
        and the id is handed out when it inserts, so concurrent creations can order the two
        differently. With no `sort` the tiebreaker is the whole order, which is the arbitrary but
        deterministic one O5 allows.
        """
        if sort is None:
            return Keyset(tiebreaker=self.table.c.id)
        _, descending = sort_order(sort)
        return Keyset(SortKey(self.table.c.created_at, descending), tiebreaker=self.table.c.id)

    def search(self, term: str) -> ColumnElement[bool]:
        """O4's `?search=` for regressions: the title, or the UUID by prefix."""
        return or_(
            search_condition(term, self.table, ["title"]), uuid_prefix(self.table.c.uuid, term)
        )

    def in_states(self, states: Collection[RegressionStateName]) -> ColumnElement[bool]:
        """I3's `state=`, over the list and the indicator lookup alike.

        Deduplicated and sorted, because the bound values are part of a cursor's scope
        (`cursor_page`): naming the same states in another order asks for the same results.
        """
        return self.table.c.state.in_(sorted({name.stored for name in states}))

    def commit_is(self, value: str) -> ColumnElement[bool]:
        """I3's `commit=`, over the outer join `select` already makes.

        A value no commit has matches nothing rather than being an error, which is the asymmetry
        I3 draws between this filter and `machine=`.
        """
        return self._commit.c.commit == value

    def indicates(
        self, *, machine: int | None, test: int | None, metric: str | None
    ) -> ColumnElement[bool]:
        """Whether this regression has an indicator matching everything the request asked for.

        One predicate over one indicator rather than three independent ones, the same choice
        `Tests.has_sample` makes: a request naming a machine and a metric is asking which
        regressions affect that metric *on that machine*, not which affect either.

        An EXISTS rather than a join, so that a regression with several matching indicators is one
        row -- a join would need a DISTINCT, which a keyset cannot page through.
        """
        conditions = [self._indicator.c.regression_id == self.table.c.id]
        if machine is not None:
            conditions.append(self._indicator.c.machine_id == machine)
        if test is not None:
            conditions.append(self._indicator.c.test_id == test)
        if metric is not None:
            conditions.append(self.names_metric(metric))
        return select(1).select_from(self._indicator).where(*conditions).exists()

    def names_metric(self, metric: str) -> ColumnElement[bool]:
        """Whether an indicator names this metric, compared by id rather than through a join.

        The subquery runs once, so the comparison is a constant on the indicator's own column, which
        D5's index can use; the metric's name on a joined table is a condition the planner may only
        apply after reading every indicator for the machine and test.
        """
        return (
            self._indicator.c.metric_id
            == select(self._metric.c.id).where(self._metric.c.name == metric).scalar_subquery()
        )

    def _common(self, row: Row[Any]) -> dict[str, Any]:
        return {
            "uuid": row._mapping[self.table.c.uuid],
            "title": row._mapping[self.table.c.title],
            "bug": row._mapping[self.table.c.bug],
            "state": RegressionStateName.of(row._mapping[self.table.c.state]),
            "commit": row._mapping[self._commit.c.commit],
            "created_at": row._mapping[self.table.c.created_at],
        }

    def read(self, row: Row[Any]) -> Regression:
        # Not validated, like `Runs.read`: the model's validators are the rules for what a request
        # may write, and a stored row that breaks one -- a title stored before the rules said it
        # could not be empty, say -- still has to be served. The same goes for `detail` and
        # `indicators` below.
        return Regression.model_construct(
            **self._common(row),
            machine_count=row._mapping[self.machine_count],
            test_count=row._mapping[self.test_count],
        )

    def detail(self, connection: Connection, uuid: str) -> RegressionDetail:
        """One regression with its indicators, as the detail, create and update responses go.

        Two statements rather than one: folding the indicators into a join would repeat the
        unbounded `notes` once per indicator row.
        """
        row = connection.execute(
            self.select().add_columns(self.table.c.notes).where(self.table.c.uuid == uuid)
        ).one_or_none()
        if row is None:
            raise self.missing(uuid)
        return RegressionDetail.model_construct(
            **self._common(row),
            notes=row._mapping[self.table.c.notes],
            indicators=self.indicators(connection, row._mapping[self.table.c.id]),
        )

    def indicators(self, connection: Connection, regression: int) -> list[Indicator]:
        """Every indicator of one regression, oldest first.

        Ordered by the internal id rather than left to the database, so that a client rendering the
        table sees the same order twice running. D5's unique constraint leads with `regression_id`,
        which is what makes this an index scan of just this regression's rows.
        """
        rows = connection.execute(
            self._indicators()
            .where(self._indicator.c.regression_id == regression)
            .order_by(self._indicator.c.id)
        ).all()
        return [Indicator.model_construct(**self._indicator_keys(row)) for row in rows]

    def lookup(self) -> Select[Any]:
        """E8's indicator lookup: every indicator, with the UUID of its regression.

        Joined to the regression for that UUID and for the state the lookup filters on. The
        keyset's four sort keys ride along, never rendered.
        """
        return (
            self._indicators()
            .add_columns(
                self._indicator.c.machine_id,
                self._indicator.c.test_id,
                self._indicator.c.metric_id,
                self._indicator.c.id,
                self.table.c.uuid,
            )
            .join(self.table, self.table.c.id == self._indicator.c.regression_id)
        )

    def lookup_keyset(self) -> Keyset:
        """The lookup's order, which E8 leaves arbitrary: that of D5's indicator index.

        `(machine_id, test_id, metric_id, id)`, so that the filters and the cursor are both
        conditions on that index and a page is a bounded scan of it. Ordered by the id alone, every
        page would read every match.
        """
        return Keyset(
            SortKey(self._indicator.c.machine_id),
            SortKey(self._indicator.c.test_id),
            SortKey(self._indicator.c.metric_id),
            tiebreaker=self._indicator.c.id,
        )

    def on_machines(self, machines: Collection[int]) -> ColumnElement[bool]:
        """The lookup's `machine` list.

        Sorted because the bound values are part of the cursor's scope (`cursor_page`), and the ids
        come from a lookup whose row order follows the plan PostgreSQL picks: an identical request
        could otherwise have its cursor refused.
        """
        return self._indicator.c.machine_id.in_(sorted(machines))

    def for_tests(self, tests: Collection[int]) -> ColumnElement[bool]:
        """The lookup's `test` list, sorted for the same reason."""
        return self._indicator.c.test_id.in_(sorted(tests))

    def attributed_to(self, value: str) -> ColumnElement[bool]:
        """The lookup's `commit`: regressions attributed to the commit with this value.

        Compared through a subquery rather than a join, since the lookup reads nothing else from the
        commit. A value no commit has makes the subquery null, which matches nothing -- I3's answer
        for a commit used as a filter, as `commit=` on the list gives it.
        """
        return (
            self.table.c.commit_id
            == select(self._commit.c.id).where(self._commit.c.commit == value).scalar_subquery()
        )

    def read_lookup(self, row: Row[Any]) -> RegressionIndicator:
        """One lookup row as E8 renders it: the indicator, and its regression's UUID."""
        return RegressionIndicator.model_construct(
            **self._indicator_keys(row), regression_uuid=row._mapping[self.table.c.uuid]
        )

    def _indicators(self) -> Select[Any]:
        """An indicator's keys, read through the three tables its references point at."""
        return select(
            self._indicator.c.uuid,
            self._machine.c.name,
            self._test.c.name,
            self._metric.c.name,
        ).select_from(
            self._indicator.join(self._machine, self._machine.c.id == self._indicator.c.machine_id)
            .join(self._test, self._test.c.id == self._indicator.c.test_id)
            .join(self._metric, self._metric.c.id == self._indicator.c.metric_id)
        )

    def _indicator_keys(self, row: Row[Any]) -> dict[str, Any]:
        # By column object rather than by name: the row spans several tables and three of them have
        # a `name`.
        return {
            "uuid": row._mapping[self._indicator.c.uuid],
            "machine": row._mapping[self._machine.c.name],
            "test": row._mapping[self._test.c.name],
            "metric": row._mapping[self._metric.c.name],
        }

    def resolve(self, connection: Connection, uuid: str) -> int:
        """The id of the regression a route addresses, or the 404 for one that is not there.

        What the indicator routes anchor on: both filter on `regression_id`, and reading the whole
        regression to get it would select a join and its indicators only to throw them away.
        """
        return identifier(connection, self.table.c.uuid, uuid, self.missing)

    def missing(self, uuid: str) -> ApiError:
        """The 404 for a regression that is not there, worded in one place for all its callers."""
        return ApiError(
            ErrorCode.NOT_FOUND, f"No regression '{uuid}' in test suite '{self.schema.name}'"
        )

    def resolved_indicators(
        self, connection: Connection, submitted: Sequence[IndicatorObject]
    ) -> list[dict[str, Any]]:
        """The rows a batch of submitted indicators stands for, deduplicated (E8).

        The metrics go first, because they are checked against the schema already in memory: a
        batch naming a metric the suite does not declare is I3's 400 without a statement having
        run.

        Every machine, test and metric is then resolved in one statement each rather than one per
        indicator, which is what keeps a batch of a thousand from costing three thousand round
        trips. A metric the schema declares but `{suite}.metric` does not hold was removed by
        another worker since this one last loaded the schema, which is D2's retryable 409.

        Duplicates within the batch are collapsed here, before the insert: D5's unique constraint
        would ignore them anyway, but only after they had been counted as added.

        The rows come back sorted, whatever order the request named them in. `add_indicators`
        inserts under `ON CONFLICT DO NOTHING`, which waits on a row another transaction has
        inserted but not committed, so two batches overlapping in opposite orders would each hold a
        row the other waits on. In one fixed order, O8's rule for test names, they cannot.
        """
        # The declared list is turned into a lookup once rather than once per metric, which is what
        # `declared_entry` would do -- the batch may name thousands.
        declared = declared_by_name(self.schema, Metric)
        for metric in {one.metric for one in submitted}:
            if metric not in declared:
                raise undeclared(metric, Metric, declared)

        machines = machine_ids(connection, self.suite, [one.machine for one in submitted])
        tests = test_ids(connection, self.suite, [one.test for one in submitted])
        metrics = identifiers(
            connection,
            self._metric.c.name,
            [one.metric for one in submitted],
            lambda _: schema_changed(self.schema.name),
        )
        rows = {(machines[one.machine], tests[one.test], metrics[one.metric]) for one in submitted}
        return [
            {"machine_id": machine, "test_id": test, "metric_id": metric}
            for machine, test, metric in sorted(rows)
        ]

    def add_indicators(
        self, connection: Connection, regression: int, resolved: Sequence[dict[str, Any]]
    ) -> int:
        """Store a resolved batch, ignoring what this regression already has, and say how many.

        `ON CONFLICT DO NOTHING` against D5's unique constraint rather than a read-then-write:
        endpoints.md asks for a duplicate to be silently ignored, and the constraint is what makes
        that true under two triagers adding the same indicator at once.

        A metric removed after `resolved_indicators` found it fails the foreign key rather than
        leaving an indicator naming a metric that is gone (D5), and is D2's retryable 409. A
        machine deleted in that window fails its own foreign key, and is the 404 an absent machine
        always is: the request names a machine that is no longer there. Nothing deletes a test, so
        its foreign key cannot fail this way.

        `added` is the number of rows `RETURNING` hands back, which under `DO NOTHING` is exactly
        the rows that were inserted. Deliberately not `rowcount`: SQLAlchemy memoizes that for an
        UPDATE or a DELETE but not for an INSERT, so by the time it is read the driver has reset it
        to -1 -- which every other statement in this codebase gets away with because every other
        one counting rows is an UPDATE or a DELETE.
        """
        if not resolved:
            return 0
        statement = upsert(self._indicator).values(
            [{"uuid": str(uuid4()), "regression_id": regression, **row} for row in resolved]
        )
        with (
            reporting_violation(
                REGRESSION_INDICATOR_METRIC_CONSTRAINT,
                ErrorCode.RETRY,
                schema_changed(self.schema.name).message,
            ),
            reporting_violation(
                REGRESSION_INDICATOR_MACHINE_CONSTRAINT,
                ErrorCode.NOT_FOUND,
                "A machine an indicator names was deleted while this request was running.",
            ),
        ):
            return len(
                connection.execute(
                    statement.on_conflict_do_nothing(
                        constraint=REGRESSION_INDICATOR_CONSTRAINT
                    ).returning(self._indicator.c.id)
                ).all()
            )

    def commit_deleted(self, value: str | None) -> AbstractContextManager[None]:
        """The 404 for a commit deleted after the request resolved it, and before it was stored.

        The foreign key is what notices: it waits for a delete still in flight, and fails once that
        delete commits. The request then names a commit that is no longer there, which is the same
        404, worded the same way, as one that never was. A request naming no commit stores no
        reference, so there is nothing to translate.
        """
        if value is None:
            return nullcontext()
        return reporting_violation(
            REGRESSION_COMMIT_CONSTRAINT,
            ErrorCode.NOT_FOUND,
            Commits(self.suite).missing(value).message,
        )

    def remove_indicators(
        self, connection: Connection, regression: int, uuids: Sequence[str]
    ) -> int:
        """Remove whichever of these UUIDs name an indicator of this regression, and say how many.

        The `regression_id` in the predicate is not redundant with the UUIDs beside it: an
        indicator's UUID is unique suite-wide, so without it this would delete another regression's
        indicator on request -- and report it as removed from this one.
        """
        return int(
            connection.execute(
                delete(self._indicator).where(
                    self._indicator.c.regression_id == regression,
                    self._indicator.c.uuid.in_(uuids),
                )
            ).rowcount
        )


# I3's three answers to a filter naming something absent are all visible here: an unknown `machine=`
# or `test=` is a 404, an unknown `metric=` is a 400 -- it names a column the schema declares rather
# than a row the suite holds -- and an unknown `commit=` is an empty page, because a commit no
# regression was ever attributed to is an ordinary answer.
@router.get(
    "",
    dependencies=[require_scope(Scope.READ)],
    summary="List regressions",
    responses=suite_responses(not_found=_NO_FILTERED_ENTITY),
)
def list_regressions(
    testsuite: SuiteName,
    engine: EngineDep,
    registry: RegistryDep,
    cursor: Cursor = None,
    search: Annotated[
        str | None,
        Query(
            description="Only return regressions whose title contains this text, or whose UUID "
            "starts with it. Not case-sensitive."
        ),
    ] = None,
    state: Annotated[
        list[RegressionStateName] | None,
        Query(
            description=(
                "Only return regressions in one of these states. Repeat the parameter for several "
                "states: `state=active&state=detected`. Leave out to return all states."
            )
        ),
    ] = None,
    machine: Annotated[
        str | None,
        Query(
            description=(
                "Only return regressions with an indicator for this machine. Returns 404 if the "
                "machine doesn't exist."
            )
        ),
    ] = None,
    test: Annotated[
        str | None,
        Query(
            description=(
                "Only return regressions with an indicator for this test. Returns 404 if the test "
                "doesn't exist."
            )
        ),
    ] = None,
    metric: Annotated[
        str | None,
        Query(
            description=(
                "Only return regressions with an indicator for this metric. Returns 400 if the "
                "suite's schema doesn't define it."
            )
        ),
    ] = None,
    commit: Annotated[
        str | None,
        Query(
            description=(
                "Only return regressions whose suspected commit is this one. If the commit doesn't "
                "exist, the result is empty."
            )
        ),
    ] = None,
    has_commit: Annotated[
        bool | None,
        Query(
            description=(
                "Only return regressions that have (`true`) or don't have (`false`) a suspected "
                "commit. Leave out to return both."
            )
        ),
    ] = None,
    sort: Annotated[
        RegressionSort | None,
        Query(
            description=(
                "Sort by creation time, oldest first (`created_at`) or newest first "
                "(`-created_at`). Without it, the order is unspecified but stable."
            )
        ),
    ] = None,
    limit: Limit = DEFAULT_LIMIT,
) -> CursorPage[Regression]:
    """The regressions in the suite, one page at a time.

    If you combine `machine`, `test` and `metric`, they must all match the same indicator.
    """
    with engine.connect() as connection, suite_scope(registry, connection, testsuite) as suite:
        regressions = Regressions(suite)
        conditions: list[ColumnElement[bool]] = []
        if search is not None:
            conditions.append(regressions.search(search))
        if state is not None:
            conditions.append(regressions.in_states(state))
        if commit is not None:
            conditions.append(regressions.commit_is(commit))
        if has_commit is not None:
            attributed = regressions.table.c.commit_id.is_not(None)
            conditions.append(attributed if has_commit else ~attributed)
        if metric is not None:
            declared_entry(suite.schema, Metric, metric)
        if machine is not None or test is not None or metric is not None:
            conditions.append(
                regressions.indicates(
                    machine=None if machine is None else machine_id(connection, suite, machine),
                    test=None if test is None else test_id(connection, suite, test),
                    metric=metric,
                )
            )

        return cursor_page(
            connection,
            regressions.listed().where(*conditions),
            regressions.keyset(sort),
            limit,
            cursor,
            regressions.read,
        )


@router.post(
    "",
    status_code=201,
    dependencies=[require_scope(Scope.TRIAGE)],
    summary="Create a regression",
    responses=suite_responses(
        not_found=_NO_NAMED_ENTITY,
        conflict=f"`duplicate`: a regression with this UUID already exists. {SUITE_SCHEMA_CHANGED}",
    ),
)
def create_regression(
    testsuite: SuiteName,
    body: Annotated[RegressionCreate, Body(openapi_examples=_CREATE_EXAMPLES)],
    engine: EngineDep,
    registry: RegistryDep,
    response: Response,
) -> RegressionDetail:
    """Record a regression. The response's `Location` header points to the new regression.

    LNT doesn't detect regressions itself: people or external tools record them here.
    """
    with engine.begin() as connection, suite_scope(registry, connection, testsuite) as suite:
        regressions = Regressions(suite)
        resolved = regressions.resolved_indicators(connection, body.indicators)
        commit = None if body.commit is None else commit_id(connection, suite, body.commit)

        # E8: the client's UUID when it sent one, and a v4 the server mints otherwise.
        uuid = body.uuid or str(uuid4())
        taken = f"A regression '{uuid}' already exists in test suite '{suite.schema.name}'"
        with (
            reporting_violation(REGRESSION_UUID_CONSTRAINT, ErrorCode.DUPLICATE, taken),
            regressions.commit_deleted(body.commit),
        ):
            created = int(
                connection.execute(
                    insert(regressions.table)
                    .values(
                        uuid=uuid,
                        title=body.title,
                        bug=body.bug,
                        notes=body.notes,
                        state=body.state.stored,
                        commit_id=commit,
                    )
                    .returning(regressions.table.c.id)
                ).scalar_one()
            )
        regressions.add_indicators(connection, created, resolved)
        # Read back rather than assembled from the request, so that this is the same body the
        # detail endpoint serves for the same regression.
        detail = regressions.detail(connection, uuid)

    response.headers["Location"] = location_of(REGRESSIONS_PATH, testsuite, uuid)
    return detail


@router.get(
    "/{uuid}",
    dependencies=[require_scope(Scope.READ)],
    summary="Get a regression",
    responses=suite_responses(not_found=_NO_REGRESSION),
)
def get_regression(
    testsuite: SuiteName, uuid: RegressionKey, engine: EngineDep, registry: RegistryDep
) -> RegressionDetail:
    """Get a regression, with its notes and indicators."""
    with engine.connect() as connection, suite_scope(registry, connection, testsuite) as suite:
        return Regressions(suite).detail(connection, uuid)


@router.patch(
    "/{uuid}",
    dependencies=[require_scope(Scope.TRIAGE)],
    summary="Update a regression",
    responses=suite_responses(
        not_found="The test suite, the regression, or the commit named in the body, doesn't exist."
    ),
)
def update_regression(
    testsuite: SuiteName,
    uuid: RegressionKey,
    body: Annotated[RegressionUpdate, Body(openapi_examples=_UPDATE_EXAMPLES)],
    engine: EngineDep,
    registry: RegistryDep,
) -> RegressionDetail:
    """Change a regression's title, bug, notes, state or suspected commit.

    Only include what you want to change. A regression can move from any state to any other.
    """
    with engine.begin() as connection, suite_scope(registry, connection, testsuite) as suite:
        regressions = Regressions(suite)
        # The regression before the commit the body names, so that a request addressing a
        # regression that is not there is told so rather than about its commit.
        regression = regressions.resolve(connection, uuid)
        changes = body.model_dump(exclude_unset=True)
        values: dict[str, Any] = {
            key: changes[key] for key in ("title", "bug", "notes") if key in changes
        }
        if "state" in changes:
            values["state"] = changes["state"].stored
        if "commit" in changes:
            values["commit_id"] = (
                None
                if changes["commit"] is None
                else commit_id(connection, suite, changes["commit"])
            )

        if values:
            with regressions.commit_deleted(changes.get("commit")):
                changed = connection.execute(
                    update(regressions.table)
                    .where(regressions.table.c.id == regression)
                    .values(**values)
                )
            # A delete that committed after `resolve` leaves nothing to update.
            if changed.rowcount == 0:
                raise regressions.missing(uuid)
        return regressions.detail(connection, uuid)


@router.delete(
    "/{uuid}",
    status_code=204,
    dependencies=[require_scope(Scope.TRIAGE)],
    summary="Delete a regression",
    responses=suite_responses(not_found=_NO_REGRESSION),
)
def delete_regression(
    testsuite: SuiteName, uuid: RegressionKey, engine: EngineDep, registry: RegistryDep
) -> None:
    """Delete a regression and its indicators. The machines, tests and commit it refers to are not
    affected."""
    # One statement: D5 gives `{suite}.regression_indicator.regression_id` an `ON DELETE CASCADE`.
    with engine.begin() as connection, suite_scope(registry, connection, testsuite) as suite:
        regressions = Regressions(suite)
        removed = connection.execute(
            delete(regressions.table).where(regressions.table.c.uuid == uuid)
        )
        if removed.rowcount == 0:
            raise regressions.missing(uuid)


# 200 rather than 201, because a batch whose indicators all already exist creates nothing and there
# is no one resource to point a `Location` at. `indicators` is the whole list afterwards -- which is
# what a client rendering the indicator table needs, and saves it a second request.
@router.post(
    "/{uuid}/indicators",
    dependencies=[require_scope(Scope.TRIAGE)],
    summary="Add indicators to a regression",
    responses=suite_responses(not_found=_NO_INDICATOR_TARGET),
)
def add_indicators(
    testsuite: SuiteName,
    uuid: RegressionKey,
    body: Annotated[IndicatorAddition, Body(openapi_examples=_ADD_EXAMPLES)],
    engine: EngineDep,
    registry: RegistryDep,
) -> IndicatorsAdded:
    """Add indicators to a regression. Indicators it already has are ignored. The response lists
    all of its indicators afterwards."""
    with engine.begin() as connection, suite_scope(registry, connection, testsuite) as suite:
        regressions = Regressions(suite)
        regression = regressions.resolve(connection, uuid)
        resolved = regressions.resolved_indicators(connection, body.indicators)
        # A delete of the regression committing after `resolve` fails the insert's foreign key, and
        # is the same 404 as a regression that was never there. Creation needs no such guard: it
        # adds indicators to a regression no other transaction can see yet.
        with reporting_violation(
            REGRESSION_INDICATOR_REGRESSION_CONSTRAINT,
            ErrorCode.NOT_FOUND,
            regressions.missing(uuid).message,
        ):
            added = regressions.add_indicators(connection, regression, resolved)
        return IndicatorsAdded(
            added=added, indicators=regressions.indicators(connection, regression)
        )


@router.delete(
    "/{uuid}/indicators",
    dependencies=[require_scope(Scope.TRIAGE)],
    summary="Remove indicators from a regression",
    responses=suite_responses(not_found=_NO_REGRESSION),
)
def remove_indicators(
    testsuite: SuiteName,
    uuid: RegressionKey,
    body: Annotated[IndicatorRemoval, Body(openapi_examples=_REMOVE_EXAMPLES)],
    engine: EngineDep,
    registry: RegistryDep,
) -> IndicatorsRemoved:
    """Remove indicators from a regression, by UUID. The response lists all of its indicators
    afterwards.

    UUIDs that don't match an indicator of this regression are ignored, so it is safe to retry a
    removal. A regression left without indicators is kept.
    """
    with engine.begin() as connection, suite_scope(registry, connection, testsuite) as suite:
        regressions = Regressions(suite)
        regression = regressions.resolve(connection, uuid)
        removed = regressions.remove_indicators(connection, regression, body.indicator_uuids)
        return IndicatorsRemoved(
            removed=removed, indicators=regressions.indicators(connection, regression)
        )


# The metric is resolved first, so an undeclared one is a 400 even if the body also names an absent
# machine or test -- the same order `POST /query` takes, which the spec leaves open.
@router.post(
    "/indicators/query",
    dependencies=[require_scope(Scope.READ)],
    summary="Look up indicators across regressions",
    responses=suite_responses(not_found=_NO_FILTERED_ENTITY),
)
def query_indicators(
    testsuite: SuiteName,
    body: Annotated[IndicatorQuery, Body(openapi_examples=_QUERY_EXAMPLES)],
    engine: EngineDep,
    registry: RegistryDep,
) -> CursorPage[RegressionIndicator]:
    """Search the indicators of all regressions in the suite, one page at a time. For example, to
    find out which of a set of machines, tests and metrics are already part of a regression.

    This is a POST only because the lists can be too long for a URL; it doesn't change anything.
    """
    with engine.connect() as connection, suite_scope(registry, connection, testsuite) as suite:
        regressions = Regressions(suite)
        conditions: list[ColumnElement[bool]] = []
        if body.metric is not None:
            declared_entry(suite.schema, Metric, body.metric)
            conditions.append(regressions.names_metric(body.metric))
        if body.machine is not None:
            machines = machine_ids(connection, suite, body.machine)
            conditions.append(regressions.on_machines(machines.values()))
        if body.test is not None:
            tests = test_ids(connection, suite, body.test)
            conditions.append(regressions.for_tests(tests.values()))
        if body.state is not None:
            conditions.append(regressions.in_states(body.state))
        if body.commit is not None:
            conditions.append(regressions.attributed_to(body.commit))
        return cursor_page(
            connection,
            regressions.lookup().where(*conditions),
            regressions.lookup_keyset(),
            body.limit,
            body.cursor,
            regressions.read_lookup,
        )

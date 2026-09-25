"""Regressions: the triage records an external detector keeps (endpoints.md, Regressions).

D8 settles what this is: v5 detects nothing on its own, so every regression and every indicator
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

from collections.abc import Sequence
from typing import Annotated, Any
from uuid import uuid4

from fastapi import APIRouter, Query, Response
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
    select,
    true,
    update,
)
from sqlalchemy.dialects.postgresql import insert as upsert

from lnt_v5.auth import require_scope
from lnt_v5.db import EngineDep
from lnt_v5.errors import ApiError, ErrorCode
from lnt_v5.querying import (
    DEFAULT_LIMIT,
    MAX_LIMIT,
    Cursor,
    Keyset,
    Limit,
    cursor_page,
    search_condition,
)
from lnt_v5.responses import CursorPage
from lnt_v5.routes.commits import commit_id
from lnt_v5.routes.machines import machine_id, machine_ids
from lnt_v5.routes.suites import SUITES_PATH
from lnt_v5.routes.tests import test_id, test_ids
from lnt_v5.scopes import Scope
from lnt_v5.suites.entities import (
    Storable,
    UuidPath,
    declared_by_name,
    declared_entry,
    identifier,
    location_of,
    undeclared,
)
from lnt_v5.suites.registry import RegistryDep, Suite
from lnt_v5.suites.schema import Metric
from lnt_v5.suites.scope import SUITE_NOT_FOUND, suite_responses, suite_scope
from lnt_v5.suites.states import RegressionStateName
from lnt_v5.suites.tables import NAME_LENGTH, REGRESSION_INDICATOR_CONSTRAINT

REGRESSIONS_PATH = f"{SUITES_PATH}/{{testsuite}}/regressions"
INDICATORS_PATH = f"{REGRESSIONS_PATH}/{{uuid}}/indicators"

router = APIRouter(prefix=REGRESSIONS_PATH, tags=["Regressions"])

# The largest batch of indicators one request may carry, which is R2's page ceiling for the same
# reason `POST /commits/resolve` takes it: a batch expands into one statement, and an unbounded one
# would expand into a statement with more bind parameters than the protocol carries.
MAX_INDICATORS = MAX_LIMIT

# Every operation here reaches the suite's own tables, so every one can answer both of the failures
# `suite_scope` produces; each widens the wording with the cases it adds of its own.
_NO_REGRESSION = f"{SUITE_NOT_FOUND} Or no regression in it has that UUID."
_NO_FILTERED_ENTITY = f"{SUITE_NOT_FOUND} Or the machine or test a filter names is not in it."
_NO_NAMED_ENTITY = f"{SUITE_NOT_FOUND} Or the commit, machine or test the body names is not in it."
_NO_INDICATOR_TARGET = f"{_NO_REGRESSION} Or a machine or test an indicator names is not in it."

Title = Annotated[
    str,
    StringConstraints(max_length=NAME_LENGTH),
    Storable,
    Field(
        description=(
            "A short human-readable summary. Null when the regression has none, which is an "
            "ordinary state rather than a gap: a detector that has nothing to say leaves it unset, "
            "and a client renders a placeholder."
        )
    ),
]

Bug = Annotated[
    str,
    StringConstraints(max_length=NAME_LENGTH),
    Storable,
    Field(description="A URL naming this regression in an external bug tracker."),
]

Notes = Annotated[
    str,
    Storable,
    Field(
        description=(
            "Investigation findings: A/B results, bisection notes, anything a triager wants to "
            "keep. Unbounded, which is why it appears in the detail response only."
        )
    ),
]

# The identity of an entity the request names but does not create. Deliberately unconstrained in
# length and shape: a value no machine, test or commit could possibly have still names none, which
# endpoints.md answers with a 404 rather than a 400. `Storable` is the one exception, because a NUL
# cannot even be compared against a stored value -- PostgreSQL refuses it as a parameter (D3).
Named = Annotated[str, Storable]


class Indicator(BaseModel):
    """One (machine, test, metric) combination a regression affects (D5).

    R4's reference rule throughout: each part is the other entity's identifier under a key named
    after it, rather than a nested object. `metric` is a name the suite's schema declares rather
    than an entity of its own, and is stored as the name.
    """

    uuid: str = Field(description="Identifies the indicator. Always server-generated.")
    machine: str = Field(description="The name of the machine this indicator names.")
    test: str = Field(description="The name of the test this indicator names.")
    metric: str = Field(description="The name of the metric this indicator names.")


class IndicatorObject(BaseModel):
    """One indicator as a request names it: by name, everywhere.

    The machine and the test must already exist -- nothing here creates either -- so a name that
    is not there is a 404. The metric must be declared by the suite's schema, which R3 makes a 400
    instead: a metric is a column the schema declares rather than a row the suite holds.
    """

    model_config = ConfigDict(extra="forbid")

    machine: Named = Field(description="The name of an existing machine.")
    test: Named = Field(description="The name of an existing test.")
    metric: Named = Field(description="A metric name this test suite's schema declares.")


class _Regression(BaseModel):
    """What the list item and the detail body both carry.

    Not published on its own: the two bodies genuinely differ -- the list has the counts, the detail
    has `notes` and the indicators -- so neither is the other plus a key, and this exists so that
    the five keys they do share are described once.
    """

    uuid: str = Field(description="Identifies the regression. Always server-generated.")
    title: Title | None
    bug: Bug | None
    state: RegressionStateName = Field(description="Where this regression stands in triage.")
    commit: str | None = Field(
        description=(
            "The identity string of the commit suspected of introducing the regression, or null "
            "if none has been identified."
        )
    )


class Regression(_Regression):
    """A regression as the list carries it (endpoints.md, Regressions).

    The two counts describe the regression rather than the request: they count the distinct
    machines and tests across *every* indicator it has, whatever `machine=` or `test=` narrowed the
    list down to.
    """

    machine_count: int = Field(
        description="How many distinct machines this regression's indicators name."
    )
    test_count: int = Field(
        description="How many distinct tests this regression's indicators name."
    )


class RegressionDetail(_Regression):
    """A regression as the detail, create and update responses carry it."""

    notes: Notes | None
    indicators: list[Indicator] = Field(
        description=(
            "Every (machine, test, metric) this regression affects. An empty list is a legal "
            "state: deleting a machine takes its indicators with it and leaves the regression (D5)."
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
            "Where this regression stands in triage. Omitted, `POST` defaults to 'detected' and "
            "`PATCH` leaves the current state."
        ),
    )
    commit: Named | None = Field(
        default=None,
        description=(
            "The value of an existing commit, suspected of introducing the regression. 404 if no "
            "commit has that value."
        ),
    )


class RegressionCreate(_RegressionBody):
    """The body of `POST /api/suites/{testsuite}/regressions`. Every key is optional.

    A regression with nothing but a state is legal, and is what a triager opens before it knows
    what it is looking at.
    """

    indicators: list[IndicatorObject] = Field(
        default_factory=list,
        max_length=MAX_INDICATORS,
        description=(
            "The (machine, test, metric) combinations this regression affects: at most "
            f"{MAX_INDICATORS}, as on the add route. Duplicates within the list are stored once."
        ),
    )


class RegressionUpdate(_RegressionBody):
    """What `PATCH` may change. A key the request omits is left unchanged.

    Indicators are deliberately absent: they are managed through the two routes below, which are
    batch operations with counts of their own rather than a whole-list replacement. Sending one
    here is a 400, rather than a key that could not take effect being silently dropped.
    """


class IndicatorAddition(BaseModel):
    """The body of `POST /api/suites/{testsuite}/regressions/{uuid}/indicators`."""

    model_config = ConfigDict(extra="forbid")

    indicators: list[IndicatorObject] = Field(
        min_length=1,
        max_length=MAX_INDICATORS,
        description=(
            f"The indicators to add: at least one, at most {MAX_INDICATORS}. One this regression "
            "already has is silently ignored, as is a duplicate within the list."
        ),
    )


class IndicatorRemoval(BaseModel):
    """The body of `DELETE /api/suites/{testsuite}/regressions/{uuid}/indicators`."""

    model_config = ConfigDict(extra="forbid")

    indicator_uuids: list[UuidPath] = Field(
        min_length=1,
        max_length=MAX_INDICATORS,
        description=(
            f"The UUIDs of the indicators to remove: at least one, at most {MAX_INDICATORS}. "
            "Matched case-insensitively, as a UUID in a path segment is. A UUID naming no "
            "indicator on this regression is ignored, so a retried removal is not an error."
        ),
    )


class IndicatorsAdded(BaseModel):
    """What adding indicators answers: how many were created, and the full list afterwards."""

    added: int = Field(description="How many of the submitted indicators did not already exist.")
    indicators: list[Indicator] = Field(
        description="Every indicator this regression has now, added ones included."
    )


class IndicatorsRemoved(BaseModel):
    """What removing indicators answers, mirroring the addition above."""

    removed: int = Field(description="How many of the submitted UUIDs named an indicator here.")
    indicators: list[Indicator] = Field(description="Every indicator this regression still has.")


class Regressions:
    """The queries every regression response is built from, and how to read their rows back.

    Held together rather than written per endpoint so that the list and the detail cannot drift
    apart on the columns they name or the way they read one -- the same arrangement as `Machines`,
    `Commits` and `Runs`.

    The internal `id` rides along with the rest. It is never rendered -- R1 keeps auto-increment ids
    out of the API entirely -- but it is the unique tiebreaker D10 requires under the cursor, and
    this list takes no `sort`, so it is the whole of the order.
    """

    def __init__(self, suite: Suite) -> None:
        self.suite = suite
        self.schema = suite.schema
        self.table: Table = suite.tables.regression
        self._indicator: Table = suite.tables.regression_indicator
        self._commit: Table = suite.tables.commit
        self._machine: Table = suite.tables.machine
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

    def keyset(self) -> Keyset:
        """D10's ordering: arbitrary but deterministic, which for this list is the internal id."""
        return Keyset(tiebreaker=self.table.c.id)

    def search(self, term: str) -> ColumnElement[bool]:
        """D9's `?search=` for regressions: the title, and nothing else."""
        return search_condition(term, self.table, ["title"])

    def commit_is(self, value: str) -> ColumnElement[bool]:
        """R3's `commit=`, over the outer join `select` already makes.

        A value no commit has matches nothing rather than being an error, which is the asymmetry
        R3 draws between this filter and `machine=`.
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
            conditions.append(self._indicator.c.metric == metric)
        return select(1).select_from(self._indicator).where(*conditions).exists()

    def _common(self, row: Row[Any]) -> dict[str, Any]:
        return {
            "uuid": row._mapping[self.table.c.uuid],
            "title": row._mapping[self.table.c.title],
            "bug": row._mapping[self.table.c.bug],
            "state": RegressionStateName.of(row._mapping[self.table.c.state]),
            "commit": row._mapping[self._commit.c.commit],
        }

    def read(self, row: Row[Any]) -> Regression:
        return Regression(
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
        return RegressionDetail(
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
            select(
                self._indicator.c.uuid,
                self._machine.c.name,
                self._test.c.name,
                self._indicator.c.metric,
            )
            .select_from(
                self._indicator.join(
                    self._machine, self._machine.c.id == self._indicator.c.machine_id
                ).join(self._test, self._test.c.id == self._indicator.c.test_id)
            )
            .where(self._indicator.c.regression_id == regression)
            .order_by(self._indicator.c.id)
        ).all()
        # By column object rather than by name: the row spans three tables and two of them have a
        # `name`.
        return [
            Indicator(
                uuid=row._mapping[self._indicator.c.uuid],
                machine=row._mapping[self._machine.c.name],
                test=row._mapping[self._test.c.name],
                metric=row._mapping[self._indicator.c.metric],
            )
            for row in rows
        ]

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
        """The rows a batch of submitted indicators stands for, deduplicated (endpoints.md).

        The metrics go first, because they are checked against the schema already in memory: a
        batch naming a metric the suite does not declare is R3's 400 without a statement having
        run, and that ordering is also what makes the 400 beat the 404 when a batch gets both
        wrong -- the same precedence the list's filters take.

        Every machine and every test is then resolved in one statement each rather than one per
        indicator, which is what keeps a batch of a thousand from costing two thousand round trips.

        Duplicates within the batch are collapsed here, before the insert: D5's unique constraint
        would ignore them anyway, but only after they had been counted as added.
        """
        # The declared list is turned into a lookup once rather than once per metric, which is what
        # `declared_entry` would do -- the batch may name thousands.
        declared = declared_by_name(self.schema, Metric)
        for metric in {one.metric for one in submitted}:
            if metric not in declared:
                raise undeclared(metric, Metric, declared)

        machines = machine_ids(connection, self.suite, [one.machine for one in submitted])
        tests = test_ids(connection, self.suite, [one.test for one in submitted])
        rows = dict.fromkeys(
            (machines[one.machine], tests[one.test], one.metric) for one in submitted
        )
        return [
            {"machine_id": machine, "test_id": test, "metric": metric}
            for machine, test, metric in rows
        ]

    def add_indicators(
        self, connection: Connection, regression: int, resolved: Sequence[dict[str, Any]]
    ) -> int:
        """Store a resolved batch, ignoring what this regression already has, and say how many.

        `ON CONFLICT DO NOTHING` against D5's unique constraint rather than a read-then-write:
        endpoints.md asks for a duplicate to be silently ignored, and the constraint is what makes
        that true under two triagers adding the same indicator at once.

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
        return len(
            connection.execute(
                statement.on_conflict_do_nothing(
                    constraint=REGRESSION_INDICATOR_CONSTRAINT
                ).returning(self._indicator.c.id)
            ).all()
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


def _requested_states(requested: str) -> list[int]:
    """R3's `?state=active,detected`, as the integers D5 stores, or the 400 for an unknown name.

    A comma-separated list because R3 spells this one filter that way; the framework's own list
    handling would spell it `?state=active&state=detected` instead.
    """
    states = []
    for name in requested.split(","):
        try:
            states.append(RegressionStateName(name).stored)
        except ValueError as error:
            raise ApiError(
                ErrorCode.INVALID_REQUEST,
                f"'{name}' is not a regression state; expected a comma-separated list of: "
                f"{', '.join(RegressionStateName)}",
            ) from error
    return states


@router.get(
    "",
    dependencies=[require_scope(Scope.READ)],
    summary="List regressions",
    responses=suite_responses(not_found=_NO_FILTERED_ENTITY),
)
def list_regressions(
    testsuite: str,
    engine: EngineDep,
    registry: RegistryDep,
    search: Annotated[
        str | None,
        Query(description="Case-insensitive substring match against the regression's title."),
    ] = None,
    state: Annotated[
        str | None,
        Query(
            description=(
                "Keep only regressions in one of these states: a comma-separated list, such as "
                "`active,detected`. Omit for every state."
            )
        ),
    ] = None,
    machine: Annotated[
        str | None,
        Query(
            description=(
                "Keep only regressions with an indicator naming this machine. 404 if there is no "
                "such machine."
            )
        ),
    ] = None,
    test: Annotated[
        str | None,
        Query(
            description=(
                "Keep only regressions with an indicator naming this test. 404 if there is no "
                "such test."
            )
        ),
    ] = None,
    metric: Annotated[
        str | None,
        Query(
            description=(
                "Keep only regressions with an indicator naming this metric. 400 if the suite "
                "declares no such metric."
            )
        ),
    ] = None,
    commit: Annotated[
        str | None,
        Query(
            description=(
                "Keep only regressions attributed to this commit. A value no commit has matches "
                "nothing, rather than being an error."
            )
        ),
    ] = None,
    has_commit: Annotated[
        bool | None,
        Query(
            description=(
                "Keep only regressions that name a commit, or only those that name none. Omit for "
                "both."
            )
        ),
    ] = None,
    limit: Limit = DEFAULT_LIMIT,
    cursor: Cursor = None,
) -> CursorPage[Regression]:
    """Every regression in the suite, filtered and cursor-paginated (R2, R3, D9, D10).

    R3's three answers to a filter naming something absent are all visible here: an unknown
    `machine=` or `test=` is a 404, an unknown `metric=` is a 400 -- it names a column the schema
    declares rather than a row the suite holds -- and an unknown `commit=` is an empty page, because
    a commit no regression was ever attributed to is an ordinary answer.

    `machine=`, `test=` and `metric=` given together describe one indicator rather than three
    independent ones, which is what a caller combining them is asking.
    """
    with engine.connect() as connection, suite_scope(registry, connection, testsuite) as suite:
        regressions = Regressions(suite)
        conditions: list[ColumnElement[bool]] = []
        if search is not None:
            conditions.append(regressions.search(search))
        if state is not None:
            conditions.append(regressions.table.c.state.in_(_requested_states(state)))
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
            regressions.keyset(),
            limit,
            cursor,
            regressions.read,
        )


@router.post(
    "",
    status_code=201,
    dependencies=[require_scope(Scope.TRIAGE)],
    summary="Create a regression",
    responses=suite_responses(not_found=_NO_NAMED_ENTITY),
)
def create_regression(
    testsuite: str,
    body: RegressionCreate,
    engine: EngineDep,
    registry: RegistryDep,
    response: Response,
) -> RegressionDetail:
    """Open a regression, with as much or as little as the detector knows (D8).

    Every key is optional: a regression with no title, no commit and no indicators is legal, and
    `PATCH` and the indicator routes fill it in as triage proceeds.
    """
    with engine.begin() as connection, suite_scope(registry, connection, testsuite) as suite:
        regressions = Regressions(suite)
        commit = None if body.commit is None else commit_id(connection, suite, body.commit)
        resolved = regressions.resolved_indicators(connection, body.indicators)

        uuid = str(uuid4())
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
    testsuite: str, uuid: UuidPath, engine: EngineDep, registry: RegistryDep
) -> RegressionDetail:
    """One regression, with its indicators embedded."""
    with engine.connect() as connection, suite_scope(registry, connection, testsuite) as suite:
        return Regressions(suite).detail(connection, uuid)


@router.patch(
    "/{uuid}",
    dependencies=[require_scope(Scope.TRIAGE)],
    summary="Update a regression",
    responses=suite_responses(not_found=f"{_NO_REGRESSION} Or no commit in it has that value."),
)
def update_regression(
    testsuite: str,
    uuid: UuidPath,
    body: RegressionUpdate,
    engine: EngineDep,
    registry: RegistryDep,
) -> RegressionDetail:
    """Retitle, re-state, attach a bug, record notes, or move the suspected commit.

    A key the request omits is left unchanged and an explicit null clears it, except `state`, which
    a regression always has. Transitions are unconstrained: any state may be set to any other.
    """
    with engine.begin() as connection, suite_scope(registry, connection, testsuite) as suite:
        regressions = Regressions(suite)
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

        # A request that changes nothing is still a 404 for a regression that is not there, which
        # `detail` answers on its own -- an UPDATE with no values would match no rows either way.
        if values:
            changed = connection.execute(
                update(regressions.table).where(regressions.table.c.uuid == uuid).values(**values)
            )
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
    testsuite: str, uuid: UuidPath, engine: EngineDep, registry: RegistryDep
) -> None:
    """Delete a regression and its indicators (D5).

    One statement: D5 gives `{suite}.regression_indicator.regression_id` an `ON DELETE CASCADE`.
    The machines, tests and commit it named are references and are left alone.
    """
    with engine.begin() as connection, suite_scope(registry, connection, testsuite) as suite:
        regressions = Regressions(suite)
        removed = connection.execute(
            delete(regressions.table).where(regressions.table.c.uuid == uuid)
        )
        if removed.rowcount == 0:
            raise regressions.missing(uuid)


@router.post(
    "/{uuid}/indicators",
    dependencies=[require_scope(Scope.TRIAGE)],
    summary="Add indicators to a regression",
    responses=suite_responses(not_found=_NO_INDICATOR_TARGET),
)
def add_indicators(
    testsuite: str,
    uuid: UuidPath,
    body: IndicatorAddition,
    engine: EngineDep,
    registry: RegistryDep,
) -> IndicatorsAdded:
    """Add one or more indicators, ignoring those the regression already has.

    200 rather than 201, because a batch whose indicators all already exist creates nothing and
    there is no one resource to point a `Location` at. `added` counts what this request actually
    created, and `indicators` is the whole list afterwards -- which is what a client rendering the
    indicator table needs, and saves it a second request.
    """
    with engine.begin() as connection, suite_scope(registry, connection, testsuite) as suite:
        regressions = Regressions(suite)
        regression = regressions.resolve(connection, uuid)
        resolved = regressions.resolved_indicators(connection, body.indicators)
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
    testsuite: str,
    uuid: UuidPath,
    body: IndicatorRemoval,
    engine: EngineDep,
    registry: RegistryDep,
) -> IndicatorsRemoved:
    """Remove indicators by UUID, ignoring any that are not on this regression.

    A UUID naming nothing here is not a 404, so a client that retries a removal after a dropped
    response gets `removed: 0` rather than an error. A regression left with no indicators is kept:
    an empty indicator set is a legal state (D5).
    """
    with engine.begin() as connection, suite_scope(registry, connection, testsuite) as suite:
        regressions = Regressions(suite)
        regression = regressions.resolve(connection, uuid)
        removed = regressions.remove_indicators(connection, regression, body.indicator_uuids)
        return IndicatorsRemoved(
            removed=removed, indicators=regressions.indicators(connection, regression)
        )

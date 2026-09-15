"""Tests: the named things a run measures (endpoints.md, Tests).

Read-only, and the shortest entity in the API: a test is a name and nothing else. What is worth
attention here is the two filters, both of which ask a question about samples rather than about
tests -- "which tests have data on this machine", "which tests have a value for this metric" --
and so are `EXISTS` subqueries over `{suite}.sample` rather than joins that would multiply rows.

A test name is also the one natural key R1 keeps out of every path, so a request that names one
carries it in a query parameter. `test_id` below is what resolves it, here rather than in
`routes/samples.py` because it is the test entity's lookup rather than that endpoint's.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Annotated, Any

from fastapi import APIRouter, Query
from pydantic import BaseModel, Field
from sqlalchemy import ColumnElement, Connection, Row, Select, Table, select

from lnt_v5.auth import require_scope
from lnt_v5.db import EngineDep
from lnt_v5.errors import ApiError, ErrorCode
from lnt_v5.querying import DEFAULT_LIMIT, Cursor, Keyset, Limit, cursor_page, search_condition
from lnt_v5.responses import CursorPage
from lnt_v5.routes.machines import NO_MACHINE_FILTERED, machine_id
from lnt_v5.routes.suites import SUITES_PATH
from lnt_v5.scopes import Scope
from lnt_v5.suites.entities import declared_entry, identifier, identifiers
from lnt_v5.suites.registry import RegistryDep, Suite
from lnt_v5.suites.schema import Metric
from lnt_v5.suites.scope import suite_responses, suite_scope

TESTS_PATH = f"{SUITES_PATH}/{{testsuite}}/tests"

router = APIRouter(prefix=TESTS_PATH, tags=["Tests"])


class Test(BaseModel):
    """A test as the list carries it.

    An object around a single key rather than a bare string, which is what endpoints.md asks for:
    the list can gain a key later without every client having to be changed at once.
    """

    name: str = Field(description="Identifies the test within its test suite.")


class Tests:
    """The query the test list is built from, and how to read one of its rows back.

    Holds the internal `id` for the same reason `Commits` does: it is never rendered, but it is the
    unique tiebreaker D10 requires under the cursor, and this list takes no `sort`, so it is the
    whole of the order.
    """

    def __init__(self, suite: Suite) -> None:
        self.table: Table = suite.tables.test
        self._sample: Table = suite.tables.sample
        self._run: Table = suite.tables.run

    def select(self) -> Select[Any]:
        return select(self.table.c.id, self.table.c.name)

    def keyset(self) -> Keyset:
        """D10's ordering: arbitrary but deterministic, which for this list is the internal id."""
        return Keyset(tiebreaker=self.table.c.id)

    def search(self, term: str) -> ColumnElement[bool]:
        return search_condition(term, self.table, ["name"])

    def has_sample(self, machine: int | None, metric: Metric | None) -> ColumnElement[bool]:
        """Whether this test has a sample -- on that machine, carrying that metric, if asked.

        One predicate for both filters rather than two independent ones, the same choice
        `Commits.has_run` makes: `?machine=m&metric=execution_time` asks which tests have an
        `execution_time` value *on that machine*, which is what a caller combining them means.

        The `sample.test_id` equality leads, so D5's `(test_id, run_id)` index -- the one it keeps
        for exactly this direction -- serves the probe, and the join to `run` is by primary key.
        """
        source = (
            self._sample.join(self._run, self._run.c.id == self._sample.c.run_id)
            if machine is not None
            else self._sample
        )
        conditions: list[ColumnElement[bool]] = [self._sample.c.test_id == self.table.c.id]
        if machine is not None:
            conditions.append(self._run.c.machine_id == machine)
        if metric is not None:
            # No index covers "this metric is not null", so this half is a heap read per candidate
            # sample; the `test_id` probe above is what keeps the set of candidates small.
            conditions.append(self._sample.c[metric.name].is_not(None))
        return select(1).select_from(source).where(*conditions).exists()

    def read(self, row: Row[Any]) -> Test:
        return Test(name=row._mapping[self.table.c.name])


def _missing(testsuite: str, name: str) -> ApiError:
    """The 404 for a test no suite holds, shared by every request that names one."""
    return ApiError(ErrorCode.NOT_FOUND, f"No test named '{name}' in test suite '{testsuite}'")


def test_id(connection: Connection, suite: Suite, name: str) -> int:
    """The id of the test a `test=` filter names, or R3's 404 for one that is not there.

    R3 makes an unknown `test=` an error, exactly as an unknown `machine=` is, so this is
    `machines.machine_id`'s counterpart and lives here for the same reason: every endpoint offering
    the filter owes the same lookup and the same wording.
    """
    test = suite.tables.test
    return identifier(
        connection, test.c.name, name, lambda missed: _missing(suite.schema.name, missed)
    )


def test_ids(connection: Connection, suite: Suite, names: Sequence[str]) -> dict[str, int]:
    """The ids of many tests at once, keyed by name, or the 404 for the first one absent.

    `machines.machine_ids`' counterpart, and there for the same caller: a regression's indicators
    each name a test, and resolving them one at a time would be a statement per indicator.
    """
    test = suite.tables.test
    return identifiers(
        connection, test.c.name, names, lambda missed: _missing(suite.schema.name, missed)
    )


@router.get(
    "",
    dependencies=[require_scope(Scope.READ)],
    summary="List tests",
    responses=suite_responses(not_found=NO_MACHINE_FILTERED),
)
def list_tests(
    testsuite: str,
    engine: EngineDep,
    registry: RegistryDep,
    search: Annotated[
        str | None,
        Query(description="Case-insensitive substring match against the test's name."),
    ] = None,
    machine: Annotated[
        str | None,
        Query(
            description=(
                "Keep only tests with data on this machine. 404 if there is no such machine."
            )
        ),
    ] = None,
    metric: Annotated[
        str | None,
        Query(
            description=(
                "Keep only tests with a value for this metric. Combined with `machine=`, only "
                "values measured on that machine count. 400 if the suite declares no such metric."
            )
        ),
    ] = None,
    limit: Limit = DEFAULT_LIMIT,
    cursor: Cursor = None,
) -> CursorPage[Test]:
    """Every test in the suite, filtered and cursor-paginated (R2, R3, D9, D10)."""
    with engine.connect() as connection, suite_scope(registry, connection, testsuite) as suite:
        tests = Tests(suite)
        conditions: list[ColumnElement[bool]] = []
        if search is not None:
            conditions.append(tests.search(search))
        if machine is not None or metric is not None:
            conditions.append(
                tests.has_sample(
                    None if machine is None else machine_id(connection, suite, machine),
                    None if metric is None else declared_entry(suite.schema, Metric, metric),
                )
            )

        return cursor_page(
            connection,
            tests.select().where(*conditions),
            tests.keyset(),
            limit,
            cursor,
            tests.read,
        )

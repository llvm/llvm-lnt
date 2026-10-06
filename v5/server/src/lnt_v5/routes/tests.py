"""Tests: the named things a run measures (E5).

Read-only, and the shortest entity in the API: a test is a name and nothing else. What is worth
attention here is the two filters, both of which ask a question about samples rather than about
tests -- "which tests have data on this machine", "which tests have a value for this metric". They
are answered from `{suite}.test_coverage` rather than from `{suite}.sample`, which cannot answer the
second cheaply: proving that a test has no value for a metric would cost a read of all its samples.
That table only accumulates, so a test stays in both filters after the runs that put it there are
deleted, until its machine is (D5).

A test name is also the one natural key I1 keeps out of every path, so a request that names one
carries it in a query parameter. `test_id` below is what resolves it, here rather than in
`routes/samples.py` because it is the test entity's lookup rather than that endpoint's.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Annotated, Any

from fastapi import APIRouter, Query
from pydantic import BaseModel, Field
from sqlalchemy import ColumnElement, Connection, Row, Select, Table, select

from lnt_v5 import examples
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
from lnt_v5.suites.scope import SuiteName, suite_responses, suite_scope

TESTS_PATH = f"{SUITES_PATH}/{{testsuite}}/tests"

router = APIRouter(prefix=TESTS_PATH, tags=["Tests"])


# An object around a single key rather than a bare string, which is what endpoints.md asks for: the
# object can gain a key later without every client having to be changed at once.
#
# The docstring is published, as the description I8's document gives this schema, so it is written
# for API users.
class Test(BaseModel):
    """A test: a benchmark the suite has results for."""

    name: str = Field(
        description="The test's name, unique within its test suite.",
        examples=[examples.TEST],
    )


class Tests:
    """The query the test list is built from, and how to read one of its rows back.

    Holds the internal `id` for the same reason `Commits` does: it is never rendered, but it is the
    unique tiebreaker O5 requires under the cursor, and this list takes no `sort`, so it is the
    whole of the order.
    """

    def __init__(self, suite: Suite) -> None:
        self.table: Table = suite.tables.test
        self._coverage: Table = suite.tables.test_coverage

    def select(self) -> Select[Any]:
        return select(self.table.c.id, self.table.c.name)

    def keyset(self) -> Keyset:
        """O5's ordering: arbitrary but deterministic, which for this list is the internal id."""
        return Keyset(tiebreaker=self.table.c.id)

    def search(self, term: str) -> ColumnElement[bool]:
        return search_condition(term, self.table, ["name"])

    def has_sample(self, machine: int | None, metric: Metric | None) -> ColumnElement[bool]:
        """Whether this test has a sample -- on that machine, carrying that metric, if asked.

        One predicate for both filters rather than two independent ones, the same choice
        `Commits.has_run` makes: `?machine=m&metric=execution_time` asks which tests have an
        `execution_time` value *on that machine*, which is what a caller combining them means. On
        `{suite}.test_coverage` that is one row, and its existence alone answers `machine=`, since a
        row is there exactly when the machine has had samples of the test (D5).
        """
        conditions: list[ColumnElement[bool]] = [self._coverage.c.test_id == self.table.c.id]
        if machine is not None:
            conditions.append(self._coverage.c.machine_id == machine)
        if metric is not None:
            conditions.append(self._coverage.c[metric.name].is_(True))
        return select(1).select_from(self._coverage).where(*conditions).exists()

    def read(self, row: Row[Any]) -> Test:
        return Test.model_construct(name=row._mapping[self.table.c.name])


def _missing(testsuite: str, name: str) -> ApiError:
    """The 404 for a test no suite holds, shared by every request that names one."""
    return ApiError(ErrorCode.NOT_FOUND, f"No test named '{name}' in test suite '{testsuite}'")


def test_id(connection: Connection, suite: Suite, name: str) -> int:
    """The id of the test a `test=` filter names, or I3's 404 for one that is not there.

    I3 makes an unknown `test=` an error, exactly as an unknown `machine=` is, so this is
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
    testsuite: SuiteName,
    engine: EngineDep,
    registry: RegistryDep,
    cursor: Cursor = None,
    search: Annotated[
        str | None,
        Query(description="Only return tests whose name contains this text. Not case-sensitive."),
    ] = None,
    machine: Annotated[
        str | None,
        Query(
            description=(
                "Only return tests that have results on this machine. Returns 404 if the machine "
                "doesn't exist."
            )
        ),
    ] = None,
    metric: Annotated[
        str | None,
        Query(
            description=(
                "Only return tests that have values for this metric (on `machine`, if given). "
                "Returns 400 if the suite's schema doesn't define the metric."
            )
        ),
    ] = None,
    limit: Limit = DEFAULT_LIMIT,
) -> CursorPage[Test]:
    """The tests in the suite, one page at a time. Tests are created as runs are submitted.

    The `machine` and `metric` filters look at every result ever submitted: a test still matches
    after the runs that matched are deleted, but not after the machine is deleted.
    """
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

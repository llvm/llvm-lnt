"""Samples: the measured values one run produced (endpoints.md, Samples).

Read-only, and reached only through the run that holds them -- a sample has no identifier of its
own, because nothing about it is addressable: a test measured several times in one run yields
several identical-looking objects, and D6 makes those repetitions indistinguishable by design.

Two things here follow from the design docs rather than from convenience.

`metrics` carries only the metrics that have a value. That is R4's one stated exception to the rule
that a declared dict carries every declared key, and the reason is the shape of the data: a suite
declares a long metric list that any given test populates sparsely, so a full dict would be mostly
nulls repeated on every row of a page.

A test is named by `?test=` rather than by a path segment, because R1 keeps a test name out of every
path. Folding it into this list rather than giving it a route of its own also keeps one pagination
contract for a run's samples: a caller asking for one test gets its handful of repetitions in a
single page.
"""

from __future__ import annotations

from typing import Annotated, Any

from fastapi import APIRouter, Query
from pydantic import BaseModel, Field
from sqlalchemy import ColumnElement, Row, Select, Table, select

from lnt_v5.auth import require_scope
from lnt_v5.db import EngineDep
from lnt_v5.querying import DEFAULT_LIMIT, Cursor, Keyset, Limit, SortKey, cursor_page
from lnt_v5.responses import CursorPage
from lnt_v5.routes.runs import NO_RUN, RUNS_PATH, run_id
from lnt_v5.routes.tests import test_id
from lnt_v5.scopes import Scope
from lnt_v5.suites.entities import DeclaredValue, UuidPath
from lnt_v5.suites.registry import RegistryDep, Suite
from lnt_v5.suites.scope import suite_responses, suite_scope

SAMPLES_PATH = f"{RUNS_PATH}/{{uuid}}/samples"

router = APIRouter(prefix=RUNS_PATH, tags=["Samples"])

_NOT_FOUND = f"{NO_RUN} Or the suite has no test of the name `test=` gives."


class Sample(BaseModel):
    """One measurement of one test within one run (R4)."""

    test: str = Field(description="The name of the test this sample measured.")
    metrics: dict[str, DeclaredValue] = Field(
        description=(
            "The metrics this sample has a value for, keyed by metric name and typed per the "
            "suite's schema. Unlike a `fields` dict, it carries only the metrics that have a "
            "value: a suite's metric list is long and any one test populates little of it."
        )
    )


class Samples:
    """The query the sample list is built from, and how to read one of its rows back."""

    def __init__(self, suite: Suite) -> None:
        self.table: Table = suite.tables.sample
        self._test: Table = suite.tables.test
        # Resolved once rather than per row: this is the list with the most rows in the API -- a
        # page may carry 10 000 of them -- and looking each metric's column up by name out of the
        # table's collection would be that many times the suite's metric count.
        self._metrics = [
            (metric.name, self.table.c[metric.name]) for metric in suite.schema.metrics
        ]

    def select(self) -> Select[Any]:
        return select(
            self.table.c.id,
            self.table.c.test_id,
            self._test.c.name,
            *(column for _, column in self._metrics),
        ).select_from(self.table.join(self._test, self._test.c.id == self.table.c.test_id))

    def keyset(self) -> Keyset:
        """D10's ordering: arbitrary but deterministic, and chosen so an index can produce it.

        `test_id` before the `id` tiebreaker rather than `id` alone, and that is about cost rather
        than about what a caller sees. Every query here fixes `run_id`, so D5's `(run_id, test_id)`
        index already yields the rows in this order and PostgreSQL has only the repetitions of a
        single test left to sort. Ordering by `id` alone would leave it sorting every sample in the
        run, on every page -- a run holds tens of thousands of them, and paging would be quadratic.

        Deliberately not ordered by test *name*: that is what a reader wants to see, but no index
        offers it, and the client sorts the table it renders anyway.
        """
        return Keyset(SortKey(self.table.c.test_id), tiebreaker=self.table.c.id)

    def read(self, row: Row[Any]) -> Sample:
        # By column object rather than by name, the convention everywhere a declared name reaches a
        # row: the row spans two tables, and `Row._mapping` keyed by a column cannot pick the
        # wrong one of a pair that happen to share a name.
        metrics = {
            name: value
            for name, column in self._metrics
            if (value := row._mapping[column]) is not None
        }
        return Sample(test=row._mapping[self._test.c.name], metrics=metrics)


@router.get(
    "/{uuid}/samples",
    dependencies=[require_scope(Scope.READ)],
    summary="List a run's samples",
    responses=suite_responses(not_found=_NOT_FOUND),
)
def list_samples(
    testsuite: str,
    uuid: UuidPath,
    engine: EngineDep,
    registry: RegistryDep,
    test: Annotated[
        str | None,
        Query(
            description=(
                "Keep only the samples for this test. 404 if the suite has no test of that name; "
                "a test this run did not measure is an empty page, not an error."
            )
        ),
    ] = None,
    limit: Limit = DEFAULT_LIMIT,
    cursor: Cursor = None,
) -> CursorPage[Sample]:
    """Every sample one run produced, optionally narrowed to one test (R2, R3, D10).

    The run is resolved to its id rather than read whole: this query filters on `run_id`, and the
    404 for an unknown UUID has to come from somewhere regardless.
    """
    with engine.connect() as connection, suite_scope(registry, connection, testsuite) as suite:
        samples = Samples(suite)
        conditions: list[ColumnElement[bool]] = [
            samples.table.c.run_id == run_id(connection, suite, uuid)
        ]
        if test is not None:
            conditions.append(samples.table.c.test_id == test_id(connection, suite, test))

        return cursor_page(
            connection,
            samples.select().where(*conditions),
            samples.keyset(),
            limit,
            cursor,
            samples.read,
        )

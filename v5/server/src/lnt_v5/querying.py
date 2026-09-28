"""R3's shared list conventions: how a page is asked for, ordered and searched.

The parameters themselves rather than any one endpoint's set of them. What a given endpoint filters
and sorts on is its own -- and is declared there, so that R8's document enumerates it and an
unknown value is a 400 before the endpoint runs.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Annotated, Any

from fastapi import Query
from sqlalchemy import ColumnElement, Table, or_

from lnt_v5.suites.schema import CommitField, MachineField

# R2's page size: 25 by default, never more than 10 000, and never zero -- an endpoint has no reason
# to serve a page of nothing, and `total` is available from any page.
DEFAULT_LIMIT = 25
MAX_LIMIT = 10_000

Limit = Annotated[
    int,
    Query(ge=1, le=MAX_LIMIT, description="How many items to return, at most."),
]

Offset = Annotated[int, Query(ge=0, description="How many matching items to skip.")]

# R3 spells a descending sort by prefixing the field name.
DESCENDING = "-"


def sort_order(sort: str) -> tuple[str, bool]:
    """R3's `sort=<field>`, split into the field and whether it is descending."""
    return (sort.removeprefix(DESCENDING), True) if sort.startswith(DESCENDING) else (sort, False)


def search_condition(
    term: str,
    table: Table,
    identity: Sequence[str],
    entries: Sequence[CommitField | MachineField] = (),
) -> ColumnElement[bool]:
    """D9's `?search=`: a case-insensitive substring match with OR semantics.

    One function for all five of D9's cases, because they differ only in which columns they cover:
    an entity's own always-searched columns (`identity` -- a machine's `name`, a commit's `commit`
    and `tag`, a test's `name`, a regression's `title`) plus every declared entry marked
    `searchable`. Stating that rule once is what keeps the machine list and the run list, which D9
    requires to share a predicate, from drifting apart.

    `autoescape` is doing real work: without it the `%` and `_` in the caller's term would be LIKE
    wildcards, so a search for `100%` would match every row and one for `a_b` would match `axb`.
    """
    columns: list[ColumnElement[Any]] = [table.c[name] for name in identity]
    columns += [table.c[entry.name] for entry in entries if entry.searchable]
    return or_(*(column.icontains(term, autoescape=True) for column in columns))

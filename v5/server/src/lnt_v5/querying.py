"""R3's shared list conventions: how a page is asked for, ordered and searched.

The parameters themselves rather than any one endpoint's set of them. What a given endpoint filters
and sorts on is its own -- and is declared there, so that R8's document enumerates it and an
unknown value is a 400 before the endpoint runs.

Cursor pagination (R2, D10) lives here too, as `Keyset` and `cursor_page`. It is deliberately not
private to any endpoint family: the commit, run, test and sample lists, `POST /query` and
`GET /machines/{name}/runs` all page this way, and a second implementation of a keyset predicate
would be a second chance to get the boundary conditions wrong.
"""

from __future__ import annotations

import base64
import hashlib
import json
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from datetime import datetime
from typing import Annotated, Any

from fastapi import Depends, Query, Request
from pydantic import BaseModel, Field
from sqlalchemy import (
    Column,
    ColumnElement,
    Connection,
    Integer,
    Row,
    Select,
    Table,
    UnaryExpression,
    literal,
    or_,
    tuple_,
)

from lnt_v5.errors import ApiError, ErrorCode
from lnt_v5.responses import CursorPage
from lnt_v5.strings import storable
from lnt_v5.suites.schema import CommitField, MachineField
from lnt_v5.suites.tables import INT32_MAX, INT32_MIN

# R2's page size: 25 by default, never more than 10 000, and never zero -- an endpoint has no reason
# to serve a page of nothing, and `total` is available from any page.
DEFAULT_LIMIT = 25
MAX_LIMIT = 10_000

# The wording of R2's two paging parameters, stated once because they travel by two carriers: as
# query parameters on the GET lists, and as keys of the request body on `POST /query`, which is
# asked for with a body because its filters do not fit a query string. R2 is explicit that nothing
# else about the contract differs between the two.
_LIMIT = "How many items to return, at most."
_CURSOR = (
    "Continue the list where a previous page ended: pass back the `cursor.next` that page "
    "returned, with the same filters and sort. Cursors are opaque -- they must not be parsed, "
    "constructed or stored, and one issued for a different list, different filters or a different "
    "sort order is rejected. `limit` may change between pages."
)

Limit = Annotated[int, Query(ge=1, le=MAX_LIMIT, description=_LIMIT)]

Offset = Annotated[int, Query(ge=0, description="How many matching items to skip.")]

# The query parameters a client may change between pages without changing the list it is paging:
# the cursor itself, and the page size.
_PAGING_PARAMETERS = frozenset({"cursor", "limit"})


@dataclass(frozen=True)
class RequestCursor:
    """A `cursor=` as a request passed it, and the list that request asks for.

    `scope` is the request's path and every query parameter apart from `cursor` and `limit`, in a
    canonical order. A cursor is only accepted with the scope it was issued under (see `Keyset`), so
    a cursor from `?search=foo` is refused by `?search=bar` rather than answered with the `bar` rows
    past the position it names -- a page that would silently skip every earlier one. Derived from
    the request rather than listed by each endpoint, so that no list can forget one of its filters,
    and the path is in it because it can carry one too: `GET /machines/{name}/runs` pages one table
    for every machine. A list whose filters travel in a body instead (`POST /query`) builds one with
    `body_cursor`.
    """

    token: str | None
    scope: str = ""


def _request_cursor(
    request: Request,
    cursor: Annotated[
        str | None,
        Query(description=_CURSOR),
    ] = None,
) -> RequestCursor:
    parameters = sorted(
        (key, value)
        for key, value in request.query_params.multi_items()
        if key not in _PAGING_PARAMETERS
    )
    return RequestCursor(cursor, json.dumps([request.url.path, parameters], separators=(",", ":")))


Cursor = Annotated[RequestCursor, Depends(_request_cursor)]


def body_cursor(request: Request, body: BaseModel) -> RequestCursor:
    """The `RequestCursor` of a list asked for with a request body, whose `cursor` is a key of it.

    The scope is the path and every key of the body apart from the paging ones, as the body reads
    once validated rather than as it was spelled: omitting a key and sending its default ask for the
    same list, and so do two spellings of one instant. A list keeps its order as sent -- whether two
    orders select the same rows is the endpoint's business, not something to guess at here.
    """
    filters = body.model_dump(mode="json")
    token = filters.pop("cursor")
    for key in _PAGING_PARAMETERS:
        filters.pop(key, None)
    scope = json.dumps([request.url.path, filters], sort_keys=True, separators=(",", ":"))
    return RequestCursor(token, scope)


# The same two, as fields of a request body rather than as query parameters.
BodyLimit = Annotated[int, Field(ge=1, le=MAX_LIMIT, description=_LIMIT)]

BodyCursor = Annotated[str | None, Field(description=_CURSOR)]

# R3 spells a descending sort by prefixing the field name.
DESCENDING = "-"


def sort_order(sort: str) -> tuple[str, bool]:
    """R3's `sort=<field>`, split into the field and whether it is descending."""
    return (sort.removeprefix(DESCENDING), True) if sort.startswith(DESCENDING) else (sort, False)


def exclusive_range(
    column: ColumnElement[Any], after: Any, before: Any
) -> list[ColumnElement[bool]]:
    """A range over one ordered column, strictly after and strictly before, either bound optional.

    R3 makes every range filter in the API exclusive at both ends, whichever column it bounds: the
    run lists' `after=`/`before=` over `submitted_at`, and `POST /query`'s two pairs over the commit
    ordinal and the submission time. One spelling, so that a bound cannot become inclusive in one
    place and stay exclusive in another.
    """
    conditions: list[ColumnElement[bool]] = []
    if after is not None:
        conditions.append(column > after)
    if before is not None:
        conditions.append(column < before)
    return conditions


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


# --------------------------------------------------------------------------------------------
# Cursor pagination (R2, D10)
# --------------------------------------------------------------------------------------------


@dataclass(frozen=True)
class SortKey:
    """One term of a list's ordering: a column, and whether it runs backwards."""

    column: Column[Any]
    descending: bool = False

    def ordered(self) -> UnaryExpression[Any]:
        return self.column.desc() if self.descending else self.column.asc()


class Keyset:
    """A total row order, and the opaque cursor that resumes it (R2, D10).

    D10's rule: cursor pagination needs a deterministic, non-repeating row ordering, so the
    caller's sort specification is followed by an internal unique tiebreaker. Without one, two rows
    sharing a sort value have no fixed relative position, and a page boundary falling between them
    would drop one and repeat the other on the next page.

    The cursor names a *position in the ordering* -- the key values of the last row served -- and
    not the row itself. That is what keeps a resumption correct when the page's last row is deleted
    before the next request arrives: an implementation that stored the row's id and re-read its
    sort values would have nothing left to read. Rows inserted before that position are missed and
    rows inserted after it are served, which is what forward-only pagination means. A row in the
    list throughout is served exactly once unless its sort values change mid-traversal, which can
    move it back ahead of the cursor (D10).

    The cursor is opaque by contract (R2): base64 over a compact JSON payload, carrying a
    fingerprint of the ordering and the request scope it was issued for (`RequestCursor`). The
    fingerprint is what turns feeding a `sort=ordinal` cursor to `sort=-ordinal`, a commit cursor
    to the run list, or a `search=foo` cursor to `search=bar`, into a 400 instead of a
    plausible-looking page of the wrong rows. It is deliberately not signed: forging one buys a
    caller nothing it could not ask for with ordinary filters, and a signing key would have to be
    shared across workers and survive restarts.
    """

    def __init__(self, *keys: SortKey, tiebreaker: Column[Any]) -> None:
        # The tiebreaker takes the direction of the last key it breaks ties for. Its own direction
        # is unobservable -- it only orders rows the caller's sort leaves equal -- and having every
        # term agree is what lets `after` be a row comparison, which is the whole difference
        # between a bounded index scan and a scan of every row already paged past.
        descending = keys[-1].descending if keys else False
        if any(key.descending != descending for key in keys):
            raise ValueError("every sort key of a keyset must run in the same direction")
        self._keys = (*keys, SortKey(tiebreaker, descending))
        self._descending = descending
        self._ordering = _ordering(self._keys)
        # Resolved up front, so that a key column of a type no cursor can carry is a failure before
        # any SQL runs rather than a 500 handed to whichever caller first passes a cursor.
        self._readers = [_reader(key.column) for key in self._keys]

    def order(self) -> list[UnaryExpression[Any]]:
        """The ORDER BY this keyset imposes, caller's terms first and the tiebreaker last."""
        return [key.ordered() for key in self._keys]

    def defined(self) -> list[ColumnElement[bool]]:
        """What a row must satisfy to have a position in this order at all.

        A null sort value compares as unknown against a cursor's, so a row carrying one would fall
        on neither side of the boundary and vanish from every page after the first. D10 answers
        this by excluding those rows outright -- which is also what endpoints.md asks for by name,
        where `sort=ordinal` excludes the commits that have none. Derived from the columns rather
        than left to each endpoint, so the four lists that page this way cannot each forget it.
        """
        return [key.column.is_not(None) for key in self._keys if key.column.nullable]

    def after(self, cursor: str, scope: str) -> ColumnElement[bool]:
        """The rows that come strictly after the position a cursor names.

        A row comparison -- `(ordinal, id) > (50, 100)` -- rather than the equivalent OR of AND
        chains, because PostgreSQL derives an index condition from the former and nothing at all
        from the latter. With the OR spelling, reaching page N costs a scan of everything on pages
        1..N-1, so walking a list is quadratic in its length. Row comparison requires every term to
        run in the same direction, which `__init__` guarantees.
        """
        values = self._decode(cursor, scope)
        row = tuple_(*(key.column for key in self._keys))
        position = tuple_(
            *(
                literal(value, key.column.type)
                for key, value in zip(self._keys, values, strict=True)
            )
        )
        comparison: ColumnElement[bool] = row < position if self._descending else row > position
        return comparison

    def cursor(self, row: Row[Any], scope: str) -> str:
        """The cursor that resumes after this row. Its key columns must be in the SELECT."""
        values = [_wire(row._mapping[key.column]) for key in self._keys]
        payload = json.dumps([self._fingerprint(scope), values], separators=(",", ":"))
        return base64.urlsafe_b64encode(payload.encode()).decode().rstrip("=")

    def _fingerprint(self, scope: str) -> str:
        """A short digest of the ordering and the request scope, so that a cursor cannot be replayed
        against a different one of either."""
        return hashlib.sha256(f"{self._ordering}\n{scope}".encode()).hexdigest()[:12]

    def _decode(self, cursor: str, scope: str) -> list[Any]:
        try:
            padded = cursor + "=" * (-len(cursor) % 4)
            fingerprint, values = json.loads(base64.urlsafe_b64decode(padded))
            if fingerprint != self._fingerprint(scope) or len(values) != len(self._keys):
                raise ValueError("not a cursor for this list")
            return [reader(value) for reader, value in zip(self._readers, values, strict=True)]
        # `binascii.Error` is a `ValueError`. `RecursionError` is what `json.loads` raises for a
        # payload nested deeper than it recurses, which only a hand-made cursor can be.
        except (ValueError, TypeError, RecursionError) as error:
            raise ApiError(
                ErrorCode.INVALID_REQUEST,
                "This cursor was not issued for this list, filters and sort order. Pass back the "
                "'cursor.next' from a page of this same request, unmodified.",
            ) from error


def cursor_page[T](
    connection: Connection,
    statement: Select[Any],
    keyset: Keyset,
    limit: int,
    cursor: RequestCursor,
    read: Callable[[Row[Any]], T],
) -> CursorPage[T]:
    """One page of `statement` in `keyset`'s order, in R2's envelope.

    The envelope rather than the rows and a cursor, because the two are never useful apart: every
    caller pairs this with `CursorPage.of`, and a caller that forgot to would be returning a page
    with no way to ask for the next one. `read` turns a row into whatever the endpoint renders,
    which is the only part that differs between them.

    One row beyond the page is fetched and discarded, so that `next` is null exactly when the
    caller has reached the end -- rather than handing back a cursor that leads to an empty page and
    making every client pay for one extra request to discover that.
    """
    statement = statement.where(*keyset.defined())
    if cursor.token is not None:
        statement = statement.where(keyset.after(cursor.token, cursor.scope))
    rows = connection.execute(statement.order_by(*keyset.order()).limit(limit + 1)).all()
    page = rows[:limit]
    return CursorPage.of(
        [read(row) for row in page],
        keyset.cursor(page[-1], cursor.scope) if len(rows) > limit else None,
    )


def _ordering(keys: Sequence[SortKey]) -> str:
    """The ordering, spelled out for `Keyset._fingerprint`.

    Built from each column's qualified name, which carries the suite's namespace, so a cursor from
    one suite's commit list is not accepted by another's.
    """
    return "|".join(
        f"{key.column.table.fullname}.{key.column.name}:{'desc' if key.descending else 'asc'}"
        for key in keys
    )


def _wire(value: Any) -> Any:
    """A key value as the cursor's JSON carries it. Only a timestamp needs a representation."""
    return value.isoformat() if isinstance(value, datetime) else value


def _integer(value: Any) -> int:
    # `bool` is a subclass of `int`, and JSON's `true` would otherwise silently become 1.
    if not isinstance(value, int) or isinstance(value, bool):
        raise ValueError("expected an integer")
    # `after` binds a cursor's value as its column's type, so one outside INTEGER's range -- which
    # only a hand-made cursor can carry -- would fail in the database, a 500 where R2 wants a 400.
    # INTEGER is the only integer type a sort key may have (`_reader`); tables.py owns its range.
    if not INT32_MIN <= value <= INT32_MAX:
        raise ValueError("out of range for an INTEGER column")
    return value


def _real(value: Any) -> float:
    if not isinstance(value, int | float) or isinstance(value, bool):
        raise ValueError("expected a number")
    # JSON's integers are unbounded, and one past a float's range raises `OverflowError` here,
    # which would otherwise escape `Keyset._decode` as a 500.
    try:
        return float(value)
    except OverflowError:
        raise ValueError("out of range for a floating-point column") from None


def _text(value: Any) -> str:
    if not isinstance(value, str):
        raise ValueError("expected a string")
    # A cursor is opaque to clients but need not be unforgeable (R2), so what comes out of one is
    # caller-supplied: D5's rule applies to it like any other string, and without this a hand-made
    # cursor carrying a NUL would reach a text sort key as a bind parameter and be a 500.
    return storable(value)


def _timestamp(value: Any) -> datetime:
    return datetime.fromisoformat(_text(value))


# Keyed by the Python type the column's SQL type maps to, so that a new column type used as a sort
# key fails loudly here rather than comparing a string against a timestamp in the database.
_READERS: dict[type, Callable[[Any], Any]] = {
    int: _integer,
    float: _real,
    str: _text,
    datetime: _timestamp,
}


def _reader(column: Column[Any]) -> Callable[[Any], Any]:
    """How this column's values are read back out of a cursor.

    JSON does not distinguish a timestamp from the string holding it, and the cursor carries no
    types of its own, so the column is what says how each value is read back.
    """
    reader = _READERS.get(column.type.python_type)
    # `_integer` checks INTEGER's range, which BIGINT and SMALLINT do not share.
    if reader is None or (reader is _integer and type(column.type) is not Integer):
        raise TypeError(f"'{column}' is a {column.type} and cannot be a cursor's sort key")
    return reader

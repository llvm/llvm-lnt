"""I3's shared list conventions: how a page is asked for, ordered and searched.

The parameters themselves rather than any one endpoint's set of them. What a given endpoint filters
and sorts on is its own -- and is declared there, so that I8's document enumerates it and an
unknown value is a 400 before the endpoint runs. A parameter the endpoint does not declare at all is
a 400 too, refused by `reject_unknown_query_parameters`, which every scoped endpoint runs (I3).

Cursor pagination (I2, O5) lives here too, as `Keyset` and `cursor_page`. It is deliberately not
private to any endpoint family: the commit, run, test, sample and regression list endpoints and
`POST /query` all page this way, and a second implementation of a keyset predicate would be a second
chance to get the boundary conditions wrong.
"""

from __future__ import annotations

import base64
import hashlib
import json
from collections.abc import Callable, Iterable, Sequence
from dataclasses import dataclass
from datetime import datetime
from typing import Annotated, Any, Union, get_args, get_origin

from fastapi import Query, Request
from fastapi.dependencies.models import Dependant
from pydantic import Field, Strict
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

# I2's page size: 25 by default, never more than 10 000, and never zero -- an endpoint has no reason
# to serve a page of nothing.
DEFAULT_LIMIT = 25
MAX_LIMIT = 10_000

# The wording of I2's two paging parameters, stated once because they travel by two carriers: as
# query parameters on the GET lists, and as keys of the request body on `POST /query`, which is
# asked for with a body because its test list does not fit a query string. I2 is explicit that
# nothing else about the contract differs between the two. Published in I8's document, so written
# for API users.
_LIMIT = "The maximum number of results to return."
_CURSOR = (
    "To get the next page, set this to `cursor.next` from the previous response, and keep the "
    "other parameters the same (except `limit`). Omit it to get the first page. If it is rejected "
    "with `invalid_cursor`, start again from the first page."
)

Limit = Annotated[int, Query(ge=1, le=MAX_LIMIT, description=_LIMIT)]

# A cursor is scoped to the list that issued it by `cursor_page`, from the statement that list runs,
# so neither carrier needs to know which of the request's other parameters are filters.
Cursor = Annotated[str | None, Query(description=_CURSOR)]

# The same two, as fields of a request body rather than as query parameters. Strict, because a body
# is JSON and `true` or `"5"` is not a page size.
BodyLimit = Annotated[int, Strict(), Field(ge=1, le=MAX_LIMIT, description=_LIMIT)]

BodyCursor = Annotated[str | None, Field(description=_CURSOR)]

# What every time bound given as a query parameter tells a client about the timestamp it takes.
# Published in I8's document.
TIMESTAMP_HINT = (
    "An ISO 8601 timestamp, treated as UTC if it has no time zone. Encode a '+' in the time zone "
    "as `%2B`, otherwise it is read as a space."
)

# I3 spells a descending sort by prefixing the field name.
DESCENDING = "-"


def sort_order(sort: str) -> tuple[str, bool]:
    """I3's `sort=<name>`, split into the ordering's name and whether it is descending."""
    return (sort.removeprefix(DESCENDING), True) if sort.startswith(DESCENDING) else (sort, False)


def exclusive_range(
    column: ColumnElement[Any], after: Any, before: Any
) -> list[ColumnElement[bool]]:
    """A range over one ordered column, strictly after and strictly before, either bound optional.

    I3 makes every range filter in the API exclusive at both ends, whichever column it bounds: the
    run list's pairs over `submitted_at` and `measured_at`, the commit list's pair over the
    ordinal, and `POST /query`'s pairs over the commit ordinal and the two run timestamps. One
    spelling, so that a bound cannot become inclusive in one place and stay exclusive in another.
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
    """O4's `?search=` on one table: a case-insensitive substring match with OR semantics.

    One function for every substring match of O4, because they differ only in which columns they
    cover: an entity's own always-searched columns (`identity` -- a machine's `name`, a commit's
    `commit` and `tag`, a test's `name`, a regression's `title`) plus every declared entry marked
    `searchable`. A UUID is matched by prefix instead, with `uuid_prefix`.

    `autoescape` is doing real work: without it the `%` and `_` in the caller's term would be LIKE
    wildcards, so a search for `100%` would match every row and one for `a_b` would match `axb`.
    """
    columns: list[ColumnElement[Any]] = [table.c[name] for name in identity]
    columns += [table.c[entry.name] for entry in entries if entry.searchable]
    return or_(*(column.icontains(term, autoescape=True) for column in columns))


def uuid_prefix(column: Column[Any], term: str) -> ColumnElement[bool]:
    """O4's match on a UUID: whether it starts with `term`, ignoring case.

    UUIDs are stored in lowercase (O1), so lowercasing the term is all it takes to ignore case.
    """
    return column.startswith(term.lower(), autoescape=True)


def reject_unknown_query_parameters(request: Request) -> None:
    """I3: a query parameter the endpoint does not take, or one repeated that takes one value: 400.

    Both would otherwise be dropped silently -- FastAPI ignores an undeclared parameter and keeps
    the last value of a repeated one -- so a misspelled `?machnie=linux` would widen a result and a
    repeated `?machine=a&machine=b` would narrow it, with nothing telling the caller either way.

    A dependency rather than something each endpoint calls, so that none can forget it: `auth.py`
    runs it as part of every scoped endpoint's scope check. What the endpoint takes is read off the
    route it matched, through its whole dependency tree. Each query parameter is declared on its
    own; one grouped into a Pydantic model would appear here as a single field, and would need this
    to look inside it.
    """
    # Each parameter the endpoint takes, by the name it is sent under, with its type.
    declared: dict[str, Any] = {}
    takes_body = False
    pending: list[Dependant] = [request.scope["route"].dependant]
    while pending:
        dependant = pending.pop()
        declared |= {field.alias: field.field_info.annotation for field in dependant.query_params}
        takes_body = takes_body or bool(dependant.body_params)
        pending.extend(dependant.dependencies)

    def quoted(names: Iterable[str]) -> str:
        return ", ".join(f"'{name}'" for name in sorted(names))

    query = request.query_params
    unknown = set(query) - declared.keys()
    if unknown:
        takes = (
            f"This endpoint takes: {quoted(declared)}."
            if declared
            else "This endpoint takes no query parameters."
        )
        # On an endpoint that takes a body, a stray parameter is most likely one of its keys sent in
        # the wrong place -- `limit` given to `POST /query` in the query string, say (I2).
        if takes_body:
            takes += " Its other inputs go in the request body."
        raise ApiError(
            ErrorCode.INVALID_REQUEST, f"Unknown query parameter(s): {quoted(unknown)}. {takes}"
        )

    # FastAPI reads every value of a parameter that takes several, and only the last of any other.
    repeated = [
        name
        for name, annotation in declared.items()
        if len(query.getlist(name)) > 1 and not _takes_several(annotation)
    ]
    if repeated:
        raise ApiError(
            ErrorCode.INVALID_REQUEST,
            f"Query parameter(s) {quoted(repeated)} take a single value, but were given several.",
        )


def _takes_several(annotation: Any) -> bool:
    """Whether a query parameter of this type takes several values.

    It has to agree with FastAPI, which reads every value of a parameter typed as a sequence or a
    set other than a string, and only the last of any other: a type this missed would have its
    repeated values refused, and one it wrongly included would be answered with only the last of
    them.

    Looks through `| None` and `Annotated`, the two wrappers a query parameter's type carries here.
    """
    origin = get_origin(annotation)
    if origin is Union:
        return any(_takes_several(argument) for argument in get_args(annotation))
    if origin is Annotated:
        return _takes_several(get_args(annotation)[0])
    collection = origin or annotation
    return (
        isinstance(collection, type)
        and issubclass(collection, (Sequence, set, frozenset))
        and not issubclass(collection, (str, bytes))
    )


# --------------------------------------------------------------------------------------------
# Cursor pagination (I2, O5)
# --------------------------------------------------------------------------------------------


@dataclass(frozen=True)
class SortKey:
    """One term of a list's ordering: a column, and whether it runs backwards."""

    column: Column[Any]
    descending: bool = False

    def ordered(self) -> UnaryExpression[Any]:
        return self.column.desc() if self.descending else self.column.asc()


class Keyset:
    """A total row order, and the opaque cursor that resumes it (I2, O5).

    O5's rule: cursor pagination needs a deterministic, non-repeating row ordering, so the
    caller's sort specification is followed by an internal unique tiebreaker. Without one, two rows
    sharing a sort value have no fixed relative position, and a page boundary falling between them
    would drop one and repeat the other on the next page. A tiebreaker may span several columns: all
    but its last are given as sort keys and the last as `tiebreaker`. The whole need only be unique
    among the rows the list's filters admit.

    A row with no value for a sort key has no position relative to a cursor, so it is either left
    out (`_defined`) or, with `nulls_last`, served after every row that has one (`statements`).

    The cursor names a *position in the ordering* -- the key values of the last row served -- and
    not the row itself. That is what keeps a resumption correct when the page's last row is deleted
    before the next request arrives: an implementation that stored the row's id and re-read its
    sort values would have nothing left to read. Rows inserted before that position are missed and
    rows inserted after it are served, which is what forward-only pagination means. A row that
    matches throughout is served exactly once unless its sort values change mid-traversal, which can
    move it back ahead of the cursor (O5).

    The cursor is opaque by contract (I2): base64 over a compact JSON payload, carrying a
    fingerprint of the list it was issued for, ordering included (see `cursor_page`). The
    fingerprint is what turns feeding a `sort=ordinal` cursor to `sort=-ordinal`, a commit cursor
    to the run list, or a `search=foo` cursor to `search=bar`, into a 400 instead of a
    plausible-looking page of the wrong rows. It is deliberately not signed: forging one buys a
    caller nothing it could not ask for with ordinary filters, and a signing key would have to be
    shared across workers and survive restarts.
    """

    def __init__(self, *keys: SortKey, tiebreaker: Column[Any], nulls_last: bool = False) -> None:
        # The tiebreaker takes the direction of the last key it breaks ties for: having every term
        # agree is what lets `after` be a row comparison, which is the whole difference between a
        # bounded index scan and a scan of every row already paged past. With no keys it is the
        # whole order, ascending. An endpoint that wants that order in a chosen direction sorts by
        # the tiebreaker itself, which is already total, so it is not appended again after itself.
        descending = keys[-1].descending if keys else False
        if any(key.descending != descending for key in keys):
            raise ValueError("every sort key of a keyset must run in the same direction")
        if keys and keys[-1].column is tiebreaker:
            self._keys = keys
        else:
            self._keys = (*keys, SortKey(tiebreaker, descending))
        self._descending = descending
        # `nulls_last` keeps the rows whose leading key is null, after all the others, ordered among
        # themselves by the remaining keys. Only the leading key may be null, so that the rows
        # carrying a null still have a total order of their own to page through.
        if nulls_last and (
            len(self._keys) < 2
            or not self._keys[0].column.nullable
            or any(key.column.nullable for key in self._keys[1:])
        ):
            raise ValueError(
                "nulls_last needs a nullable leading key, followed by keys that are never null"
            )
        self._nulls_last = nulls_last
        # Resolved up front, so that a key column of a type no cursor can carry is a failure before
        # any SQL runs rather than a 500 handed to whichever caller first passes a cursor. A null
        # is read back only where `nulls_last` makes it a position.
        self._readers = [_reader(key.column) for key in self._keys]
        if nulls_last:
            self._readers[0] = _or_null(self._readers[0])

    def _defined(self) -> list[ColumnElement[bool]]:
        """What a row must satisfy to have a position in this order at all.

        A null sort value compares as unknown against a cursor's, so a row carrying one would fall
        on neither side of the boundary and vanish from every page after the first. Unless the
        keyset serves them last (`nulls_last`), O5 answers this by excluding those rows outright --
        as `POST /query` does for unordered commits under `sort=commit`. Derived from the columns
        rather than left to each endpoint, so the lists that page this way cannot each forget it.
        """
        return [key.column.is_not(None) for key in self._keys if key.column.nullable]

    def statements(
        self, statement: Select[Any], position: Sequence[Any] | None
    ) -> list[Select[Any]]:
        """The statements that serve a page from `position` on, in order, each in this order.

        One, unless the keyset is `nulls_last`: a row comparison cannot carry a null, so the rows
        with a null leading key are read by a statement of their own, ordered by the remaining keys,
        after those with a value. Two statements in sequence rather than one UNION, whose combined
        ORDER BY PostgreSQL cannot derive from its branches': it would read the second group in full
        on every page, where `cursor_page` only reaches it once the first cannot fill the page.
        """
        if not self._nulls_last:
            return [self._part(statement, self._keys, self._defined(), position)]
        lead, *rest = self._keys
        if position is not None and position[0] is None:
            return [self._part(statement, rest, [lead.column.is_(None)], position[1:])]
        return [
            self._part(statement, self._keys, [lead.column.is_not(None)], position),
            self._part(statement, rest, [lead.column.is_(None)], None),
        ]

    def _part(
        self,
        statement: Select[Any],
        keys: Sequence[SortKey],
        conditions: list[ColumnElement[bool]],
        position: Sequence[Any] | None,
    ) -> Select[Any]:
        """`statement`'s rows meeting `conditions`, after `position` if given, ordered by `keys`."""
        if position is not None:
            conditions = [*conditions, self._after(keys, position)]
        return statement.where(*conditions).order_by(*(key.ordered() for key in keys))

    def position(self, cursor: str, scope: str) -> list[Any]:
        """The key values a cursor names, refused (`invalid_cursor`) unless issued for `scope`."""
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
                ErrorCode.INVALID_CURSOR,
                "This cursor was not issued for these path parameters, filters and sort order, or "
                "is no longer valid. Pass back the 'cursor.next' from a page of this same request, "
                "unmodified, or start again from the first page.",
            ) from error

    def _after(self, keys: Sequence[SortKey], values: Sequence[Any]) -> ColumnElement[bool]:
        """The rows that come strictly after `values` on `keys`.

        A row comparison -- `(ordinal, id) > (50, 100)` -- rather than the equivalent OR of AND
        chains, because PostgreSQL derives an index condition from the former and nothing at all
        from the latter. With the OR spelling, reaching page N costs a scan of everything on pages
        1..N-1, so walking a list is quadratic in its length. Row comparison requires every term to
        run in the same direction, which `__init__` guarantees.
        """
        row = tuple_(*(key.column for key in keys))
        position = tuple_(
            *(literal(value, key.column.type) for key, value in zip(keys, values, strict=True))
        )
        comparison: ColumnElement[bool] = row < position if self._descending else row > position
        return comparison

    def cursor(self, row: Row[Any], scope: str) -> str:
        """The cursor that resumes after this row. Its key columns must be in the SELECT."""
        values = [_wire(row._mapping[key.column]) for key in self._keys]
        payload = json.dumps([self._fingerprint(scope), values], separators=(",", ":"))
        return base64.urlsafe_b64encode(payload.encode()).decode().rstrip("=")

    def _fingerprint(self, scope: str) -> str:
        """A short digest of the scope, so that a cursor cannot be replayed against another list."""
        return hashlib.sha256(scope.encode()).hexdigest()[:12]


@dataclass(frozen=True)
class Resolved:
    """A list's filter, and an equivalent one that the list executes instead (see `cursor_page`)."""

    stands_for: ColumnElement[bool]
    executed: ColumnElement[bool]


def cursor_page[T](
    connection: Connection,
    statement: Select[Any],
    keyset: Keyset,
    limit: int,
    cursor: str | None,
    read: Callable[[Row[Any]], T],
    resolved: Resolved | None = None,
) -> CursorPage[T]:
    """One page of `statement` in `keyset`'s order, in I2's envelope.

    The envelope rather than the rows and a cursor, because the two are never useful apart: every
    caller pairs this with `CursorPage.of`, and a caller that forgot to would be returning a page
    with no way to ask for the next one. `read` turns a row into whatever the endpoint renders,
    which is the only part that differs between them.

    A cursor is only accepted by the statement it was issued for, so a cursor from `?search=foo` is
    refused by `?search=bar` rather than answered with the `bar` rows past the position it names --
    a page that would silently skip every earlier one. The scope is what the list executes, ordered
    and compiled with its parameters, rather than the request that built it: that is exactly what
    decides which rows the list holds and in what order, so no filter can be left out of it --
    whether it came from the query string, the path or a body -- and nothing else is in it, so
    another spelling of the same filter (`has_profiles=1` for `true`, a default spelled out, one
    instant in two time zones) does not invalidate a cursor. It names the suite's tables, so a
    cursor from one suite is not accepted by another's either. The flip side is that anything
    changing the statement -- a schema change to a column it selects or searches, an entity a
    filter names resolving to another id or ordinal, or a deploy that alters the query --
    invalidates the cursors already issued for it, as I2 allows.

    The exception is a `resolved` filter, executed with part of it looked up ahead of time, such
    as the ids of the rows a subquery matches. Those ids change whenever a matching row is added,
    which no filter of the request names, so the scope has the filter it stands for instead.

    One row beyond the page is fetched and discarded, so that `next` is null exactly when the
    caller has reached the end -- rather than handing back a cursor that leads to an empty page and
    making every client pay for one extra request to discover that.

    A keyset that reads its rows with several statements (`Keyset.statements`) runs the next only
    while the page, look-ahead row included, is not full. Each reads the database as of its own
    execution, so a row whose sort values change in between can be served twice or skipped: O5's
    caveat, within a single page.
    """
    scoped = statement
    if resolved is not None:
        scoped = statement.where(resolved.stands_for)
        statement = statement.where(resolved.executed)
    compiled = [
        part.compile(dialect=connection.dialect) for part in keyset.statements(scoped, None)
    ]
    scope = json.dumps(
        [[str(part), part.params] for part in compiled], default=str, separators=(",", ":")
    )
    position = None if cursor is None else keyset.position(cursor, scope)
    rows: list[Row[Any]] = []
    for part in keyset.statements(statement, position):
        rows += connection.execute(part.limit(limit + 1 - len(rows))).all()
        if len(rows) > limit:
            break
    page = rows[:limit]
    return CursorPage.of(
        [read(row) for row in page],
        keyset.cursor(page[-1], scope) if len(rows) > limit else None,
    )


def _wire(value: Any) -> Any:
    """A key value as the cursor's JSON carries it. Only a timestamp needs a representation."""
    return value.isoformat() if isinstance(value, datetime) else value


def _integer(value: Any) -> int:
    # `bool` is a subclass of `int`, and JSON's `true` would otherwise silently become 1.
    if not isinstance(value, int) or isinstance(value, bool):
        raise ValueError("expected an integer")
    # `after` binds a cursor's value as its column's type, so one outside INTEGER's range -- which
    # only a hand-made cursor can carry -- would fail in the database, a 500 where I2 wants a 400.
    # INTEGER is the only integer type a sort key may have (`_reader`); tables.py owns its range.
    if not INT32_MIN <= value <= INT32_MAX:
        raise ValueError("out of range for an INTEGER column")
    return value


def _real(value: Any) -> float:
    if not isinstance(value, int | float) or isinstance(value, bool):
        raise ValueError("expected a number")
    # JSON's integers are unbounded, and one past a float's range raises `OverflowError` here,
    # which would otherwise escape `Keyset.position` as a 500.
    try:
        return float(value)
    except OverflowError:
        raise ValueError("out of range for a floating-point column") from None


def _text(value: Any) -> str:
    if not isinstance(value, str):
        raise ValueError("expected a string")
    # A cursor is opaque to clients but need not be unforgeable (I2), so what comes out of one is
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


def _or_null(reader: Callable[[Any], Any]) -> Callable[[Any], Any]:
    """`reader`, also reading back a null: the position of a row whose key has no value."""
    return lambda value: None if value is None else reader(value)


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

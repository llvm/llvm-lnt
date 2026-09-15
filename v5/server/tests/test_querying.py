"""R3's shared list conventions, and R2's cursor pagination (`querying.py`).

The commit list is the first endpoint to page with a cursor, but the mechanism is shared -- the run,
test and time-series lists will all use it -- so it is covered here, against a table of its own,
rather than only through the endpoint that happens to reach it first. That table deliberately has a
*non-unique* sort column, which no suite table offers: D10's tiebreaker only does anything when two
rows share a sort value, and a test over unique values could not tell whether it was there at all.
It also has a nullable one, for the rows D10 excludes from an order they have no position in.
"""

from __future__ import annotations

import base64
from collections.abc import Callable, Iterator
from datetime import UTC, datetime
from typing import Any

import pytest
from sqlalchemy import (
    Column,
    DateTime,
    Engine,
    Identity,
    Integer,
    MetaData,
    Row,
    String,
    Table,
    insert,
)
from sqlalchemy import select as sql_select

from lnt_v5.errors import ApiError
from lnt_v5.querying import Keyset, SortKey, cursor_page

_metadata = MetaData()

# Three rows may share `at`, and two may share `label`: the tiebreaker is the only thing that makes
# the order total.
events = Table(
    "querying_events",
    _metadata,
    Column("id", Integer, Identity(), primary_key=True),
    Column("label", String(64), nullable=False),
    Column("at", DateTime(timezone=True), nullable=False),
    # Nullable on purpose: D10 excludes rows with no value for a sort key, and only a nullable
    # column can show that.
    Column("rank", Integer, nullable=True),
)


def at(day: int) -> datetime:
    return datetime(2026, 4, day, 12, 0, tzinfo=UTC)


# Before every row the fixture seeds, which is the only way to insert one *behind* a cursor: the
# tiebreaker is an identity column, so a later row always has a higher id.
EARLIER = datetime(2026, 3, 31, 12, 0, tzinfo=UTC)


@pytest.fixture
def rows(db_engine: Engine) -> Iterator[list[str]]:
    """Nine rows, three at each of three timestamps, inserted in a scrambled label order."""
    seeded = [
        ("e", at(1)),
        ("b", at(2)),
        ("i", at(3)),
        ("a", at(1)),
        ("f", at(2)),
        ("g", at(3)),
        ("c", at(1)),
        ("d", at(2)),
        ("h", at(3)),
    ]
    with db_engine.begin() as connection:
        _metadata.create_all(connection)
        connection.execute(insert(events), [{"label": label, "at": when} for label, when in seeded])
    yield [label for label, _ in seeded]
    with db_engine.begin() as connection:
        _metadata.drop_all(connection)


@pytest.fixture
def walk(db_engine: Engine) -> Callable[..., list[str]]:
    """Page through every row of a keyset, returning the labels seen in order."""

    def through(keyset: Keyset, limit: int, labels: list[str] | None = None) -> list[str]:
        statement = sql_select(events.c.id, events.c.label, events.c.at, events.c.rank)
        if labels is not None:
            statement = statement.where(events.c.label.in_(labels))
        seen: list[str] = []
        cursor: str | None = None
        for _ in range(100):
            with db_engine.connect() as connection:
                page = cursor_page(connection, statement, keyset, limit, cursor, _row)
            seen.extend(row.label for row in page.items)
            cursor = page.cursor.next
            if cursor is None:
                return seen
        raise AssertionError("pagination did not terminate")

    return through


def by_time(*, descending: bool = False) -> Keyset:
    return Keyset(SortKey(events.c.at, descending), tiebreaker=events.c.id)


def by_rank() -> Keyset:
    return Keyset(SortKey(events.c.rank), tiebreaker=events.c.id)


def _row(row: Row[Any]) -> Row[Any]:
    """`cursor_page`'s reader, when the test wants the rows themselves rather than a response."""
    return row


def one_page(
    engine: Engine, keyset: Keyset, limit: int, cursor: str | None = None
) -> tuple[list[Row[Any]], str | None]:
    with engine.connect() as connection:
        page = cursor_page(
            connection,
            sql_select(events.c.id, events.c.label, events.c.at, events.c.rank),
            keyset,
            limit,
            cursor,
            _row,
        )
    return page.items, page.cursor.next


@pytest.mark.usefixtures("rows")
class TestOrdering:
    def test_appends_an_internal_tiebreaker_to_the_callers_sort(self) -> None:
        # D10: the caller's sort specification plus one unique column, so that the row order is
        # deterministic and non-repeating.
        keyset = by_time()

        assert len(keyset.order()) == 2
        assert "id" in str(keyset.order()[-1])

    def test_the_tiebreaker_alone_is_a_complete_order(self, db_engine: Engine) -> None:
        keyset = Keyset(tiebreaker=events.c.id)

        page, _ = one_page(db_engine, keyset, 9)

        assert [row.label for row in page] == ["e", "b", "i", "a", "f", "g", "c", "d", "h"]

    def test_orders_rows_sharing_a_sort_value_by_the_tiebreaker(self, db_engine: Engine) -> None:
        # The three rows at day 1 were inserted as e, a, c, so insertion order -- the tiebreaker --
        # is what decides, not the label.
        page, _ = one_page(db_engine, by_time(), 3)

        assert [row.label for row in page] == ["e", "a", "c"]

    def test_excludes_rows_with_no_value_for_a_sort_key(self, db_engine: Engine) -> None:
        """D10: a row with no position in the order is left out rather than left to vanish.

        A null compares as unknown against a cursor's value, so such a row would be served on the
        first page and skipped by every page after it. The keyset derives the exclusion from the
        column rather than leaving each endpoint to remember it -- which is also exactly what
        endpoints.md asks of `sort=ordinal`, where the ordinal is the nullable key.
        """
        with db_engine.begin() as connection:
            connection.execute(events.update().where(events.c.label.in_(["a", "b"])).values(rank=1))
            connection.execute(events.update().where(events.c.label == "c").values(rank=2))

        page, _ = one_page(db_engine, by_rank(), 9)

        assert [row.label for row in page] == ["b", "a", "c"]

    def test_refuses_to_mix_directions(self) -> None:
        # The row comparison `after` emits requires every term to agree, so a keyset that could not
        # be expressed that way is refused at construction rather than silently mis-paged.
        with pytest.raises(ValueError, match="same direction"):
            Keyset(
                SortKey(events.c.at, descending=True),
                SortKey(events.c.rank),
                tiebreaker=events.c.id,
            )

    def test_the_tiebreaker_follows_a_descending_sort(self, db_engine: Engine) -> None:
        # Its direction is unobservable except here, where it decides the order within a tie. The
        # three rows at day 3 were inserted as i, g, h, so a descending tiebreaker reverses them.
        page, _ = one_page(db_engine, by_time(descending=True), 3)

        assert [row.label for row in page] == ["h", "g", "i"]


@pytest.mark.usefixtures("rows")
class TestPaging:
    @pytest.mark.parametrize("limit", [1, 2, 3, 4, 8, 9])
    def test_pages_cover_every_row_exactly_once_whatever_the_page_size(
        self, walk: Callable[..., list[str]], limit: int
    ) -> None:
        # The property that matters, checked against a page size that divides the row count and one
        # that does not: a boundary falling inside a group of tied rows must neither drop one nor
        # serve it twice.
        seen = walk(by_time(), limit)

        assert sorted(seen) == list("abcdefghi")

    def test_a_page_resumes_exactly_where_the_last_one_ended(
        self, walk: Callable[..., list[str]]
    ) -> None:
        assert walk(by_time(), 3) == walk(by_time(), 9)

    def test_a_full_last_page_reports_no_cursor(self, db_engine: Engine) -> None:
        # Nine rows in pages of three: the last page is full, and must still say it is the last
        # rather than hand back a cursor leading to an empty page.
        _, cursor = one_page(db_engine, by_time(), 9)

        assert cursor is None

    def test_carries_the_filters_the_statement_already_has(
        self, walk: Callable[..., list[str]]
    ) -> None:
        assert sorted(walk(by_time(), 2, labels=["a", "b", "c"])) == ["a", "b", "c"]

    def test_carries_a_nullable_key_s_exclusion_across_every_page(
        self, db_engine: Engine, walk: Callable[..., list[str]]
    ) -> None:
        # The exclusion belongs to the keyset, so a resumption carries it: the five rows with no
        # rank must be absent from the second page as well as the first.
        with db_engine.begin() as connection:
            for rank, label in enumerate("abcd", start=1):
                connection.execute(events.update().where(events.c.label == label).values(rank=rank))

        assert walk(by_rank(), 2) == ["a", "b", "c", "d"]


@pytest.mark.usefixtures("rows")
class TestConcurrentChange:
    def test_a_deleted_row_does_not_invalidate_the_cursor_it_issued(
        self, db_engine: Engine
    ) -> None:
        """The reason a cursor encodes a position rather than a row id.

        An implementation that stored the last row's id and re-read its sort values to resume would
        have nothing to read once that row is gone.
        """
        page, cursor = one_page(db_engine, by_time(), 3)
        assert cursor is not None
        with db_engine.begin() as connection:
            connection.execute(events.delete().where(events.c.label == page[-1].label))

        following, _ = one_page(db_engine, by_time(), 3, cursor)

        assert [row.label for row in following] == ["b", "f", "d"]

    def test_a_row_inserted_past_the_cursor_is_served(self, db_engine: Engine) -> None:
        _, cursor = one_page(db_engine, by_time(), 3)
        with db_engine.begin() as connection:
            connection.execute(insert(events).values(label="z", at=at(2)))

        following, _ = one_page(db_engine, by_time(), 4, cursor)

        assert [row.label for row in following] == ["b", "f", "d", "z"]

    def test_a_row_inserted_before_the_cursor_is_not_repeated(self, db_engine: Engine) -> None:
        # Forward-only pagination misses it rather than serving it twice; no row that existed
        # throughout is skipped or repeated.
        _, cursor = one_page(db_engine, by_time(), 3)
        with db_engine.begin() as connection:
            connection.execute(insert(events).values(label="z", at=EARLIER))

        following, _ = one_page(db_engine, by_time(), 9, cursor)

        assert [row.label for row in following] == ["b", "f", "d", "i", "g", "h"]


@pytest.mark.usefixtures("rows")
class TestCursorOpacity:
    def test_is_not_the_row_id_dressed_up(self, db_engine: Engine) -> None:
        """R2: a cursor is opaque, so it must not be a client-guessable encoding of one column.

        A cursor that was just the last row's id would pass every paging test above and let a
        client mint one for any row it liked -- and, worse, would be wrong the moment two rows
        shared a sort value.
        """
        page, cursor = one_page(db_engine, by_time(), 3)
        naive = base64.urlsafe_b64encode(str(page[-1].id).encode()).decode()

        assert cursor not in (str(page[-1].id), naive, naive.rstrip("="))

    def test_is_url_safe(self, db_engine: Engine) -> None:
        # It travels as a query parameter, so it must survive one without being escaped.
        _, cursor = one_page(db_engine, by_time(), 3)

        assert cursor is not None
        assert all(character.isalnum() or character in "-_" for character in cursor)

    @pytest.mark.parametrize(
        ("cursor", "reason"),
        [
            ("nonsense", "not base64 at all"),
            ("YWJj", "base64 over something that is not JSON"),
            ("", "empty"),
            ("W10=", "JSON, but not the pair a cursor carries"),
        ],
    )
    def test_refuses_a_cursor_it_did_not_issue(
        self, db_engine: Engine, cursor: str, reason: str
    ) -> None:
        with pytest.raises(ApiError) as failure:
            one_page(db_engine, by_time(), 3, cursor)

        assert failure.value.code.value == "invalid_request", reason

    def test_refuses_a_cursor_issued_for_the_other_direction(self, db_engine: Engine) -> None:
        # Decoding would succeed -- same columns, same types -- and the page would be silently
        # wrong, which is what the ordering fingerprint exists to prevent.
        _, cursor = one_page(db_engine, by_time(), 3)
        assert cursor is not None

        with pytest.raises(ApiError):
            one_page(db_engine, by_time(descending=True), 3, cursor)

    def test_refuses_a_cursor_issued_for_a_different_ordering(self, db_engine: Engine) -> None:
        _, cursor = one_page(db_engine, by_time(), 3)
        assert cursor is not None

        with pytest.raises(ApiError):
            one_page(db_engine, Keyset(tiebreaker=events.c.id), 3, cursor)

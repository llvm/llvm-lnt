"""I3's shared list conventions, and I2's cursor pagination (`querying.py`).

The mechanism is shared by every cursor-paginated list -- commits, runs, tests, samples, regressions
and the indicator lookup -- so it is covered here, against a table of its own, rather than only
through the endpoints that use it. That table deliberately has a *non-unique* sort column, which
no suite table offers: O5's tiebreaker only does anything when two rows share a sort value, and a
test over unique values could not tell whether it was there at all. It also has a nullable one, for
the rows O5 excludes from an order they have no position in, or serves after all the others.
"""

from __future__ import annotations

import base64
import json
from collections.abc import Callable, Iterator
from datetime import UTC, datetime
from typing import Any

import pytest
from sqlalchemy import (
    BigInteger,
    Column,
    ColumnElement,
    DateTime,
    Double,
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
    # Nullable on purpose: O5 excludes rows with no value for a sort key, and only a nullable
    # column can show that.
    Column("rank", Integer, nullable=True),
    # A second nullable key, for the orders that may have only one. Only the tests that sort by it
    # fill it.
    Column("score", Integer, nullable=True),
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
        statement = sql_select(events)
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


def order_by(keyset: Keyset) -> str:
    """The ORDER BY of the statement `keyset` serves a first page with."""
    (statement,) = keyset.statements(sql_select(events), None)
    return str(statement).split("ORDER BY ")[1]


def by_rank_nulls_last(*, descending: bool = False) -> Keyset:
    return Keyset(SortKey(events.c.rank, descending), tiebreaker=events.c.id, nulls_last=True)


def forged(cursor: str, *values: Any) -> str:
    """A cursor for the same ordering as `cursor`, carrying other key values.

    What a client that ignored I2's opacity could send. Cursors need not be unforgeable, so a forged
    one is ordinary input, and whatever it carries must be answered with a 400 rather than reach the
    database.
    """
    ordering, _ = json.loads(base64.urlsafe_b64decode(cursor + "=" * (-len(cursor) % 4)))
    payload = json.dumps([ordering, list(values)])
    return base64.urlsafe_b64encode(payload.encode()).decode().rstrip("=")


def _row(row: Row[Any]) -> Row[Any]:
    """`cursor_page`'s reader, when the test wants the rows themselves rather than a response."""
    return row


def one_page(
    engine: Engine,
    keyset: Keyset,
    limit: int,
    cursor: str | None = None,
    *conditions: ColumnElement[bool],
) -> tuple[list[Row[Any]], str | None]:
    with engine.connect() as connection:
        page = cursor_page(
            connection, sql_select(events).where(*conditions), keyset, limit, cursor, _row
        )
    return page.items, page.cursor.next


@pytest.mark.usefixtures("rows")
class TestOrdering:
    def test_appends_an_internal_tiebreaker_to_the_callers_sort(self) -> None:
        # O5: the caller's sort specification plus one unique column, so that the row order is
        # deterministic and non-repeating.
        keyset = by_time()

        assert order_by(keyset) == "querying_events.at ASC, querying_events.id ASC"

    def test_the_tiebreaker_alone_is_a_complete_order(self, db_engine: Engine) -> None:
        keyset = Keyset(tiebreaker=events.c.id)

        page, _ = one_page(db_engine, keyset, 9)

        assert [row.label for row in page] == ["e", "b", "i", "a", "f", "g", "c", "d", "h"]

    @pytest.mark.parametrize("descending", [False, True])
    def test_sorting_by_the_tiebreaker_itself_does_not_repeat_it(
        self, walk: Callable[..., list[str]], rows: list[str], descending: bool
    ) -> None:
        # How a list offers the tiebreaker's own order in either direction: the key is already
        # unique, so the order is that one term, and it pages like any other.
        keyset = Keyset(SortKey(events.c.id, descending), tiebreaker=events.c.id)

        assert order_by(keyset) == f"querying_events.id {'DESC' if descending else 'ASC'}"
        assert walk(keyset, 2) == (rows[::-1] if descending else rows)

    def test_orders_rows_sharing_a_sort_value_by_the_tiebreaker(self, db_engine: Engine) -> None:
        # The three rows at day 1 were inserted as e, a, c, so insertion order -- the tiebreaker --
        # is what decides, not the label.
        page, _ = one_page(db_engine, by_time(), 3)

        assert [row.label for row in page] == ["e", "a", "c"]

    def test_excludes_rows_with_no_value_for_a_sort_key(self, db_engine: Engine) -> None:
        """O5: a row with no position in the order is left out rather than left to vanish.

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


# The ranked rows of `TestNullsLast`, and the rest in insertion order, which is the tiebreaker's.
RANKED = ["a", "b", "c", "d"]
UNRANKED = ["e", "i", "f", "g", "h"]


class TestNullsLast:
    """A keyset that serves the rows with no value for its leading key after all the others.

    Which is how the commit list's `sort=ordinal` keeps the commits without an ordinal (E3): ordered
    among themselves by the remaining keys, in the same direction.
    """

    @pytest.fixture(autouse=True)
    def ranked(self, db_engine: Engine, rows: list[str]) -> None:
        with db_engine.begin() as connection:
            for rank, label in enumerate(RANKED, start=1):
                connection.execute(events.update().where(events.c.label == label).values(rank=rank))

    @pytest.mark.parametrize("limit", [1, 2, 3, 4, 5, 8, 9, 10])
    def test_serves_the_rows_without_a_value_last_whatever_the_page_size(
        self, walk: Callable[..., list[str]], limit: int
    ) -> None:
        # Page sizes putting a boundary just before, at and just after the last ranked row.
        assert walk(by_rank_nulls_last(), limit) == RANKED + UNRANKED

    @pytest.mark.parametrize("limit", [1, 4, 5, 9])
    def test_runs_both_groups_backwards_when_descending(
        self, walk: Callable[..., list[str]], limit: int
    ) -> None:
        # The ranked rows highest first, then the others, last inserted first.
        assert walk(by_rank_nulls_last(descending=True), limit) == RANKED[::-1] + UNRANKED[::-1]

    def test_a_page_ending_on_the_last_ranked_row_looks_ahead_into_the_others(
        self, db_engine: Engine
    ) -> None:
        # The ranked rows alone fill the page exactly, so only the first unranked one can say
        # whether there is a next page.
        page, cursor = one_page(db_engine, by_rank_nulls_last(), 4)
        assert [row.label for row in page] == RANKED
        assert cursor is not None

        following, last = one_page(db_engine, by_rank_nulls_last(), 9, cursor)

        assert [row.label for row in following] == UNRANKED
        assert last is None

    def test_resumes_inside_the_rows_without_a_value(self, db_engine: Engine) -> None:
        _, cursor = one_page(db_engine, by_rank_nulls_last(), 6)

        following, _ = one_page(db_engine, by_rank_nulls_last(), 9, cursor)

        assert [row.label for row in following] == UNRANKED[2:]

    @pytest.mark.parametrize("limit", [4, 6])
    def test_a_deleted_last_row_does_not_invalidate_the_cursor(
        self, db_engine: Engine, limit: int
    ) -> None:
        # The last ranked row, and a row among the others.
        page, cursor = one_page(db_engine, by_rank_nulls_last(), limit)
        with db_engine.begin() as connection:
            connection.execute(events.delete().where(events.c.label == page[-1].label))

        following, _ = one_page(db_engine, by_rank_nulls_last(), 9, cursor)

        assert [row.label for row in following] == (RANKED + UNRANKED)[limit:]

    def test_carries_the_filters_across_both_groups(self, walk: Callable[..., list[str]]) -> None:
        labels = ["a", "c", "e", "g"]

        assert walk(by_rank_nulls_last(), 1, labels=labels) == labels

    def test_a_row_given_a_value_behind_the_cursor_is_not_served(self, db_engine: Engine) -> None:
        # O5: a row whose sort values change mid-traversal may move behind the cursor. Here an
        # unranked row not yet served gains a rank once the walk has reached the unranked rows.
        _, cursor = one_page(db_engine, by_rank_nulls_last(), 5)
        with db_engine.begin() as connection:
            connection.execute(events.update().where(events.c.label == "g").values(rank=5))

        following, _ = one_page(db_engine, by_rank_nulls_last(), 9, cursor)

        assert [row.label for row in following] == ["i", "f", "h"]

    def test_refuses_a_cursor_issued_for_the_order_that_excludes_them(
        self, db_engine: Engine
    ) -> None:
        _, cursor = one_page(db_engine, by_rank(), 2)
        assert cursor is not None

        with pytest.raises(ApiError):
            one_page(db_engine, by_rank_nulls_last(), 2, cursor)

    @pytest.mark.parametrize(
        ("keyset", "values"),
        [
            (by_rank, [None, 1]),
            (by_rank_nulls_last, [1, None]),
        ],
        ids=["without-nulls-last", "on-the-tiebreaker"],
    )
    def test_refuses_a_null_anywhere_but_a_nulls_last_leading_key(
        self, db_engine: Engine, keyset: Callable[[], Keyset], values: list[Any]
    ) -> None:
        _, cursor = one_page(db_engine, keyset(), 2)
        assert cursor is not None

        with pytest.raises(ApiError) as failure:
            one_page(db_engine, keyset(), 2, forged(cursor, *values))

        assert failure.value.code.value == "invalid_cursor"

    @pytest.mark.parametrize(
        ("keys", "tiebreaker"),
        [
            ([SortKey(events.c.at)], events.c.id),
            ([SortKey(events.c.rank), SortKey(events.c.score)], events.c.id),
            ([], events.c.id),
            # Nothing would be left to order the rows whose rank is null.
            ([SortKey(events.c.rank)], events.c.rank),
        ],
        ids=[
            "leading-key-never-null",
            "another-nullable-key",
            "no-key-but-the-tiebreaker",
            "leading-key-is-the-tiebreaker",
        ],
    )
    def test_refuses_an_order_it_cannot_serve_the_nulls_of(
        self, keys: list[SortKey], tiebreaker: Column[Any]
    ) -> None:
        with pytest.raises(ValueError, match="nulls_last"):
            Keyset(*keys, tiebreaker=tiebreaker, nulls_last=True)


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
        """I2: a cursor is opaque, so it must not be a client-guessable encoding of one column.

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
            pytest.param(
                base64.urlsafe_b64encode(b"[" * 1_000_000).decode(),
                "JSON nested past what the parser recurses through",
                id="deeply-nested",
            ),
        ],
    )
    def test_refuses_a_cursor_it_did_not_issue(
        self, db_engine: Engine, cursor: str, reason: str
    ) -> None:
        with pytest.raises(ApiError) as failure:
            one_page(db_engine, by_time(), 3, cursor)

        assert failure.value.code.value == "invalid_cursor", reason

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

    def test_refuses_a_cursor_issued_for_different_filters(self, db_engine: Engine) -> None:
        # Same ordering, other filters: the page would hold only rows the new filters match, but
        # would silently skip every one before the position the cursor names.
        _, cursor = one_page(db_engine, by_time(), 3, None, events.c.label != "a")
        assert cursor is not None

        with pytest.raises(ApiError):
            one_page(db_engine, by_time(), 3, cursor, events.c.label != "b")
        with pytest.raises(ApiError):
            one_page(db_engine, by_time(), 3, cursor)

        assert len(one_page(db_engine, by_time(), 3, cursor, events.c.label != "a")[0]) == 3

    def test_refuses_a_timestamp_carrying_a_nul(self, db_engine: Engine) -> None:
        # D5 reaches what comes out of a cursor too, because a cursor need not be unforgeable (I2):
        # a hand-made one is a way to hand the database a string no column can hold.
        _, cursor = one_page(db_engine, by_time(), 3)
        assert cursor is not None

        with pytest.raises(ApiError) as failure:
            one_page(db_engine, by_time(), 3, forged(cursor, "2026-01-01\x00T00:00:00+00:00", 1))

        assert failure.value.code.value == "invalid_cursor"

    @pytest.mark.parametrize("value", [2**31, -(2**31) - 1, 2**70])
    def test_refuses_a_value_outside_its_column_s_range(
        self, db_engine: Engine, value: int
    ) -> None:
        # `id` is an INTEGER, and the cursor's value is bound as one: out of range, it would fail in
        # the database as a DataError -- a 500 for what is only a malformed cursor.
        keyset = Keyset(tiebreaker=events.c.id)
        _, cursor = one_page(db_engine, keyset, 3)
        assert cursor is not None

        with pytest.raises(ApiError) as failure:
            one_page(db_engine, keyset, 3, forged(cursor, value))

        assert failure.value.code.value == "invalid_cursor"

    def test_accepts_a_value_at_either_end_of_its_column_s_range(self, db_engine: Engine) -> None:
        # The bounds are the column's own, not one short of them.
        keyset = Keyset(tiebreaker=events.c.id)
        _, cursor = one_page(db_engine, keyset, 3)
        assert cursor is not None

        highest, _ = one_page(db_engine, keyset, 9, forged(cursor, 2**31 - 1))
        lowest, _ = one_page(db_engine, keyset, 9, forged(cursor, -(2**31)))

        assert highest == []
        assert len(lowest) == 9


@pytest.mark.parametrize("kind", [BigInteger, String, Double])
def test_refuses_to_page_on_a_type_it_cannot_read_back(kind: type[Any]) -> None:
    # An integer type without INTEGER's range, or a type no reader checks: a hand-made cursor could
    # carry a value the column cannot hold, so the keyset refuses at construction rather than when
    # a caller first sends one.
    other = Table("querying_other", MetaData(), Column("id", kind, primary_key=True))

    with pytest.raises(TypeError):
        Keyset(tiebreaker=other.c.id)

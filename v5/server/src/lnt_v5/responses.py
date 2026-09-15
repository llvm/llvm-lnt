"""The envelopes list endpoints return (R2).

Every list endpoint returns an object carrying its results under `items`, never a bare array, and
`items` is present and empty rather than absent when nothing matches. Wrapping even the
unpaginated lists is what lets one of them grow a cursor later without breaking clients.

What *produces* a cursor lives in `querying.py`; this module is only the shape it travels in.
"""

from __future__ import annotations

from pydantic import BaseModel, Field


class Items[T](BaseModel):
    """R2's unpaginated envelope: `{"items": [...]}`."""

    items: list[T]


class OffsetPage[T](BaseModel):
    """R2's offset envelope: `{"items": [...], "total": N}`.

    `total` counts everything matching the request's filters, ignoring `limit` and `offset`, so that
    a client can render "1-25 of 240". That exact count costs a scan of everything matching, which
    is why only bounded lists are offset-paginated -- an unbounded one uses a cursor and carries no
    `total`.
    """

    items: list[T]
    total: int


class PageCursor(BaseModel):
    """Where a cursor-paginated list continues (R2).

    `previous` is typed as null rather than as an optional string because R8 requires the document
    to describe only what the API can produce, and forward-only pagination can never produce a
    backward cursor. It is declared rather than defaulted so that the document marks it required:
    R4 promises a documented key is always present, and a defaulted field would be described as
    one a response may omit.
    """

    next: str | None = Field(
        description=(
            "An opaque token for the page after this one, or null when this is the last page. "
            "Pass it back the way this list takes it -- as the `cursor=` query parameter, or as "
            "the `cursor` key of the request body where the list is asked for with one. Do not "
            "parse it."
        )
    )
    previous: None = Field(
        description="Always null. Pagination is forward-only; reserved for backward pagination."
    )


class CursorPage[T](BaseModel):
    """R2's cursor envelope: `{"items": [...], "cursor": {"next": ..., "previous": null}}`.

    Carries no `total`, deliberately: an exact count costs a scan of everything matching, which is
    why an unbounded list is cursor-paginated in the first place.
    """

    items: list[T]
    cursor: PageCursor

    @classmethod
    def of(cls, items: list[T], next_cursor: str | None) -> CursorPage[T]:
        """The envelope around one page. `previous` is named here and nowhere else.

        R2 fixes it at null, and five endpoints will return this envelope; writing the constant out
        at each of them is five chances for one to say something different.
        """
        return cls(items=items, cursor=PageCursor(next=next_cursor, previous=None))

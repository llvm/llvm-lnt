"""The envelopes a sequence of results is returned in (I2).

A response carrying a sequence of results never returns a bare array: it carries them under `items`,
which is present and empty rather than absent when nothing matches. Wrapping even unpaginated
results is what lets an endpoint gain a cursor later without changing the shape of its responses.

What *produces* a cursor lives in `querying.py`; this module is only the shape it travels in.

The field descriptions are published in I8's document, so they are written for API users. The
class docstrings are not: pydantic does not carry a generic model's docstring over to its
parametrizations, so `openapi.py` describes each envelope where it renames it.
"""

from __future__ import annotations

from pydantic import BaseModel, Field


class Items[T](BaseModel):
    """I2's unpaginated envelope: `{"items": [...]}`."""

    items: list[T] = Field(description="The results.")


# `previous` is typed as null rather than as an optional string because I8 requires the document to
# describe only what the API can produce, and forward-only pagination can never produce a backward
# cursor. It is declared rather than defaulted so that the document marks it required: I4 promises a
# documented key is always present, and a defaulted field would be described as one a response may
# omit.
#
# The class docstring is published: it is this schema's description in I8's document.
class PageCursor(BaseModel):
    """Where to continue a cursor-paginated list."""

    next: str | None = Field(
        description=(
            "Pass this as `cursor` to get the next page. Null on the last page. It is an opaque "
            "string: don't try to parse it."
        ),
        # The shape `querying.Keyset.cursor` produces: base64url JSON of a fingerprint and the
        # position, here a submission time and an id.
        examples=["WyIzYzlmMGExYjdlNDIiLFsiMjAyNi0wOC0xNFQwMjo0MToxMloiLDE4NDJdXQ"],
    )
    previous: None = Field(description="Always null. Reserved for future use.")


class CursorPage[T](BaseModel):
    """I2's cursor envelope: `{"items": [...], "cursor": {"next": ..., "previous": null}}`."""

    items: list[T] = Field(description="The results on this page.")
    cursor: PageCursor

    @classmethod
    def of(cls, items: list[T], next_cursor: str | None) -> CursorPage[T]:
        """The envelope around one page. `previous` is named here and nowhere else.

        I2 fixes it at null, and five endpoints will return this envelope; writing the constant out
        at each of them is five chances for one to say something different.
        """
        return cls(items=items, cursor=PageCursor(next=next_cursor, previous=None))

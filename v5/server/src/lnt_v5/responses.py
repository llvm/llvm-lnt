"""The envelopes list endpoints return (R2).

Every list endpoint returns an object carrying its results under `items`, never a bare array, and
`items` is present and empty rather than absent when nothing matches. Wrapping even the
unpaginated lists is what lets one of them grow a cursor later without breaking clients.

The cursor envelope will join this module when an endpoint needs one; nothing is cursor-paginated
yet.
"""

from __future__ import annotations

from pydantic import BaseModel


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

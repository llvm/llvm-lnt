"""The envelopes list endpoints return (R2).

Every list endpoint returns an object carrying its results under `items`, never a bare array, and
`items` is present and empty rather than absent when nothing matches. Wrapping even the
unpaginated lists is what lets one of them grow a cursor later without breaking clients.

The cursor and offset envelopes will join this module when an endpoint needs them; nothing
paginates yet.
"""

from __future__ import annotations

from pydantic import BaseModel


class Items[T](BaseModel):
    """R2's unpaginated envelope: `{"items": [...]}`."""

    items: list[T]

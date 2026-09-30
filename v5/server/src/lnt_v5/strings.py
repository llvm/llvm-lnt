"""What a string has to be for PostgreSQL to store it (D5).

PostgreSQL cannot store the NUL character (U+0000) in any string column. JSON can carry one
(`"\\u0000"`), so a request can deliver it, and left alone it fails at the INSERT as a `DataError`
-- a 500 for what is plainly the caller's mistake. Every free-form string a request stores is
therefore validated with this, so that it is a 400 instead.

psycopg refuses to bind a NUL into any statement, not only into a stored value, so the same holds
for a string a request only looks up by. In a body that is still this check, applied where the
body's types are declared. A URL has no such single declaration -- each path segment and each
filter is declared by the endpoint that reads it -- so a NUL there is refused for the whole URL
before routing instead (`spa.RejectNulInUrl`).

Names restricted by a pattern (suite and entry names, D4) cannot contain one and do not need it.
"""

from __future__ import annotations

from pydantic import AfterValidator


def storable(value: str) -> str:
    if "\x00" in value:
        raise ValueError("may not contain the NUL character (U+0000)")
    return value


Storable = AfterValidator(storable)

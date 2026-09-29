"""What a string has to be for PostgreSQL to store it (D5).

PostgreSQL cannot store the NUL character (U+0000) in any string column. JSON can carry one
(`"\\u0000"`), so a request can deliver it, and left alone it fails at the INSERT as a `DataError`
-- a 500 for what is plainly the caller's mistake. Every free-form string a request stores is
therefore validated with this, so that it is a 400 instead.

psycopg refuses to bind a NUL into any statement, not only into a stored value, so the same holds
for a string a request only looks up by -- a path segment or a filter. Those are validated with
this too, except where the endpoint's contract is to report an unknown value rather than refuse it,
which is what `NUL` is exported for.

Names restricted by a pattern (suite and entry names, D4) cannot contain one and do not need it.
"""

from __future__ import annotations

from pydantic import AfterValidator

NUL = "\x00"


def storable(value: str) -> str:
    if NUL in value:
        raise ValueError("may not contain the NUL character (U+0000)")
    return value


Storable = AfterValidator(storable)

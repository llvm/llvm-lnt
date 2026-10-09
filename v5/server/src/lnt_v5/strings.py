"""What a string has to be for PostgreSQL to store it (D3, D5).

PostgreSQL stores the NUL character (U+0000) in neither a `text` column nor a `jsonb` value. JSON
can carry one (`"\\u0000"`), so a request can deliver it, and left alone it fails in the database as
a `DataError` -- not an integrity failure and not an undefined relation, so nothing attributes it
and the caller gets a 500 for a value it supplied. D3 makes it a 400 instead.

`Storable` is applied to every caller-supplied string -- a declared `text` value, a machine's name,
a commit's value and tag, a test's name, an API key's name -- because the failure is the column's
rather than any one endpoint's, and a per-endpoint check is one endpoint away from being forgotten.
`run_parameters` has no declared shape to hang a validator on, so it gets the same rule by a walk of
its own (see `suites/submission.py`), which is what `NUL` is exported for.

A schema entry's display name, unit and unit abbreviation are checked too, although they would not
fail: they are stored inside a schema's JSON text, where a NUL is written as the escape `\\u0000`.
They are checked because D3 rejects a NUL in every value of a request.

psycopg refuses to bind a NUL into any statement, not only into a stored value, so the same holds
for a string a request only looks up by. In a body that is still this check, applied where the
body's types are declared. A URL has no such single declaration -- each path segment and each
filter is declared by the endpoint that reads it -- so a NUL there is refused for the whole URL
before routing instead (`spa.RejectNulInUrl`).

Names restricted by a pattern (suite and entry names, D4) cannot contain one and do not need it.
"""

from __future__ import annotations

from pydantic import AfterValidator

NUL = "\x00"


def storable(value: str) -> str:
    if NUL in value:
        raise ValueError("must not contain a NUL character (U+0000), which cannot be stored")
    return value


Storable = AfterValidator(storable)

"""What a suite-scoped request does with the suite it addresses (D2).

Separate from `registry.py`, which is strictly the cache and knows nothing about requests. This is
the request layer over it: resolving `{testsuite}` inside the endpoint's own unit of work, and
answering the one failure that follows from the cache being allowed to lag.
"""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from typing import Any

from sqlalchemy import Connection
from sqlalchemy.exc import DBAPIError

from lnt_v5.db import is_missing_relation
from lnt_v5.errors import ApiError, ErrorCode, ErrorEnvelope
from lnt_v5.suites.registry import Suite, SuiteRegistry

# The two failures every suite-scoped operation can answer, worded once for R8's document. They come
# from `suite_scope` rather than from any endpoint, so restating them per endpoint would be dozens
# of copies of one sentence, each free to drift from what the code actually does.
SUITE_NOT_FOUND = "No test suite has that name."
SUITE_SCHEMA_CHANGED = "The suite's schema changed while the request was running; retry."


@contextmanager
def suite_scope(registry: SuiteRegistry, connection: Connection, name: str) -> Iterator[Suite]:
    """The suite a request addresses, and D2's answer for one that changes underneath it.

    What every suite-scoped endpoint opens its unit of work with:

        with engine.connect() as connection, suite_scope(registry, connection, name) as suite:
            ...

    Two obligations, both D2's. The freshness check happens on the endpoint's own connection, as
    the first statement of its unit of work, and an unknown suite is a 404 before any query runs.
    And a query that reaches a column another worker has since removed reports a retryable
    conflict rather than a fault: the check and the query cannot be made one atomic step, and they
    do not have to be, as long as the reader is answered rather than silently wrong.

    The translation deliberately starts *after* the suite resolves. Reaching this code at all
    means the global tables were there to read the registry from, so an undefined relation from
    here on can only be one of the suite's own -- whereas one raised while resolving would mean an
    unmigrated database, which is a fault and must not be reported as something to retry.
    """
    suite = registry.resolve(connection, name)
    try:
        yield suite
    except DBAPIError as error:
        if not is_missing_relation(error):
            raise
        raise ApiError(
            ErrorCode.CONFLICT,
            f"The schema of test suite '{name}' changed while this request was running. Retry.",
        ) from error


def suite_responses(
    *, not_found: str = SUITE_NOT_FOUND, conflict: str = SUITE_SCHEMA_CHANGED
) -> dict[int | str, dict[str, Any]]:
    """The two failures `suite_scope` can answer, as R8 response declarations.

    Every suite-scoped operation owes both, because both come from the scope rather than from
    anything the endpoint does. Declared beside the mechanism that produces them so the obligation
    travels with it rather than having to be remembered per endpoint, and taking wider wording
    where an endpoint adds cases of its own.
    """
    return {
        404: {"model": ErrorEnvelope, "description": not_found},
        409: {"model": ErrorEnvelope, "description": conflict},
    }

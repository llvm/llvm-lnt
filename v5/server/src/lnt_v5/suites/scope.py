"""What a suite-scoped request does with the suite it addresses (D2).

Separate from `registry.py`, which is strictly the cache and knows nothing about requests. This is
the request layer over it: resolving `{testsuite}` inside the endpoint's own unit of work, and
answering the failures a concurrent schema change can cause: the cache lagging behind it, and a
request contending with it for the suite's tables.
"""

from __future__ import annotations

import logging
from collections.abc import Iterator
from contextlib import contextmanager
from typing import Annotated, Any

from fastapi import Path
from sqlalchemy import Connection
from sqlalchemy.exc import DBAPIError

from lnt_v5.db import is_deadlock, is_lock_unavailable, is_missing_relation
from lnt_v5.errors import ApiError, ErrorCode, ErrorEnvelope
from lnt_v5.suites.registry import Suite, SuiteRegistry

logger = logging.getLogger(__name__)

# The two failures every suite-scoped operation can answer, worded once for I8's document. They come
# from `suite_scope` rather than from any endpoint, so restating them per endpoint would be dozens
# of copies of one sentence, each free to drift from what the code actually does. An endpoint that
# can fail to find something else too words its whole 404 itself, as one sentence naming the suite
# along with the rest, since appending to this one reads badly.
#
# OpenAPI keys responses by status alone, so every case an operation answers with 409 shares one
# description. Each case is therefore introduced by its I4 code, which is what a client branches on.
SUITE_NOT_FOUND = "The test suite doesn't exist."
SUITE_SCHEMA_CHANGED = (
    "`retry`: the suite's schema changed while the request was being handled. Send it again."
)

# The path segment naming a suite, described once for I8's document: `{testsuite}` on every
# suite-scoped route, and `{name}` on the suite routes themselves.
SuiteName = Annotated[str, Path(description="The name of the test suite.")]


@contextmanager
def suite_scope(registry: SuiteRegistry, connection: Connection, name: str) -> Iterator[Suite]:
    """The suite a request addresses, and D2's answer for one that changes underneath it.

    What every suite-scoped endpoint opens its unit of work with:

        with engine.connect() as connection, suite_scope(registry, connection, name) as suite:
            ...

    Three obligations, all D2's. The freshness check happens on the endpoint's own connection, as
    the first statement of its unit of work, and an unknown suite is a 404 before any query runs.
    A query that reaches a column another worker has since removed reports a retryable 409 rather
    than a fault: the check and the query cannot be made one atomic step, and they do not have to
    be, as long as the reader is answered rather than silently wrong. And so does a request that a
    concurrent schema change beat to the suite's tables: the change holds `ACCESS EXCLUSIVE` on
    each table it alters, so a request that already holds one of them and waits for another can
    deadlock with it, and PostgreSQL may abort either side. `suite_write` answers for the change.

    `retry` promises that nothing was written, which holds for the endpoints that write too: they
    run this inside `engine.begin()`, which the `ApiError` raised here rolls back whole.

    The translation deliberately starts *after* the suite resolves. Reaching this code at all
    means the global tables were there to read the registry from, so an undefined relation from
    here on can only be one of the suite's own -- whereas one raised while resolving would mean an
    unmigrated database, which is a fault and must not be reported as something to retry.
    """
    suite = registry.resolve(connection, name)
    try:
        yield suite
    except DBAPIError as error:
        if is_missing_relation(error):
            raise schema_changed(name) from error
        if not is_lock_unavailable(error):
            raise
        # Expected when a request races a schema change, but any other deadlock is a bug (O8 rules
        # out one between two submissions, for instance), and this is what reports it now that
        # the request gets a 409 rather than a 500.
        if is_deadlock(error):
            logger.warning(
                "A request on test suite '%s' was aborted by a deadlock and answered with a "
                "retryable 409: %s",
                name,
                error.orig,
            )
        raise ApiError(
            ErrorCode.RETRY,
            f"Test suite '{name}' is busy: this request conflicted with a concurrent change. "
            "Retry.",
        ) from error


def schema_changed(name: str) -> ApiError:
    """D2's retryable 409 for a request whose suite changed while it was running."""
    return ApiError(
        ErrorCode.RETRY,
        f"The schema of test suite '{name}' changed while this request was running. Retry.",
    )


def suite_responses(
    *, not_found: str = SUITE_NOT_FOUND, conflict: str = SUITE_SCHEMA_CHANGED
) -> dict[int | str, dict[str, Any]]:
    """The two failures `suite_scope` can answer, as I8 response declarations.

    Every suite-scoped operation owes both, because both come from the scope rather than from
    anything the endpoint does. Declared beside the mechanism that produces them so the obligation
    travels with it rather than having to be remembered per endpoint, and taking wider wording
    where an endpoint adds cases of its own.
    """
    return {
        404: {"model": ErrorEnvelope, "description": not_found},
        409: {"model": ErrorEnvelope, "description": conflict},
    }

"""A machine's time series, streamed (E9's `GET /series`).

The whole series, or the tests or commits the request selects, in one response, as NDJSON, rather
than a page at a time: the order a series is analysed in -- by test, then by commit -- is one no
page cursor can follow cheaply, and neither a tool that wants all of it nor a chart of one test has
any use for pages.

The response is read a batch of tests at a time, each batch in its own short statement that joins
the machine's runs to their samples, typically through the sample table's primary key, which leads
with the run: one probe per run, whether the batch is one test (a Graph trace), every test at one
commit, or part of a whole series. On a small suite the planner may instead scan
`(test_id, run_id)` for a large batch, which reads the batch's samples on every machine and
discards the others'. No connection, transaction or lock is held between batches, so a slow client
holds nothing in the database, and a client that goes away leaves nothing to clean up.

Once the response has started, a failure is an exception out of the body, which makes the server
abort the response rather than end it (E9).
"""

from __future__ import annotations

import time
from collections.abc import Generator, Sequence
from typing import Annotated, Any

import msgspec
from fastapi import APIRouter, Query
from fastapi.responses import Response, StreamingResponse
from sqlalchemy import (
    ColumnElement,
    Connection,
    Engine,
    Integer,
    Select,
    any_,
    exists,
    func,
    literal,
    select,
)
from sqlalchemy.dialects.postgresql import ARRAY

from lnt_v5.auth import require_scope
from lnt_v5.db import EngineDep
from lnt_v5.errors import ApiError, ErrorCode
from lnt_v5.openapi import schema_ref
from lnt_v5.querying import MAX_LIMIT, TIMESTAMP_HINT
from lnt_v5.routes.machines import machine_id
from lnt_v5.routes.suites import SUITES_PATH
from lnt_v5.routes.tests import Tests, test_ids
from lnt_v5.routes.timeseries import ONE_KIND_OF_COMMIT_FILTER, DataPoint, run_conditions
from lnt_v5.scopes import Scope
from lnt_v5.suites.entities import DatetimeValue, declared_entry
from lnt_v5.suites.registry import RegistryDep, Suite
from lnt_v5.suites.schema import Metric
from lnt_v5.suites.scope import ProjectName, SuiteName, suite_responses, suite_scope
from lnt_v5.tables import SCHEMA_VERSION_ID, schema_version

SERIES_PATH = f"{SUITES_PATH}/{{suite}}/series"

NDJSON = "application/x-ndjson"

router = APIRouter(prefix=f"{SUITES_PATH}/{{suite}}", tags=["Time Series"])

# About how many samples each statement returns. The tests in a batch are chosen from the number of
# runs that match, so that a statement sorts a bounded number of rows however long the machine's
# history is, and a request whose filters leave a handful of runs -- one commit, say -- reads every
# test in one statement.
BATCH_ROWS = 20_000

# How many rows of a batch are fetched at a time.
FETCH_ROWS = 5000

# When the buffered lines are sent, which is checked after each batch. Large enough that compressing
# a chunk leaves the event loop for a thread (Starlette's GZipMiddleware does from 128 KiB), and
# soon enough that a proxy waiting between two bytes of a long series does not time out.
CHUNK_BYTES = 128 * 1024
CHUNK_SECONDS = 1.0

# The keys of a line, in `DataPoint`'s order.
_KEYS = tuple(DataPoint.model_fields)

# A line, encoded by msgspec rather than pydantic, which takes twice as long: encoding is a large
# part of the time a whole series takes. A struct rather than a dict, since its keys are encoded
# once. The JSON is pydantic's for every value a line carries, except that a real of magnitude 1e16
# or more has no `+` in its exponent.
_Line = msgspec.defstruct("Line", _KEYS)
_ENCODER = msgspec.json.Encoder()

_NO_ENTITY = (
    "The test suite, the machine, one of the tests, or the `after_commit` or `before_commit` "
    "doesn't exist."
)


# The instance's schema version (D2), which a series compares between its start and each batch.
_VERSION = select(schema_version.c.version).where(schema_version.c.id == SCHEMA_VERSION_ID)


class SeriesInterruptedError(RuntimeError):
    """The series changed underneath the response in a way that would make the rest of it silently
    incomplete. Raised from the body, which aborts the response."""


class Series:
    """One machine's samples of one metric, as statements over a batch of tests at a time."""

    def __init__(self, suite: Suite, metric: Metric, machine_name: str, machine: int) -> None:
        tables = suite.tables
        self._run = tables.run
        self._commit = tables.commit
        self._sample = tables.sample
        self._test = tables.test
        self._machine = tables.machine
        self._value = self._sample.c[metric.name]
        self._metric = metric
        self._machine_name = machine_name
        self._machine_id = machine
        self._tests = Tests(suite)

    def _runs(self, query: Select[Any], conditions: Sequence[ColumnElement[bool]]) -> Select[Any]:
        """`query` over the machine's runs that match, with their commits."""
        return query.select_from(
            self._run.join(self._commit, self._commit.c.id == self._run.c.commit_id)
        ).where(self._run.c.machine_id == self._machine_id, *conditions)

    def runs(self, conditions: Sequence[ColumnElement[bool]]) -> Select[Any]:
        """How many of the machine's runs match, which is what sizes a batch."""
        return self._runs(select(func.count()), conditions)

    def tests(self, among: Sequence[int] | None) -> Select[Any]:
        """The tests that may have a value on the machine, in the order the series serves them.

        From `test_coverage`, which can only name more tests than have samples (D5): a test whose
        samples are gone reads as an empty batch. By code point, whatever the database's locale.
        """
        query = select(self._test.c.id).where(
            self._tests.has_sample(self._machine_id, self._metric)
        )
        if among is not None:
            query = query.where(self._test.c.id.in_(among))
        return query.order_by(self._test.c.name.collate("C"))

    def batch(self, tests: Sequence[int], conditions: Sequence[ColumnElement[bool]]) -> Select[Any]:
        """The samples of some tests on the machine, in the series' order.

        From the machine's runs, joined to their samples (see the module's docstring for how). The
        tests are one array rather than a bind parameter apiece, since a batch can hold every test
        the suite has. The order ends with the repetition, so that the same data is served byte for
        byte the same.
        """
        columns = select(
            self._test.c.name,
            self._value,
            self._commit.c.commit,
            self._commit.c.ordinal,
            self._run.c.uuid,
            self._run.c.submitted_at,
            self._run.c.measured_at,
            self._commit.c.tag,
        )
        return (
            self._runs(columns, conditions)
            .join(self._sample, self._sample.c.run_id == self._run.c.id)
            .join(self._test, self._test.c.id == self._sample.c.test_id)
            .where(
                self._sample.c.test_id == any_(literal(list(tests), ARRAY(Integer))),
                self._value.is_not(None),
            )
            .order_by(
                self._test.c.name.collate("C"),
                self._commit.c.ordinal.asc().nulls_last(),
                self._commit.c.commit.collate("C"),
                self._run.c.uuid,
                self._sample.c.repetition,
            )
        )

    def lines(self, connection: Connection, query: Select[Any], out: bytearray) -> None:
        """Append the batch's rows to `out` as NDJSON, serialized as they are fetched.

        Fetched a few at a time through a server-side cursor: fetched all at once, the result sits
        whole in the database driver's memory, which the process then keeps.
        """
        machine, metric = self._machine_name, self._metric.name
        for test, *rest in connection.execute(query.execution_options(yield_per=FETCH_ROWS)):
            _ENCODER.encode_into(_Line(test, machine, metric, *rest), out, -1)
            out += b"\n"

    def check(self, connection: Connection, version: int) -> None:
        """Abort if a batch just read may have come back incomplete without failing.

        Deleting the machine deletes its runs, so the batches after it would be empty rather than
        fail. A schema change can remove a metric and add it back between two batches, leaving an
        empty column of the same name. The schema version is the instance's, so a change to another
        suite aborts too: schema changes are rare, and telling them apart is not worth the risk.

        Checked after each batch rather than before, so that a change committed before the batch's
        statement began is caught whenever it happened.
        """
        current, machine_exists = connection.execute(
            _VERSION.add_columns(exists().where(self._machine.c.id == self._machine_id))
        ).one()
        if not machine_exists:
            raise SeriesInterruptedError(
                f"Machine '{self._machine_name}' was deleted while its series was being sent"
            )
        if current != version:
            raise SeriesInterruptedError(
                "A test suite's schema changed while a series was being sent"
            )


def stream(
    engine: Engine,
    series: Series,
    conditions: Sequence[ColumnElement[bool]],
    batches: Sequence[Sequence[int]],
    version: int,
) -> Generator[bytes]:
    """The response body: each batch read on a connection of its own, and sent in chunks.

    Starts with an empty chunk, which makes the server send the status and headers before the first
    statement runs: the compression middleware holds them until the body starts.
    """
    yield b""
    buffer = bytearray()
    sent = time.monotonic()
    for tests in batches:
        with engine.connect() as connection:
            series.lines(connection, series.batch(tests, conditions), buffer)
            series.check(connection, version)
        if len(buffer) >= CHUNK_BYTES or (buffer and time.monotonic() - sent >= CHUNK_SECONDS):
            yield bytes(buffer)
            buffer.clear()
            sent = time.monotonic()
    if buffer:
        yield bytes(buffer)


# The docstring and the descriptions below are published in I8's document, so they are written for
# API users.
@router.get(
    "/series",
    dependencies=[require_scope(Scope.READ)],
    summary="Download a machine's values of a metric",
    # Without a media type, so that FastAPI documents none for the 200 beside the one below.
    response_class=Response,
    responses={
        200: {
            "description": (
                "One value per line, each a JSON object of this schema (newline-delimited JSON). "
                "An empty body if nothing matches."
            ),
            "content": {NDJSON: {"schema": schema_ref(DataPoint)}},
        },
        **suite_responses(not_found=_NO_ENTITY),
    },
)
def get_series(
    project: ProjectName,
    testsuite: SuiteName,
    engine: EngineDep,
    registry: RegistryDep,
    metric: Annotated[
        str,
        Query(
            description=(
                "The metric to return values for. Returns 400 if the suite's schema doesn't "
                "define it."
            )
        ),
    ],
    machine: Annotated[
        str,
        Query(description="The machine to return values for. Returns 404 if it doesn't exist."),
    ],
    test: Annotated[
        list[str] | None,
        Query(
            description=(
                "Only return values for these tests. Repeat the parameter for several tests. "
                "Returns 404 if any of them doesn't exist. Every name lengthens the URL, which "
                "proxies limit to a few kilobytes: to read more than a few dozen tests, leave this "
                "out and read the machine's whole series instead."
            )
        ),
    ] = None,
    commit: Annotated[
        str | None,
        Query(
            description=(
                "Only return values from runs of this commit. If the commit doesn't exist, the "
                "result is empty. Can't be combined with `after_commit` or `before_commit`."
            )
        ),
    ] = None,
    after_commit: Annotated[
        str | None,
        Query(
            description=(
                "Only return values from commits after this one (exclusive), by ordinal. Commits "
                "without an ordinal are left out. Returns 404 if the commit doesn't exist, and 400 "
                "if it has no ordinal."
            )
        ),
    ] = None,
    before_commit: Annotated[
        str | None,
        Query(
            description=(
                "Only return values from commits before this one (exclusive), by ordinal. Commits "
                "without an ordinal are left out. Returns 404 if the commit doesn't exist, and 400 "
                "if it has no ordinal."
            )
        ),
    ] = None,
    submitted_after: Annotated[
        DatetimeValue | None,
        Query(
            description=f"Only return values from runs submitted after this time (exclusive). "
            f"{TIMESTAMP_HINT}"
        ),
    ] = None,
    submitted_before: Annotated[
        DatetimeValue | None,
        Query(
            description=(
                "Only return values from runs submitted before this time (exclusive). To read the "
                "same data again later, pick a time a few minutes in the past: a run is stamped "
                f"when it starts being stored, a little before it can be read. {TIMESTAMP_HINT}"
            )
        ),
    ] = None,
    measured_after: Annotated[
        DatetimeValue | None,
        Query(
            description=f"Only return values from runs measured after this time (exclusive). "
            f"{TIMESTAMP_HINT}"
        ),
    ] = None,
    measured_before: Annotated[
        DatetimeValue | None,
        Query(
            description=f"Only return values from runs measured before this time (exclusive). "
            f"{TIMESTAMP_HINT}"
        ),
    ] = None,
    has_ordinal: Annotated[
        bool | None,
        Query(
            description=(
                "Only return values from commits that have (`true`) or don't have (`false`) an "
                "ordinal. Leave out to return both. `after_commit` and `before_commit` imply "
                "`true`."
            )
        ),
    ] = None,
) -> StreamingResponse:
    """One machine's values of a metric, in a single response of newline-delimited JSON (one
    object per line): all of them, for tools that analyse a whole series, or those of the tests
    and commits the filters select, such as one test's to chart it. Values come grouped by test, in
    order of test name (by code point), then by commit ordinal, with the commits that have none
    last; then by commit and run, so that the same data always comes in the same order.

    The response is streamed as it is read, so it can be large and long: ask for it compressed
    (`Accept-Encoding: gzip`, or `curl --compressed`). Each test's values are read at one point in
    time, but different tests may be read at different times, so a run submitted or deleted during
    the download can appear for some tests and not others.

    If the download can't be completed -- the machine is deleted or a suite's schema changes
    meanwhile, or the server restarts -- the connection is closed before the end of the response,
    which HTTP clients report as an error (`curl` exits with a non-zero status). Download again in
    that case. A response that ends normally is complete.

    Try it out from this page only on a small series.
    """
    if commit is not None and (after_commit is not None or before_commit is not None):
        raise ApiError(ErrorCode.INVALID_REQUEST, ONE_KIND_OF_COMMIT_FILTER)
    # Bounded for the lookup below, which binds a parameter per name. Not advertised: a URL holding
    # this many names is far longer than any proxy accepts.
    if test is not None and len(test) > MAX_LIMIT:
        raise ApiError(ErrorCode.INVALID_REQUEST, f"At most {MAX_LIMIT} 'test' values are allowed")

    with engine.connect() as connection:
        # Before the suite is resolved, so that a schema change after this point is one the
        # batches see as a different version, even if it came before the suite was read.
        version = connection.execute(_VERSION).scalar_one()
        with suite_scope(registry, connection, project, testsuite) as suite:
            series = Series(
                suite,
                declared_entry(suite.schema, Metric, metric),
                machine,
                machine_id(connection, suite, machine),
            )
            among = None if test is None else list(test_ids(connection, suite, test).values())
            conditions = run_conditions(
                connection,
                suite,
                commit=commit,
                after_commit=after_commit,
                before_commit=before_commit,
                submitted_after=submitted_after,
                submitted_before=submitted_before,
                measured_after=measured_after,
                measured_before=measured_before,
            )
            # As on the commit list (E3): a commit bound leaves out the commits without an
            # ordinal by itself, so with `has_ordinal=false` nothing matches.
            if has_ordinal is not None:
                ordinal = suite.tables.commit.c.ordinal
                conditions.append(ordinal.is_not(None) if has_ordinal else ordinal.is_(None))
            runs = connection.execute(series.runs(conditions)).scalar_one()
            tests = [] if runs == 0 else list(connection.execute(series.tests(among)).scalars())

    size = max(1, BATCH_ROWS // max(runs, 1))
    batches = [tests[start : start + size] for start in range(0, len(tests), size)]
    return StreamingResponse(
        stream(engine, series, conditions, batches, version), media_type=NDJSON
    )

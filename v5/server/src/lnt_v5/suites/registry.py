"""The in-memory suite schemas, and how a worker notices another has changed them (D2).

Each worker keeps its own copy of every suite's schema, because parsing one and building its tables
costs real work and every suite-scoped request needs it. Keeping those copies honest is what this
module is for.

The protocol is D2's: the `schema_version` counter is bumped by every write, in the same transaction
as the write, and a reader compares its cached counter against the database before reading its
copies. A mismatch reloads everything.

**This is a read-path cache and nothing else.** A write path must not derive the schema it is about
to change from here -- the cache is allowed to be a commit behind, so two concurrent changes derived
from it would each overwrite the other's. `locked_suite` is what a write path uses instead: it takes
the row lock that makes the changes serialize. Nothing outside this module mutates a `Suite`; the
registry replaces its map wholesale on reload, and writers only ever write rows and bump.
"""

from __future__ import annotations

import logging
import threading
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Annotated

from fastapi import Depends, Request
from pydantic import ValidationError
from sqlalchemy import Connection, select, text, true, update

from lnt_v5.errors import ApiError, ErrorCode
from lnt_v5.suites.schema import SuiteSchema
from lnt_v5.suites.tables import SuiteTables, build
from lnt_v5.tables import SCHEMA_VERSION_ID, schema, schema_version

logger = logging.getLogger(__name__)

# What tables.py's NAMING_CONVENTION names `schema`'s primary key, and so the constraint a repeated
# suite name trips. Written out because it is fixed, and checked against what PostgreSQL reports by
# `test_registry.py` -- the same arrangement as `keys.PREFIX_CONSTRAINT`, and for the same reason: a
# convention change must fail a test rather than silently turn a 409 into a 500.
SCHEMA_NAME_CONSTRAINT = "pk_schema"

# How long a schema change waits for the locks it needs before giving up (see `lock_timeout`).
# Long enough to outlast an ordinary query holding the table, short enough that a long-running one
# does not park the request -- and its connection -- indefinitely.
LOCK_TIMEOUT = "3s"


@dataclass(frozen=True)
class Suite:
    """One suite's schema and the tables built from it.

    Immutable by contract, not merely by dataclass: several request threads in a worker read the
    same instance concurrently, and SQLAlchemy's `Table` is safe for concurrent reads only. A path
    that needs different tables calls `build` for a new set rather than appending to these.
    """

    schema: SuiteSchema
    tables: SuiteTables


def lock_timeout(connection: Connection) -> None:
    """Bound how long this transaction waits for a lock.

    Every schema change needs `ACCESS EXCLUSIVE` on the suite's tables, which conflicts with any
    reader. Worse, a *waiting* request for it queues ahead of new readers, so an unbounded wait
    behind one long query stalls every subsequent request for that suite across every worker, each
    holding a pooled connection -- which exhausts the pool and takes `/healthz` down with it, since
    it shares the engine.

    `SET LOCAL`, so it is scoped to the transaction and cannot leak onto a pooled connection.
    """
    connection.execute(text(f"SET LOCAL lock_timeout = '{LOCK_TIMEOUT}'"))


def bump(connection: Connection) -> None:
    """Tell every other worker that the suites have changed (D2).

    Must run in the same transaction as the change itself, so that a rolled-back write leaves the
    counter untouched and nobody reloads for nothing.
    """
    connection.execute(
        update(schema_version)
        .where(schema_version.c.id == SCHEMA_VERSION_ID)
        .values(version=schema_version.c.version + 1)
    )


def locked_suite(connection: Connection, name: str) -> SuiteSchema:
    """The stored schema of a suite the caller is about to change, with its row locked.

    Two things at once, and both matter. The row lock serializes every change to this suite, so a
    second one waits here rather than deriving its own change from a schema the first has already
    superseded. And the schema comes from *this* read rather than from the registry, because the
    registry may be a commit behind -- a change computed against a stale base would drop whatever
    the previous change added while still applying its own DDL, leaving the tables and the stored
    schema permanently disagreeing.

    Raises 404 if there is no such suite, which is also what makes a change racing a delete answer
    404 rather than succeeding against a row that is no longer there.
    """
    row = connection.execute(
        select(schema.c.schema_json).where(schema.c.name == name).with_for_update()
    ).one_or_none()
    if row is None:
        raise ApiError(ErrorCode.NOT_FOUND, f"Test suite '{name}' not found")
    return SuiteSchema.model_validate_json(row.schema_json)


class SuiteRegistry:
    """One worker's copy of every suite, kept fresh by D2's version counter.

    Held on the application rather than at module scope so that a test can drive two of them over
    one database, which is what a multi-worker deployment is.
    """

    def __init__(self) -> None:
        # Guards the reload. FastAPI runs sync endpoints in a threadpool, so several request threads
        # in one worker reach `fresh` at once, and without this each would reload separately.
        self._lock = threading.Lock()
        # None until the first successful load, which is why a fresh worker always reloads: no real
        # counter value can equal it.
        self._version: int | None = None
        self._suites: Mapping[str, Suite] = {}

    def fresh(self, connection: Connection) -> Mapping[str, Suite]:
        """Every suite, reloaded first if anyone has changed one since the last look (D2).

        Call this as the first statement of the endpoint's own unit of work, on the connection it
        already holds: D2 wants the comparison on every request path, and doing it here costs no
        extra connection. Never call it while holding a database lock -- it takes a Python lock, and
        the two orders together would be a cycle.
        """
        version, rows = self._read(connection)
        with self._lock:
            if version != self._version:
                self._suites = self._parse(rows)
                # Assigned only after a successful parse, and only alongside the map it describes,
                # so a load that raises leaves the worker stale-but-retrying rather than convinced
                # it is current.
                self._version = version
            return self._suites

    def resolve(self, connection: Connection, name: str) -> Suite:
        """One suite by name, or 404. The read path's counterpart to `locked_suite`."""
        suite = self.fresh(connection).get(name)
        if suite is None:
            raise ApiError(ErrorCode.NOT_FOUND, f"Test suite '{name}' not found")
        return suite

    @staticmethod
    def _read(connection: Connection) -> tuple[int, list[tuple[str, str]]]:
        """The counter and every stored schema, read as one statement.

        One statement deliberately, so both come from one snapshot. Read separately, the two could
        straddle another worker's commit -- and in one of the two orders the result is a worker that
        caches a counter newer than the data beside it and therefore stops reloading until the
        *next* change, serving a stale schema in between. Reading them together makes that
        unrepresentable rather than a comment someone has to preserve.

        The outer join is what keeps the counter readable when no suite exists yet.
        """
        rows = connection.execute(
            select(schema_version.c.version, schema.c.name, schema.c.schema_json)
            .select_from(schema_version.outerjoin(schema, true()))
            .where(schema_version.c.id == SCHEMA_VERSION_ID)
        ).all()
        # The check constraint guarantees the row, so `rows` is never empty.
        version = int(rows[0].version)
        return version, [(row.name, row.schema_json) for row in rows if row.name is not None]

    def _parse(self, rows: list[tuple[str, str]]) -> Mapping[str, Suite]:
        """Build the new map, keeping what still works if one row does not parse.

        Per row rather than all-or-nothing: `fresh` runs on every request path, so letting one
        unparseable row propagate would turn a single bad row -- a hand-edited one, or one written
        by a newer build that knows a key this one does not -- into a total outage for the worker,
        including for every unrelated suite. The previous copy is kept where there is one, and the
        counter still advances, so the failure is logged once per reload rather than per request.
        """
        suites: dict[str, Suite] = {}
        for name, schema_json in rows:
            try:
                parsed = SuiteSchema.model_validate_json(schema_json)
            except ValidationError:
                previous = self._suites.get(name)
                logger.warning(
                    "Could not parse the stored schema for suite %r; %s",
                    name,
                    "keeping the copy already loaded" if previous else "skipping it",
                    exc_info=True,
                )
                if previous is not None:
                    suites[name] = previous
                continue
            suites[name] = Suite(schema=parsed, tables=build(parsed))
        return suites


def get_registry(request: Request) -> SuiteRegistry:
    """This instance's registry, built once by `create_app` (D2)."""
    registry: SuiteRegistry = request.app.state.suites
    return registry


# What an endpoint writes to reach the suites:
#
#     def endpoint(db: EngineDep, registry: RegistryDep) -> Thing:
#         with db.connect() as connection:
#             suite = registry.resolve(connection, name)
#
# The dependency hands over the registry without touching the database; the freshness check happens
# on the connection the endpoint opens, inside its own unit of work. For a write that matters rather
# than merely saves a checkout: the check and the write have to be one transaction, and a dependency
# reading the counter on a connection of its own would let another worker's bump land in between.
RegistryDep = Annotated[SuiteRegistry, Depends(get_registry)]

"""One worker's copy of every suite schema, and how it notices another worker changed one (D2).

Each worker keeps its own copies, because parsing a schema and building its tables costs real work
and every suite-scoped request needs the result. Keeping those copies honest is what this module is
for, and all it is for: the write path lives in `store.py`, which a write uses instead of reading
here -- this cache is allowed to be a commit behind.

The protocol is D2's. Every write bumps `schema_version` in its own transaction, and a reader
compares its cached counter against the database before reading its copies. A mismatch reloads.
"""

from __future__ import annotations

import logging
import threading
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Annotated

from fastapi import Depends, Request
from pydantic import ValidationError
from sqlalchemy import Connection, select

from lnt_v5.errors import ApiError, ErrorCode
from lnt_v5.suites.schema import SuiteSchema
from lnt_v5.suites.tables import SuiteTables, build
from lnt_v5.tables import SCHEMA_VERSION_ID, schema, schema_version

logger = logging.getLogger(__name__)

# Stands in for "nothing loaded yet" in the query below. The counter starts at 0 and only rises, so
# no real version can equal it, which is what makes a fresh worker always load.
_NEVER_LOADED = -1


@dataclass(frozen=True)
class Suite:
    """One suite's schema, the tables built from it, and the text both came from.

    Immutable by contract, not merely by dataclass: several request threads read the same instance
    concurrently, and SQLAlchemy's `Table` is safe for concurrent reads only. A path that needs
    different tables calls `build` for a new set rather than appending to these.

    `schema_json` is kept so that a reload can tell this suite is the one it already has.
    """

    schema: SuiteSchema
    tables: SuiteTables
    schema_json: str


class SuiteRegistry:
    """Every suite this worker knows about, kept fresh by D2's version counter.

    Held on the application rather than at module scope so that a test can drive two of them over
    one database, which is what a multi-worker deployment is.
    """

    def __init__(self) -> None:
        # Guards the reload. FastAPI runs sync endpoints in a threadpool, so several request threads
        # in one worker reach `fresh` at once, and without this each would reload separately. The
        # build stays inside it deliberately: letting threads build concurrently would only
        # duplicate the same GIL-bound work.
        self._lock = threading.Lock()
        self._version: int | None = None
        self._suites: Mapping[str, Suite] = {}

    def fresh(self, connection: Connection) -> Mapping[str, Suite]:
        """Every suite, reloaded first if anyone has changed one since the last look (D2).

        Call this as the first statement of the endpoint's own unit of work, on the connection it
        already holds: D2 wants the comparison on every request path, and doing it here costs no
        extra connection. Never call it while holding a database lock -- it takes a Python lock, and
        the two orders together would be a cycle.
        """
        cached = self._version
        version, rows = _read(connection, cached)
        with self._lock:
            # `rows` only means something relative to `cached`: a read that saw the counter unmoved
            # carries no rows at all. So if another thread has installed a newer map since, this
            # read is stale, and installing it would empty the map or roll it back. Theirs is at
            # least as fresh as this one, so serve it.
            if self._version == cached and version != cached:
                self._suites = self._parse(rows)
                # Assigned only after a successful parse, and only alongside the map it describes,
                # so a load that raises leaves the worker stale-but-retrying rather than convinced
                # it is current.
                self._version = version
            return self._suites

    def resolve(self, connection: Connection, name: str) -> Suite:
        """One suite by name, or 404. The read path's counterpart to `store.locked_suite`."""
        suite = self.fresh(connection).get(name)
        if suite is None:
            raise ApiError(ErrorCode.NOT_FOUND, f"Test suite '{name}' not found")
        return suite

    def _parse(self, rows: list[tuple[str, str]]) -> Mapping[str, Suite]:
        """The new map, reusing what has not changed and keeping what no longer parses.

        Per row rather than all-or-nothing, for two reasons. The counter is global, so a change to
        one suite would otherwise discard and rebuild every other -- and building is the expensive
        part, so a reload reuses any suite whose stored text is byte-identical to the text it was
        built from. And letting one unparseable row propagate would turn a single bad row -- one
        edited by hand, or one a newer build wrote carrying a key this one does not know -- into a
        total outage for the worker, including for every unrelated suite, on every request.
        """
        suites: dict[str, Suite] = {}
        for name, schema_json in rows:
            previous = self._suites.get(name)
            if previous is not None and previous.schema_json == schema_json:
                suites[name] = previous
                continue
            try:
                parsed = SuiteSchema.model_validate_json(schema_json)
            except ValidationError:
                logger.warning(
                    "Could not parse the stored schema for suite %r; %s",
                    name,
                    "keeping the copy already loaded" if previous else "skipping it",
                    exc_info=True,
                )
                if previous is not None:
                    suites[name] = previous
                continue
            suites[name] = Suite(schema=parsed, tables=build(parsed), schema_json=schema_json)
        return suites


def _read(connection: Connection, cached: int | None) -> tuple[int, list[tuple[str, str]]]:
    """The counter, and every stored schema *if* the counter has moved, as one statement.

    One statement, so the counter and the schemas come from one snapshot. Read separately they could
    straddle another worker's commit -- and in one of the two orders the reader ends up caching a
    counter newer than the data beside it, so it stops reloading until the *next* change and serves
    a stale schema in between. Reading them together makes that unrepresentable.

    The join *condition*, rather than a plain cross join, is what keeps D2's promise that the
    per-request check is a single-row integer read: on the common path the counter has not moved,
    the join produces no schema rows, and no schema text crosses the wire to be parsed and then
    discarded. The outer join is what keeps the counter readable when there is nothing to load --
    either because no suite exists, or because none has changed.
    """
    moved = schema_version.c.version != (_NEVER_LOADED if cached is None else cached)
    rows = connection.execute(
        select(schema_version.c.version, schema.c.name, schema.c.schema_json)
        .select_from(schema_version.outerjoin(schema, moved))
        .where(schema_version.c.id == SCHEMA_VERSION_ID)
    ).all()
    # The check constraint guarantees the counter row, so `rows` is never empty.
    version = int(rows[0].version)
    return version, [(row.name, row.schema_json) for row in rows if row.name is not None]


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
# on the connection the endpoint opens, inside its own unit of work. There is deliberately no
# accessor that skips the check, so an endpoint cannot obtain a snapshot without paying for it.
RegistryDep = Annotated[SuiteRegistry, Depends(get_registry)]

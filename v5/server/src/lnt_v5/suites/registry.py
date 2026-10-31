"""One worker's copy of every project and suite schema, and how it notices another worker changed
one (D2).

Each worker keeps its own copies, because parsing a schema and building its tables costs real work
and every suite-scoped request needs the result. Keeping those copies honest is what this module is
for, and all it is for: the write path lives in `store.py`, which a write uses instead of reading
here -- this cache is allowed to be a commit behind -- and what a *request* does with a suite it
addresses lives in `scope.py`.

The protocol is D2's. Every write bumps `schema_version` in its own transaction, and a reader
compares its cached counter against the database before reading its copies. A mismatch reloads.
"""

from __future__ import annotations

import logging
import threading
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field, replace
from types import FunctionType
from typing import Annotated, Any, NamedTuple, cast

from fastapi import Depends, Request
from pydantic import ValidationError
from sqlalchemy import Connection, select

from lnt_v5.suites.schema import SuiteSchema
from lnt_v5.suites.store import full_name, project_not_found, suite_not_found
from lnt_v5.suites.tables import SuiteTables, build
from lnt_v5.tables import SCHEMA_VERSION_ID, project, schema, schema_version

logger = logging.getLogger(__name__)

# Stands in for "nothing loaded yet" in the query below. The counter starts at 0 and only rises, so
# no real version can equal it, which is what makes a fresh worker always load.
_NEVER_LOADED = -1


@dataclass(frozen=True)
class Suite:
    """One suite's identity and names, its schema, the tables built from it, and the text both came
    from.

    Immutable by contract, not merely by dataclass: several request threads read the same instance
    concurrently, and SQLAlchemy's `Table` is safe for concurrent reads only. A path that needs
    different tables calls `build` for a new set rather than appending to these. The one exception
    is `derived`'s cache of values computed from these fields, which never changes a value once
    cached.

    `schema_json` is kept so that a reload can tell this suite's tables are the ones it already has,
    along with the namespace they are in.
    """

    id: int
    project: str
    schema: SuiteSchema
    tables: SuiteTables
    schema_json: str
    _derived: dict[Callable[[Suite], Any], Any] = field(
        default_factory=dict, init=False, repr=False, compare=False
    )

    @property
    def name(self) -> str:
        return self.schema.name

    @property
    def full_name(self) -> str:
        """How people and logs name the suite outside its project's context (D7)."""
        return full_name(self.project, self.name)

    def derived[T](self, build: Callable[[Suite], T]) -> T:
        """`build(self)`, computed on first use and kept for as long as this suite is, such as a
        statement a request would otherwise construct every time.

        A schema change replaces the suite, so nothing cached here can outlive the schema it was
        built from. `build` is the key, so it must be a module-level function: a lambda, a closure
        or a bound method would be a new key on every call, never hit, and grow without bound.
        """
        assert isinstance(build, FunctionType) and "<locals>" not in build.__qualname__, build
        try:
            return cast(T, self._derived[build])
        except KeyError:
            # Two threads may both build it; `setdefault` keeps whichever came first.
            return cast(T, self._derived.setdefault(build, build(self)))


@dataclass(frozen=True)
class Project:
    """One project, and its suites by name (D7)."""

    name: str
    display_name: str | None
    suites: Mapping[str, Suite]


class SuiteRegistry:
    """Every project and suite this worker knows about, kept fresh by D2's version counter.

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
        self._projects: Mapping[str, Project] = {}

    def fresh(self, connection: Connection) -> Mapping[str, Project]:
        """Every project, with its suites, reloaded first if anyone has changed one since the last
        look (D2).

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
                self._projects = self._parse(rows)
                # Assigned only after a successful parse, and only alongside the map it describes,
                # so a load that raises leaves the worker stale-but-retrying rather than convinced
                # it is current.
                self._version = version
            return self._projects

    def suites(self, connection: Connection) -> list[Suite]:
        """Every suite, fresh (see `fresh`), by project name, then by name."""
        projects = self.fresh(connection)
        return [
            projects[project_name].suites[name]
            for project_name in sorted(projects)
            for name in sorted(projects[project_name].suites)
        ]

    def resolve_project(self, connection: Connection, name: str) -> Project:
        """One project by name, or 404."""
        found = self.fresh(connection).get(name)
        if found is None:
            raise project_not_found(name)
        return found

    def resolve(self, connection: Connection, project: str, name: str) -> Suite:
        """One suite by its project's name and its own, or 404. The read path's counterpart to
        `store.locked_suite`."""
        suite = self.resolve_project(connection, project).suites.get(name)
        if suite is None:
            raise suite_not_found(project, name)
        return suite

    def _parse(self, rows: list[_Row]) -> Mapping[str, Project]:
        """The new map, reusing what has not changed and keeping what no longer parses.

        Per suite rather than all-or-nothing, for two reasons. The counter is global, so a change to
        one suite or project would otherwise discard and rebuild every suite -- and building is the
        expensive part, so a reload reuses the tables of any suite whose stored text is
        byte-identical to the text they were built from. And letting one unparseable row propagate
        would turn a single bad row -- one edited by hand, or one a newer build wrote carrying a key
        this one does not know -- into a total outage for the worker, including for every unrelated
        suite, on every request.

        A suite is matched to its previous copy by identity rather than by name, which changes when
        it is renamed or moved (D7), and its tables reused only if they are in the namespace the row
        names: one deleted and created again under the same name, from the same schema, is a suite
        of its own, in a namespace of its own (D5), and the copy of the suite it replaced would
        address tables that are gone.
        """
        previous = {
            suite.id: suite for found in self._projects.values() for suite in found.suites.values()
        }
        projects: dict[str, tuple[str | None, dict[str, Suite]]] = {}
        for row in rows:
            _, suites = projects.setdefault(row.project, (row.display_name, {}))
            if row.suite_id is None:
                continue
            suite = self._suite(row, previous.get(row.suite_id))
            if suite is not None:
                suites[suite.name] = suite
        return {
            name: Project(name=name, display_name=display_name, suites=suites)
            for name, (display_name, suites) in projects.items()
        }

    @staticmethod
    def _suite(row: _Row, previous: Suite | None) -> Suite | None:
        """The suite `row` describes, from `previous` where it can be, or None if it does not parse
        and there is no copy of it to keep."""
        assert row.suite_id is not None and row.namespace is not None
        assert row.schema_json is not None
        if previous is not None and previous.tables.namespace != row.namespace:
            previous = None
        if previous is not None and previous.schema_json == row.schema_json:
            if previous.project == row.project:
                return previous
            return replace(previous, project=row.project)
        try:
            parsed = SuiteSchema.model_validate_json(row.schema_json)
        except ValidationError:
            logger.warning(
                "Could not parse the stored schema for suite %r; %s",
                full_name(row.project, row.suite_name or ""),
                "keeping the copy already loaded" if previous else "skipping it",
                exc_info=True,
            )
            return previous
        return Suite(
            id=row.suite_id,
            project=row.project,
            schema=parsed,
            tables=build(parsed, row.namespace),
            schema_json=row.schema_json,
        )


class _Row(NamedTuple):
    """One project, and one of its suites unless it has none, as far as the registry reads them."""

    project: str
    display_name: str | None
    suite_id: int | None
    suite_name: str | None
    namespace: str | None
    schema_json: str | None


def _read(connection: Connection, cached: int | None) -> tuple[int, list[_Row]]:
    """The counter, and every project and stored schema *if* the counter has moved, as one
    statement.

    One statement, so the counter and the schemas come from one snapshot. Read separately they could
    straddle another worker's commit -- and in one of the two orders the reader ends up caching a
    counter newer than the data beside it, so it stops reloading until the *next* change and serves
    a stale schema in between. Reading them together makes that unrepresentable.

    The join *condition*, rather than a plain cross join, is what keeps D2's promise that the
    per-request check is a single-row integer read: on the common path the counter has not moved,
    the join produces no rows, and no schema text crosses the wire to be parsed and then discarded.
    The outer joins are what keep the counter readable when there is nothing to load -- either
    because no project exists, or because nothing has changed -- and what keep a project without
    suites.
    """
    moved = schema_version.c.version != (_NEVER_LOADED if cached is None else cached)
    catalog = project.outerjoin(schema, schema.c.project_id == project.c.id)
    rows = connection.execute(
        select(
            schema_version.c.version,
            project.c.name.label("project"),
            project.c.display_name,
            schema.c.id.label("suite_id"),
            schema.c.name.label("suite_name"),
            schema.c.namespace,
            schema.c.schema_json,
        )
        .select_from(schema_version.outerjoin(catalog, moved))
        .where(schema_version.c.id == SCHEMA_VERSION_ID)
    ).all()
    # The check constraint guarantees the counter row, so `rows` is never empty.
    version = int(rows[0].version)
    return version, [
        _Row(
            project=row.project,
            display_name=row.display_name,
            suite_id=row.suite_id,
            suite_name=row.suite_name,
            namespace=row.namespace,
            schema_json=row.schema_json,
        )
        for row in rows
        if row.project is not None
    ]


def get_registry(request: Request) -> SuiteRegistry:
    """This instance's registry, built once by `create_app` (D2)."""
    registry: SuiteRegistry = request.app.state.suites
    return registry


# What an endpoint writes to reach the suites:
#
#     def endpoint(db: EngineDep, registry: RegistryDep) -> Thing:
#         with db.connect() as connection, suite_scope(registry, connection, name) as suite:
#             ...
#
# The dependency hands over the registry without touching the database; the freshness check happens
# on the connection the endpoint opens, inside its own unit of work (see `scope.suite_scope`, which
# is what a suite-scoped endpoint should call rather than `resolve` directly). There is deliberately
# no accessor that skips the check, so an endpoint cannot obtain a snapshot without paying for it.
RegistryDep = Annotated[SuiteRegistry, Depends(get_registry)]

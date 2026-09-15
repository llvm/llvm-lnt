"""Machines: the hosts runs are measured on (endpoints.md, Machines).

A machine is one of the two entities carrying schema-declared metadata (D7), so the object these
endpoints accept and return is the same one a run submission nests under `machine`: the identity
attribute `name`, the built-in `tracked`, and a `fields` dict of declared `machine_fields`. The
shape and the validation of `fields` live in `suites/entities.py`, shared with everything else that
writes one.

`last_run_at` is the one key here that is not stored. D5 derives it on read, and is explicit about
how: one index probe per machine, not an aggregate over the suite's whole run table. `_Machines`
below is what holds the query that does it, so that the list and the detail cannot drift apart on
either the columns they select or the way they read a row back.
"""

from __future__ import annotations

from collections.abc import Sequence
from datetime import datetime
from typing import Annotated, Any, Literal
from urllib.parse import quote

from fastapi import APIRouter, Query, Response
from pydantic import Field, StringConstraints
from sqlalchemy import (
    ColumnElement,
    Connection,
    Row,
    Select,
    Table,
    UnaryExpression,
    delete,
    func,
    insert,
    nulls_last,
    select,
    true,
    update,
)

from lnt_v5.auth import require_scope
from lnt_v5.db import EngineDep, reporting_violation
from lnt_v5.errors import ApiError, ErrorCode
from lnt_v5.querying import DEFAULT_LIMIT, Limit, Offset, search_condition, sort_order
from lnt_v5.responses import OffsetPage
from lnt_v5.routes.suites import SUITES_PATH
from lnt_v5.scopes import Scope
from lnt_v5.suites.entities import (
    Addressable,
    EntityObject,
    FieldValue,
    rendered_fields,
    validate_fields,
)
from lnt_v5.suites.registry import RegistryDep, Suite
from lnt_v5.suites.schema import MachineField
from lnt_v5.suites.scope import SUITE_NOT_FOUND, SUITE_SCHEMA_CHANGED, suite_responses, suite_scope
from lnt_v5.suites.tables import MACHINE_NAME_CONSTRAINT, NAME_LENGTH

MACHINES_PATH = f"{SUITES_PATH}/{{testsuite}}/machines"

router = APIRouter(prefix=MACHINES_PATH, tags=["Machines"])

MachineName = Annotated[
    str,
    StringConstraints(min_length=1, max_length=NAME_LENGTH),
    Addressable,
    Field(
        description=(
            "Identifies the machine within its test suite. It appears in the URL that addresses "
            "the machine, so it may not contain '/' and may not be '.' or '..' (R1)."
        )
    ),
]

Tracked = Annotated[
    bool,
    Field(
        description=(
            "Whether the machine takes part in automatic machine selection. An untracked machine "
            "stays fully addressable everywhere a machine is chosen deliberately."
        )
    ),
]

# endpoints.md names these four and no others. A literal rather than a free string, so R8's document
# enumerates them and an unknown one is a 400 before the endpoint runs.
MachineSort = Literal["name", "-name", "last_run_at", "-last_run_at"]

# Every operation here reaches the suite's own tables, so every one can answer both of the failures
# `suite_scope` produces; each widens the wording with the cases it adds of its own.
_NO_MACHINE = f"{SUITE_NOT_FOUND} Or no machine in it has that name."
_NAME_TAKEN = f"A machine of that name already exists. {SUITE_SCHEMA_CHANGED}"


def _hide_default(schema: dict[str, Any]) -> None:
    """Keep a sentinel default out of R8's document.

    `MachineUpdate` gives its optional keys defaults of the right *type* that are never read; `""`
    is one, and it violates the `minLength` beside it. Published, it would tell a generated client
    that omitting `name` means sending `""`, which the server answers 400 -- a response the
    document would then be describing wrongly.
    """
    schema.pop("default", None)


class MachineObject(EntityObject):
    """D7's entity object for a machine, as every write path accepts it."""

    name: MachineName
    tracked: Tracked = True


class Machine(MachineObject):
    """A machine as every response carries it: the entity object plus what D5 derives.

    `tracked` and `fields` are redeclared without their defaults. R4 requires every documented key
    to be present in a response, and inheriting the request model's optionality would instead tell
    a generated client both may be absent.
    """

    tracked: Tracked
    fields: dict[str, FieldValue]
    last_run_at: datetime | None = Field(
        description="When the machine's most recent run was submitted, or null if it has none."
    )


class MachineUpdate(EntityObject):
    """What `PATCH` may change. A key the request omits is left unchanged.

    Every key is optional and the defaults below are never read, because the endpoint dumps this
    with `exclude_unset`. Their *types* are what carry meaning: neither `name` nor `tracked` is
    nullable, so sending either as null is a 400 rather than an instruction to clear it. Inside
    `fields`, an explicit null does clear a stored value -- the same convention as
    `PATCH /api/suites/{testsuite}/commits/{value}`.
    """

    name: MachineName = Field(default="", json_schema_extra=_hide_default)
    tracked: Tracked = True


class _Machines:
    """The query every machine response is built from, and how to read one of its rows back.

    `last_run_at` is derived on read and never stored (D5): a stored copy would have to be
    recomputed whenever a run was deleted, and synchronized on submission. The LATERAL probe below
    is what D5 asks for -- the compound index on `{suite}.run(machine_id, submitted_at)` makes it a
    single-row backward index scan per machine, where `max(submitted_at) ... GROUP BY machine_id`
    would read every run in the suite to answer a question about a handful of machines.
    """

    def __init__(self, suite: Suite) -> None:
        self.schema = suite.schema
        self.table: Table = suite.tables.machine
        run = suite.tables.run
        self._probe = (
            select(run.c.submitted_at)
            .where(run.c.machine_id == self.table.c.id)
            .order_by(run.c.submitted_at.desc())
            .limit(1)
            .lateral("last_run")
        )
        self.last_run_at = self._probe.c.submitted_at

    def select(self) -> Select[Any]:
        return select(
            self.table.c.name,
            self.table.c.tracked,
            *(self.table.c[field.name] for field in self.schema.machine_fields),
            self.last_run_at,
        ).select_from(self.table.outerjoin(self._probe, true()))

    def order(self, sort: str) -> Sequence[UnaryExpression[Any]]:
        field, descending = sort_order(sort)
        column = self.table.c.name if field == "name" else self.last_run_at
        ordered = column.desc() if descending else column.asc()
        if field == "name":
            # Unique, so it is already a total order and needs no tiebreaker.
            return [ordered]
        # endpoints.md: a machine with no runs sorts after every machine that has one *in both
        # directions*, so NULLS LAST is stated rather than left to PostgreSQL, which defaults to it
        # only for an ascending sort. `name` breaks ties, so a page boundary is reproducible.
        return [nulls_last(ordered), self.table.c.name.asc()]

    def search(self, term: str) -> ColumnElement[bool]:
        return search_condition(term, self.table, ["name"], self.schema.machine_fields)

    def read(self, row: Row[Any]) -> Machine:
        return Machine(
            name=row._mapping[self.table.c.name],
            tracked=row._mapping[self.table.c.tracked],
            fields=rendered_fields(self.schema.machine_fields, self.table, row),
            last_run_at=row._mapping[self.last_run_at],
        )

    def one(self, connection: Connection, name: str) -> Machine:
        row = connection.execute(self.select().where(self.table.c.name == name)).one_or_none()
        if row is None:
            raise self.missing(name)
        return self.read(row)

    def missing(self, name: str) -> ApiError:
        """The 404 for a machine that is not there, worded in one place for all three callers."""
        return ApiError(
            ErrorCode.NOT_FOUND, f"No machine named '{name}' in test suite '{self.schema.name}'"
        )

    def taken(self, name: str) -> str:
        return f"A machine named '{name}' already exists in test suite '{self.schema.name}'"


def _location(testsuite: str, name: str) -> str:
    """Where `POST` says the machine it created can be read back (R1)."""
    return f"{MACHINES_PATH.format(testsuite=quote(testsuite, safe=''))}/{quote(name, safe='')}"


@router.get(
    "",
    dependencies=[require_scope(Scope.READ)],
    summary="List machines",
    responses=suite_responses(),
)
def list_machines(
    testsuite: str,
    engine: EngineDep,
    registry: RegistryDep,
    search: Annotated[
        str | None,
        Query(
            description=(
                "Case-insensitive substring match against the machine's name or any searchable "
                "machine field."
            )
        ),
    ] = None,
    tracked: Annotated[
        bool | None,
        Query(description="Keep only tracked or only untracked machines. Omit for both."),
    ] = None,
    sort: MachineSort = "name",
    limit: Limit = DEFAULT_LIMIT,
    offset: Offset = 0,
) -> OffsetPage[Machine]:
    """Every machine in the suite, filtered, ordered and offset-paginated (R2, R3, D9)."""
    with engine.connect() as connection, suite_scope(registry, connection, testsuite) as suite:
        machines = _Machines(suite)
        conditions: list[ColumnElement[bool]] = []
        if search is not None:
            conditions.append(machines.search(search))
        if tracked is not None:
            conditions.append(machines.table.c.tracked.is_(tracked))

        # R2: the count ignores `limit` and `offset`, and needs no `last_run_at`, so it is a count
        # over the machine table alone rather than over the join.
        total = connection.execute(
            select(func.count()).select_from(machines.table).where(*conditions)
        ).scalar_one()
        rows = connection.execute(
            machines.select()
            .where(*conditions)
            .order_by(*machines.order(sort))
            .limit(limit)
            .offset(offset)
        ).all()
        return OffsetPage(items=[machines.read(row) for row in rows], total=total)


@router.post(
    "",
    status_code=201,
    dependencies=[require_scope(Scope.MANAGE)],
    summary="Create a machine",
    responses=suite_responses(conflict=_NAME_TAKEN),
)
def create_machine(
    testsuite: str,
    body: MachineObject,
    engine: EngineDep,
    registry: RegistryDep,
    response: Response,
) -> Machine:
    """Create a machine without a run (D7).

    Machines are also created implicitly by run submission; this is the path for declaring one
    ahead of any data, or for one that will never carry any.
    """
    with engine.begin() as connection, suite_scope(registry, connection, testsuite) as suite:
        machines = _Machines(suite)
        values = validate_fields(suite.schema, MachineField, body.fields)
        with reporting_violation(
            MACHINE_NAME_CONSTRAINT, ErrorCode.DUPLICATE, machines.taken(body.name)
        ):
            connection.execute(
                insert(machines.table).values(name=body.name, tracked=body.tracked, **values)
            )
        created = machines.one(connection, body.name)

    response.headers["Location"] = _location(testsuite, body.name)
    return created


@router.get(
    "/{machine_name}",
    dependencies=[require_scope(Scope.READ)],
    summary="Get a machine",
    responses=suite_responses(not_found=_NO_MACHINE),
)
def get_machine(
    testsuite: str, machine_name: str, engine: EngineDep, registry: RegistryDep
) -> Machine:
    """One machine, in the same shape the list returns."""
    with engine.connect() as connection, suite_scope(registry, connection, testsuite) as suite:
        return _Machines(suite).one(connection, machine_name)


@router.patch(
    "/{machine_name}",
    dependencies=[require_scope(Scope.MANAGE)],
    summary="Update a machine",
    responses=suite_responses(not_found=_NO_MACHINE, conflict=_NAME_TAKEN),
)
def update_machine(
    testsuite: str,
    machine_name: str,
    body: MachineUpdate,
    engine: EngineDep,
    registry: RegistryDep,
) -> Machine:
    """Rename a machine, flip `tracked`, and/or set declared fields (D7).

    A key the request omits is left unchanged, inside `fields` as well as beside it, so a caller
    that knows one field can send that field alone.
    """
    with engine.begin() as connection, suite_scope(registry, connection, testsuite) as suite:
        machines = _Machines(suite)
        changes = body.model_dump(exclude_unset=True)
        values: dict[str, Any] = {
            key: changes[key] for key in ("name", "tracked") if key in changes
        }
        if "fields" in changes:
            values |= validate_fields(suite.schema, MachineField, changes["fields"])

        if not values:
            # Nothing to write, but still a 404 for a machine that is not there; `one` answers both.
            return machines.one(connection, machine_name)

        renamed_to = values.get("name", machine_name)
        with reporting_violation(
            MACHINE_NAME_CONSTRAINT, ErrorCode.DUPLICATE, machines.taken(renamed_to)
        ):
            changed = connection.execute(
                update(machines.table).where(machines.table.c.name == machine_name).values(**values)
            )
        # Reported against the name the request addressed rather than the one it asked for, which
        # is the one the caller got wrong.
        if changed.rowcount == 0:
            raise machines.missing(machine_name)
        return machines.one(connection, renamed_to)


@router.delete(
    "/{machine_name}",
    status_code=204,
    dependencies=[require_scope(Scope.MANAGE)],
    summary="Delete a machine",
    responses=suite_responses(not_found=_NO_MACHINE),
)
def delete_machine(
    testsuite: str, machine_name: str, engine: EngineDep, registry: RegistryDep
) -> None:
    """Delete a machine, its runs, and every regression indicator naming it (D5).

    One statement: D5 gives `{suite}.run.machine_id` and `{suite}.regression_indicator.machine_id`
    an `ON DELETE CASCADE`, and the runs take their samples and profiles with them in turn. A
    regression left with no indicators is deliberately kept -- it keeps its title, bug, notes and
    commit, and an empty indicator set is a legal state.
    """
    with engine.begin() as connection, suite_scope(registry, connection, testsuite) as suite:
        machines = _Machines(suite)
        removed = connection.execute(
            delete(machines.table).where(machines.table.c.name == machine_name)
        )
        if removed.rowcount == 0:
            raise machines.missing(machine_name)

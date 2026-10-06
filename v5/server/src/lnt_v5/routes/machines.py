"""Machines: the hosts runs are measured on (E2).

A machine is one of the two entities carrying schema-declared metadata (O2), so the object these
endpoints accept and return is the same one a run submission nests under `machine`: the identity
attribute `name`, the built-in `tracked`, and a `fields` dict of declared `machine_fields`. That
object, and the validation of `fields`, live in `suites/entities.py`, shared with everything else
that writes one; only the response models are here.

`last_run_at` is the one key here that is not stored. D5 derives it on read, and is explicit about
how: one index probe per machine, not an aggregate over the suite's whole run table. `Machines`
below is what holds the query that does it, so that the list and the detail cannot drift apart on
either the columns they select or the way they read a row back.
"""

from __future__ import annotations

from collections.abc import Sequence
from datetime import datetime
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Body, Path, Query, Response
from pydantic import ConfigDict, Field
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

from lnt_v5 import examples
from lnt_v5.auth import require_scope
from lnt_v5.db import EngineDep, reporting_violation
from lnt_v5.errors import ApiError, ErrorCode
from lnt_v5.patching import omit_defaults
from lnt_v5.querying import DEFAULT_LIMIT, Limit, Offset, search_condition, sort_order
from lnt_v5.responses import OffsetPage
from lnt_v5.routes.suites import SUITES_PATH
from lnt_v5.scopes import Scope
from lnt_v5.suites.entities import (
    Contradiction,
    EntityObject,
    FieldValue,
    MachineName,
    MachineObject,
    Tracked,
    create_or_reconcile,
    identifier,
    identifiers,
    location_of,
    rendered_fields,
    validate_fields,
)
from lnt_v5.suites.registry import RegistryDep, Suite
from lnt_v5.suites.schema import MachineField
from lnt_v5.suites.scope import (
    SUITE_SCHEMA_CHANGED,
    SuiteName,
    suite_responses,
    suite_scope,
)
from lnt_v5.suites.submission import SubmittedMachine
from lnt_v5.suites.tables import MACHINE_NAME_CONSTRAINT

MACHINES_PATH = f"{SUITES_PATH}/{{testsuite}}/machines"

router = APIRouter(prefix=MACHINES_PATH, tags=["Machines"])

# endpoints.md names these four and no others. A literal rather than a free string, so I8's document
# enumerates them and an unknown one is a 400 before the endpoint runs.
MachineSort = Literal["name", "-name", "last_run_at", "-last_run_at"]

# Every operation here reaches the suite's own tables, so every one can answer both of the failures
# `suite_scope` produces; each widens the wording with the cases it adds of its own.
NO_MACHINE = "The test suite or the machine doesn't exist."
NO_MACHINE_FILTERED = "The test suite, or the machine given in `machine`, doesn't exist."
_NAME_TAKEN = f"`duplicate`: a machine with this name already exists. {SUITE_SCHEMA_CHANGED}"

# The path segment naming a machine.
MachineKey = Annotated[str, Path(description="The name of the machine.")]

_CREATE_EXAMPLES = {
    "machine": {
        "summary": "A machine with its fields",
        "value": {
            "name": examples.OTHER_MACHINE,
            "tracked": True,
            "fields": examples.OTHER_MACHINE_VALUES,
        },
    }
}

_UPDATE_EXAMPLES = {
    "untrack": {
        "summary": "Stop tracking a machine",
        "value": {"tracked": False},
    },
    "fields": {
        "summary": "Set one field and clear another",
        "value": {"fields": {"os": "macOS 26.6 (25G5)", "sdk": None}},
    },
}

# The docstrings of the models and endpoints below are published, as the descriptions I8's document
# gives them, so they are written for API users.


# `tracked` and `fields` are redeclared without their defaults. I4 requires every documented key to
# be present in a response, and inheriting the request model's optionality would instead tell a
# generated client both may be absent.
class Machine(MachineObject):
    """A machine that benchmarks run on."""

    tracked: Tracked
    fields: dict[str, FieldValue] = Field(
        description=(
            "The machine's values for the fields defined in the suite's schema, keyed by field "
            "name. Every field is listed, with null for those that have no value."
        ),
        examples=[examples.MACHINE_VALUES],
    )
    last_run_at: datetime | None = Field(
        description="When the machine's most recent run was submitted. Null if it has no runs."
    )


# Every key is optional and the defaults below are never read, because the endpoint dumps this with
# `exclude_unset`. Their *types* are what carry meaning: neither `name` nor `tracked` is nullable,
# so sending either as null is a 400 rather than an instruction to clear it.
class MachineUpdate(EntityObject):
    """Changes to a machine. Only include what you want to change; this also applies to the keys
    of `fields`. Set a field to null to clear it. Set `name` to rename the machine. `name` and
    `tracked` can't be null."""

    model_config = ConfigDict(json_schema_extra=omit_defaults)

    name: MachineName = ""
    tracked: Tracked = True


class Machines:
    """The query every machine response is built from, and how to read one of its rows back.

    Public because a run submission creates machines too (O2), and the table and the 409 wording it
    needs are already here; `routes/runs.py` reaches `get_or_create` below rather than restating
    either.

    `last_run_at` is derived on read and never stored (D5): a stored copy would have to be
    recomputed whenever a run was deleted, and synchronized on submission. The LATERAL probe below
    is what D5 asks for -- the compound index on `{suite}.run(machine_id, submitted_at)` makes it a
    single-row backward index scan per machine, where `max(submitted_at) ... GROUP BY machine_id`
    would read every run in the suite to answer a question about a handful of machines.
    """

    def __init__(self, suite: Suite) -> None:
        self.suite = suite
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
        return machine_search(self.suite, term)

    def read(self, row: Row[Any]) -> Machine:
        # Not validated: the model's validators are the rules for what a request may write, and a
        # row stored some other way that breaks one still has to be served.
        return Machine.model_construct(
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
        return _missing(self.schema.name, name)

    def taken(self, name: str) -> str:
        return f"A machine named '{name}' already exists in test suite '{self.schema.name}'"

    def get_or_create(self, connection: Connection, submitted: SubmittedMachine) -> int:
        """The id of the machine a run submission names, creating it if it is not there (O2, O8).

        Not an endpoint of its own: `POST /machines` creates a machine and answers 409 for one that
        already exists, whereas a submission is expected to name the same machine on every run. The
        two share this reader for the table and the wording, and nothing else.

        `tracked` is written at creation and never compared afterwards -- O1 and O2 make it
        first-write-wins, so re-submitting it for an existing machine is ignored rather than being a
        mismatch. The declared fields are reconciled instead: a stored NULL is filled in, a stored
        value that agrees is left alone, and one that disagrees is refused.
        """
        return create_or_reconcile(
            connection,
            self.table.c.name,
            submitted.name,
            values={"tracked": submitted.tracked, **submitted.fields},
            matched=submitted.fields,
            contradiction=self._contradicted(submitted.name),
        )

    def _contradicted(self, name: str) -> Contradiction:
        """I4's `conflict` for a submitted field that disagrees with the stored one (O2).

        `conflict` rather than any of the other 409s: I4 gives it to a request that contradicts
        existing state in a way the more specific codes do not describe, and none of them describes
        machine metadata. The stored and submitted values are both in the message so that a
        submitter can fix its configuration without reading the database.
        """

        def error(key: str, stored: Any, submitted: Any) -> ApiError:
            return ApiError(
                ErrorCode.CONFLICT,
                f"Machine '{name}' in test suite '{self.schema.name}' already has "
                f"{key}={stored!r}, but this submission says {submitted!r}. A submission never "
                f"overwrites stored metadata; use PATCH to change it.",
            )

        return error


def _missing(testsuite: str, name: str) -> ApiError:
    """The 404 for a machine no suite holds, shared by the routes and by the `machine=` filter."""
    return ApiError(ErrorCode.NOT_FOUND, f"No machine named '{name}' in test suite '{testsuite}'")


def machine_search(suite: Suite, term: str) -> ColumnElement[bool]:
    """O4's machine predicate: the machine's name, or any searchable machine field.

    Here rather than inlined in `Machines.search` because O4 requires `GET /runs?search=` to be
    *the same* predicate, applied through the run's machine. Takes the suite rather than the table
    and the field list, so that the two callers cannot pass a matching pair of the wrong ones --
    sharing `search_condition` alone would still leave each list naming the columns it covers.
    """
    return search_condition(term, suite.tables.machine, ["name"], suite.schema.machine_fields)


def machine_id(connection: Connection, suite: Suite, name: str) -> int:
    """The id of the machine a `machine=` filter names, or I3's 404 for one that is not there.

    I3 makes an unknown `machine=` an error, unlike an unknown `commit=`, so every endpoint that
    offers the filter owes the same lookup and the same wording -- which is why this lives beside
    the 404 the machine routes themselves raise rather than being written out per endpoint.
    """
    machine = suite.tables.machine
    return identifier(
        connection, machine.c.name, name, lambda missed: _missing(suite.schema.name, missed)
    )


def machine_ids(connection: Connection, suite: Suite, names: Sequence[str]) -> dict[str, int]:
    """The ids of many machines at once, keyed by name, or the 404 for the first one absent.

    What a regression's indicators resolve through: each names a machine, and a batch of them would
    otherwise be one statement per indicator. The same lookup and the same wording as `machine_id`
    above, which is why it lives here too.
    """
    machine = suite.tables.machine
    return identifiers(
        connection, machine.c.name, names, lambda missed: _missing(suite.schema.name, missed)
    )


@router.get(
    "",
    dependencies=[require_scope(Scope.READ)],
    summary="List machines",
    responses=suite_responses(),
)
def list_machines(
    testsuite: SuiteName,
    engine: EngineDep,
    registry: RegistryDep,
    search: Annotated[
        str | None,
        Query(
            description=(
                "Only return machines whose name, or any searchable field, contains this text. "
                "Not case-sensitive."
            )
        ),
    ] = None,
    tracked: Annotated[
        bool | None,
        Query(
            description="Only return tracked machines (`true`) or untracked ones (`false`). "
            "Leave out to return both."
        ),
    ] = None,
    sort: Annotated[
        MachineSort,
        Query(
            description=(
                "Sort by name, or by the time of each machine's most recent run. Machines without "
                "runs always come last, and ties are sorted by name."
            )
        ),
    ] = "name",
    limit: Limit = DEFAULT_LIMIT,
    offset: Offset = 0,
) -> OffsetPage[Machine]:
    """The machines in the suite, one page at a time. To list a machine's runs, use
    `GET /api/suites/{testsuite}/runs?machine={name}`."""
    with engine.connect() as connection, suite_scope(registry, connection, testsuite) as suite:
        machines = Machines(suite)
        conditions: list[ColumnElement[bool]] = []
        if search is not None:
            conditions.append(machines.search(search))
        if tracked is not None:
            conditions.append(machines.table.c.tracked.is_(tracked))

        # I2: the count ignores `limit` and `offset`, and needs no `last_run_at`, so it is a count
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
    testsuite: SuiteName,
    body: Annotated[MachineObject, Body(openapi_examples=_CREATE_EXAMPLES)],
    engine: EngineDep,
    registry: RegistryDep,
    response: Response,
) -> Machine:
    """Create a machine before any run is submitted for it. The response's `Location` header
    points to the new machine.

    You don't need to do this before submitting runs: submitting a run creates its machine if it
    doesn't exist yet.
    """
    with engine.begin() as connection, suite_scope(registry, connection, testsuite) as suite:
        machines = Machines(suite)
        values = validate_fields(suite.schema, MachineField, body.fields)
        with reporting_violation(
            MACHINE_NAME_CONSTRAINT, ErrorCode.DUPLICATE, machines.taken(body.name)
        ):
            connection.execute(
                insert(machines.table).values(name=body.name, tracked=body.tracked, **values)
            )
        created = machines.one(connection, body.name)

    response.headers["Location"] = location_of(MACHINES_PATH, testsuite, body.name)
    return created


@router.get(
    "/{machine_name}",
    dependencies=[require_scope(Scope.READ)],
    summary="Get a machine",
    responses=suite_responses(not_found=NO_MACHINE),
)
def get_machine(
    testsuite: SuiteName, machine_name: MachineKey, engine: EngineDep, registry: RegistryDep
) -> Machine:
    """Get a machine."""
    with engine.connect() as connection, suite_scope(registry, connection, testsuite) as suite:
        return Machines(suite).one(connection, machine_name)


@router.patch(
    "/{machine_name}",
    dependencies=[require_scope(Scope.MANAGE)],
    summary="Update a machine",
    responses=suite_responses(not_found=NO_MACHINE, conflict=_NAME_TAKEN),
)
def update_machine(
    testsuite: SuiteName,
    machine_name: MachineKey,
    body: Annotated[MachineUpdate, Body(openapi_examples=_UPDATE_EXAMPLES)],
    engine: EngineDep,
    registry: RegistryDep,
) -> Machine:
    """Rename a machine, change whether it is tracked, or set or clear its fields.

    Only include what you want to change. If you change a field here, later run submissions that
    still send the old value are rejected with a 409 `conflict` until they are updated. If you
    rename a machine, later run submissions that still use the old name create a new machine.
    """
    with engine.begin() as connection, suite_scope(registry, connection, testsuite) as suite:
        machines = Machines(suite)
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
    responses=suite_responses(not_found=NO_MACHINE),
)
def delete_machine(
    testsuite: SuiteName, machine_name: MachineKey, engine: EngineDep, registry: RegistryDep
) -> None:
    """Delete a machine, along with its runs (and their samples and profiles) and the regression
    indicators that refer to it. Regressions left without indicators are kept."""
    # One statement: D5 gives `{suite}.run.machine_id` and `{suite}.regression_indicator.machine_id`
    # an `ON DELETE CASCADE`, and the runs take their samples and profiles with them in turn. A
    # regression left with no indicators keeps its title, bug, notes and commit, and an empty
    # indicator set is a legal state.
    with engine.begin() as connection, suite_scope(registry, connection, testsuite) as suite:
        machines = Machines(suite)
        removed = connection.execute(
            delete(machines.table).where(machines.table.c.name == machine_name)
        )
        if removed.rowcount == 0:
            raise machines.missing(machine_name)

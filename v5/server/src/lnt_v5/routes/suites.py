"""Test suite creation, inspection, evolution and deletion (endpoints.md, Test Suites).

A suite's schema is the whole document here: the body `POST /api/suites` accepts, the body a `GET`
returns, and what the `schema` table stores (D4). So one suite fetched from an instance can be
posted verbatim to another, and there are no standalone schema or metric-metadata endpoints.

Every write takes the suite's `schema` row lock first and derives what it is changing from that
read rather than from the registry (see registry.py), which is what makes two concurrent changes to
one suite serialize instead of overwriting each other. The uniform order -- row lock, then DDL --
is also what keeps a change and a delete from deadlocking.
"""

from __future__ import annotations

from typing import Annotated, Any

from fastapi import APIRouter, Query, Response
from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator
from sqlalchemy import Connection, delete, insert, update
from sqlalchemy.exc import DBAPIError, IntegrityError

from lnt_v5.auth import require_scope
from lnt_v5.db import EngineDep, is_duplicate_schema, is_lock_unavailable
from lnt_v5.db import unique_violation_constraint as violated
from lnt_v5.errors import ApiError, ErrorCode, ErrorEnvelope
from lnt_v5.responses import Items
from lnt_v5.scopes import Scope
from lnt_v5.suites import tables as suite_tables
from lnt_v5.suites.registry import (
    SCHEMA_NAME_CONSTRAINT,
    RegistryDep,
    bump,
    lock_timeout,
    locked_suite,
)
from lnt_v5.suites.schema import (
    CommitField,
    Entry,
    MachineField,
    Metric,
    Name,
    SuiteSchema,
)
from lnt_v5.tables import schema as schema_table

SUITES_PATH = "/api/suites"

router = APIRouter(prefix=SUITES_PATH, tags=["Test Suites"])

# endpoints.md requires this on any operation that destroys data. `bool` rather than a literal
# "true", so FastAPI documents it as a boolean and answers 400 for a value that is not one; that
# also means `1`, `yes` and `on` are accepted spellings, which is a deliberate widening.
Confirm = Annotated[
    bool,
    Query(description="Must be true. Required because this operation destroys data permanently."),
]

_NOT_FOUND = {"model": ErrorEnvelope, "description": "No suite has that name."}


# --------------------------------------------------------------------------------------------
# The PATCH body
# --------------------------------------------------------------------------------------------


class _EntryUpdate(BaseModel):
    """Presentation metadata to change on an entry that already exists (D2).

    Only the keys being changed are sent: one left out keeps its stored value, and one sent as null
    clears it. The three lists accept different keys (D4), so there is one of these per list rather
    than one carrying the union -- which would accept `bigger_is_better` on a machine field, the
    thing `Entry`'s `extra="forbid"` exists to prevent.

    Every key is optional, and the defaults below are never read: `_apply` dumps these with
    `exclude_unset`, so a key the request omitted is simply absent. Their *types* are what carry
    meaning -- the nullable ones can be cleared with an explicit null, and the booleans cannot,
    because D4 defaults those to false and so gives them no unset state to clear to. Sending
    `searchable: null` is a 400 rather than an ambiguity.
    """

    model_config = ConfigDict(extra="forbid")

    name: Name
    display_name: str | None = None

    @model_validator(mode="before")
    @classmethod
    def _reject_type_change(cls, data: Any) -> Any:
        # Before validation, so this wins over `extra="forbid"` and can say why. `type` is
        # deliberately not a field: declaring one only to reject it would put a property in R8's
        # document that the API refuses every time.
        if isinstance(data, dict) and "type" in data:
            raise ValueError(
                "an entry's 'type' cannot be changed in place, because the conversion is not "
                "always defined; remove the entry and add it again"
            )
        return data


class MetricUpdate(_EntryUpdate):
    unit: str | None = None
    unit_abbrev: str | None = None
    bigger_is_better: bool = False


class CommitFieldUpdate(_EntryUpdate):
    searchable: bool = False
    display: bool = False


class MachineFieldUpdate(_EntryUpdate):
    searchable: bool = False


class _Changes[E: Entry, U: _EntryUpdate](BaseModel):
    """What one list is asked to do. Absent lists default to empty, so every path iterates."""

    model_config = ConfigDict(extra="forbid")

    add: list[E] = Field(
        default_factory=list, description="Entries to add, in the format a schema declares."
    )
    update: list[U] = Field(
        default_factory=list, description="Presentation metadata to change on existing entries."
    )
    remove: list[Name] = Field(
        default_factory=list,
        description="Names to remove. Destroys every value stored for them.",
    )


class MetricChanges(_Changes[Metric, MetricUpdate]):
    pass


class CommitFieldChanges(_Changes[CommitField, CommitFieldUpdate]):
    pass


class MachineFieldChanges(_Changes[MachineField, MachineFieldUpdate]):
    pass


class SchemaPatch(BaseModel):
    """Add, update and/or remove entries in any of a suite's three lists (D2)."""

    model_config = ConfigDict(extra="forbid")

    metrics: MetricChanges = Field(default_factory=MetricChanges)
    commit_fields: CommitFieldChanges = Field(default_factory=CommitFieldChanges)
    machine_fields: MachineFieldChanges = Field(default_factory=MachineFieldChanges)

    def per_list(self) -> list[tuple[str, _Changes[Any, Any]]]:
        return [
            ("metrics", self.metrics),
            ("commit_fields", self.commit_fields),
            ("machine_fields", self.machine_fields),
        ]

    @property
    def removes_anything(self) -> bool:
        return any(changes.remove for _, changes in self.per_list())


def _apply(list_name: str, current: list[Any], changes: _Changes[Any, Any]) -> list[dict[str, Any]]:
    """One list after the request's operations, as plain dicts, in D2's terms.

    Dicts rather than entry models on purpose: they go back through `SuiteSchema.model_validate`,
    which revalidates every entry from scratch. Carrying models across would skip that -- pydantic
    does not revalidate an instance it is handed -- and an `update` could then set `searchable` on a
    non-text entry, which is exactly what full revalidation exists to catch.

    Order within the list is preserved and additions go on the end, because the entry order is what
    decides the column order of the suite's tables (D5) and clients see it.
    """
    targets = (
        [entry.name for entry in changes.add]
        + [entry.name for entry in changes.update]
        + changes.remove
    )
    for name in targets:
        if targets.count(name) > 1:
            # D2: the same field cannot be the target of more than one operation in a given query.
            # Counted with multiplicity, so a name repeated inside one list is caught too -- two
            # removes of one name would otherwise reach the second `DROP COLUMN` and fail there.
            raise ApiError(
                ErrorCode.INVALID_REQUEST,
                f"'{name}' is the target of more than one {list_name} operation in this request",
            )

    existing = {entry.name for entry in current}
    for entry in changes.add:
        if entry.name in existing:
            raise ApiError(
                ErrorCode.DUPLICATE, f"{list_name} already has an entry named '{entry.name}'"
            )
    for name in [entry.name for entry in changes.update] + changes.remove:
        if name not in existing:
            raise ApiError(ErrorCode.NOT_FOUND, f"{list_name} has no entry named '{name}'")

    # `exclude_unset`, so a key the request left out keeps its stored value while one sent as null
    # clears it -- the same convention as `PATCH /api/suites/{testsuite}/commits/{value}`.
    patches = {
        entry.name: entry.model_dump(exclude_unset=True, exclude={"name"})
        for entry in changes.update
    }
    removed = set(changes.remove)

    result = [
        {**entry.model_dump(), **patches.get(entry.name, {})}
        for entry in current
        if entry.name not in removed
    ]
    return result + [entry.model_dump() for entry in changes.add]


def _resulting_schema(current: SuiteSchema, body: SchemaPatch) -> SuiteSchema:
    """The schema the request asks for, validated in full (D2).

    Revalidated as a whole rather than per touched entry, which is what catches an `update` turning
    a non-text entry searchable, or a `display` arriving beside one that is already set. It also
    lets one request move `display` from one field to another, which incremental checking could not.

    The failure is translated here rather than left to the handler in `errors.py`: that one covers
    the framework's own request validation, and this `ValidationError` is raised inside the
    endpoint. Catching it narrowly also keeps it from swallowing an internal one -- a stored schema
    that will not parse is a 500, not the caller's fault.
    """
    try:
        return SuiteSchema.model_validate(
            {
                "name": current.name,
                "metrics": _apply("metrics", current.metrics, body.metrics),
                "commit_fields": _apply("commit_fields", current.commit_fields, body.commit_fields),
                "machine_fields": _apply(
                    "machine_fields", current.machine_fields, body.machine_fields
                ),
            }
        )
    except ValidationError as error:
        problems = "; ".join(
            f"{'.'.join(str(part) for part in problem['loc'])}: {problem['msg']}"
            for problem in error.errors()
        )
        raise ApiError(
            ErrorCode.INVALID_REQUEST, f"The resulting schema would be invalid: {problems}"
        ) from error


def normalized_json(schema: SuiteSchema) -> str:
    """The text D5 stores: the normalized schema, not the request body as submitted.

    One function so that what is written and what is compared can never be two spellings of the
    same idea.
    """
    return schema.model_dump_json()


def _require_confirmed(confirm: bool, what: str) -> None:
    if not confirm:
        raise ApiError(ErrorCode.INVALID_REQUEST, f"{what} Pass ?confirm=true to proceed.")


# --------------------------------------------------------------------------------------------
# Endpoints
# --------------------------------------------------------------------------------------------


@router.get("", dependencies=[require_scope(Scope.READ)], summary="List test suites")
def list_suites(engine: EngineDep, registry: RegistryDep) -> Items[SuiteSchema]:
    """Every suite on this instance, with its full schema, ordered by name.

    Schemas rather than names alone: suites are limited in number, and parts of the client need
    every suite's metric list up front (endpoints.md).
    """
    with engine.connect() as connection:
        suites = registry.fresh(connection)
    return Items(items=[suites[name].schema for name in sorted(suites)])


@router.post(
    "",
    status_code=201,
    dependencies=[require_scope(Scope.MANAGE)],
    summary="Create a test suite",
    responses={409: {"model": ErrorEnvelope, "description": "A suite with that name exists."}},
)
def create_suite(body: SuiteSchema, engine: EngineDep, response: Response) -> SuiteSchema:
    """Create a suite from a schema definition, and the tables that schema describes (D2, D5)."""
    try:
        with engine.begin() as connection:
            lock_timeout(connection)
            # The row first: it is the lock every writer of this suite contends on, so two callers
            # racing to create one name serialize here and the loser gets a clean 409 rather than a
            # half-built namespace. It is also the order the other two writes use.
            connection.execute(
                insert(schema_table).values(name=body.name, schema_json=normalized_json(body))
            )
            suite_tables.create(connection, suite_tables.build(body))
            bump(connection)
    except IntegrityError as error:
        if violated(error) != SCHEMA_NAME_CONSTRAINT:
            raise
        raise ApiError(
            ErrorCode.DUPLICATE, f"A test suite named '{body.name}' already exists"
        ) from error
    except DBAPIError as error:
        if is_duplicate_schema(error):
            raise ApiError(
                ErrorCode.CONFLICT,
                f"A database namespace named '{body.name}' already exists, but no test suite does",
            ) from error
        if is_lock_unavailable(error):
            raise _busy(body.name) from error
        raise

    response.headers["Location"] = f"{SUITES_PATH}/{body.name}"
    return body


@router.get(
    "/{name}",
    dependencies=[require_scope(Scope.READ)],
    summary="Get a test suite",
    responses={404: _NOT_FOUND},
)
def get_suite(name: str, engine: EngineDep, registry: RegistryDep) -> SuiteSchema:
    """A suite's normalized schema -- the same document `POST /api/suites` accepts."""
    with engine.connect() as connection:
        return registry.resolve(connection, name).schema


@router.patch(
    "/{name}/schema",
    dependencies=[require_scope(Scope.MANAGE)],
    summary="Evolve a test suite's schema",
    responses={
        404: {
            "model": ErrorEnvelope,
            "description": "No suite has that name, or an entry to update or remove is not there.",
        },
        409: {"model": ErrorEnvelope, "description": "An entry to add is already there."},
    },
)
def patch_schema(
    name: str, body: SchemaPatch, engine: EngineDep, confirm: Confirm = False
) -> SuiteSchema:
    """Add, update and/or remove entries in a suite's three lists (D2).

    Atomic: the column changes, the stored schema and the version bump share one transaction, so the
    request applies entirely or not at all.
    """
    try:
        with engine.begin() as connection:
            lock_timeout(connection)
            current = locked_suite(connection, name)
            if body.removes_anything:
                _require_confirmed(
                    confirm, "Removing a schema entry destroys every value stored for it."
                )
            resulting = _resulting_schema(current, body)
            _rewrite(connection, name, current, resulting)
    except DBAPIError as error:
        if is_lock_unavailable(error):
            raise _busy(name) from error
        raise
    return resulting


@router.delete(
    "/{name}",
    status_code=204,
    dependencies=[require_scope(Scope.MANAGE)],
    summary="Delete a test suite",
    responses={404: _NOT_FOUND},
)
def delete_suite(name: str, engine: EngineDep, confirm: Confirm = False) -> None:
    """Delete a suite and every machine, run, commit, sample and regression in it."""
    try:
        with engine.begin() as connection:
            lock_timeout(connection)
            locked_suite(connection, name)
            _require_confirmed(confirm, f"Deleting '{name}' permanently destroys all of its data.")
            connection.execute(delete(schema_table).where(schema_table.c.name == name))
            suite_tables.drop(connection, name)
            bump(connection)
    except DBAPIError as error:
        if is_lock_unavailable(error):
            raise _busy(name) from error
        raise


def _rewrite(
    connection: Connection, name: str, current: SuiteSchema, resulting: SuiteSchema
) -> None:
    """Bring the suite's columns and its stored schema to `resulting`.

    Nothing at all when the schema is unchanged -- an empty or no-op request should not make every
    other worker reload for a change that did not happen.
    """
    text = normalized_json(resulting)
    if text == normalized_json(current):
        return

    # Built from the resulting schema, never from the registry's tables: appending to those would
    # mutate an object other request threads are compiling queries against.
    before = suite_tables.build(current)
    after = suite_tables.build(resulting)
    for table_name, added, removed in _column_changes(current, resulting):
        for column in added:
            suite_tables.add_column(connection, getattr(after, table_name).c[column])
        for column in removed:
            suite_tables.drop_column(connection, getattr(before, table_name), column)

    connection.execute(
        update(schema_table).where(schema_table.c.name == name).values(schema_json=text)
    )
    bump(connection)


def _column_changes(
    current: SuiteSchema, resulting: SuiteSchema
) -> list[tuple[str, list[str], list[str]]]:
    """Which columns each table gains and loses. An update changes no column, only metadata."""
    changes = []
    for table_name, before, after in (
        ("sample", current.metrics, resulting.metrics),
        ("commit", current.commit_fields, resulting.commit_fields),
        ("machine", current.machine_fields, resulting.machine_fields),
    ):
        was = {entry.name for entry in before}
        now = {entry.name for entry in after}
        changes.append((table_name, [n for n in now if n not in was], sorted(was - now)))
    return changes


def _busy(name: str) -> ApiError:
    return ApiError(
        ErrorCode.CONFLICT,
        f"Test suite '{name}' is busy: the change could not take the locks it needs. Retry.",
    )

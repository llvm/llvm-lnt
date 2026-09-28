"""Changing a suite's schema after it exists (D2).

The patch document and what applying it means. It lives beside the schema model rather than in the
routes, for the same reason `SuiteSchema` does: it is a wire document with rules of its own, and the
endpoint that carries it should be four lines.

The three lists are described once, in `LISTS`, and everything else reads that: which entry model
validates an addition, which update model validates a change, and -- through the entry model's own
`TABLE` -- which of the suite's tables gains or loses a column. Spelling that correspondence out per
operation is how a fourth list would end up half-supported.
"""

from __future__ import annotations

from collections.abc import Iterator, Sequence
from dataclasses import dataclass
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator
from sqlalchemy import Connection, update

from lnt_v5.errors import ApiError, ErrorCode, validation_problems
from lnt_v5.suites import tables as suite_tables
from lnt_v5.suites.schema import CommitField, Entry, MachineField, Metric, Name, SuiteSchema
from lnt_v5.suites.store import bump, normalized_json
from lnt_v5.tables import schema as schema_table


class _EntryUpdate(BaseModel):
    """Presentation metadata to change on an entry that already exists (D2).

    Only the keys being changed are sent. Every key is optional and the defaults below are never
    read, because `_apply` dumps these with `exclude_unset`: a key the request omitted is simply
    absent. Their *types* are what carry meaning. The nullable ones can be cleared with an explicit
    null; the booleans cannot, because D4 normalizes those to false rather than to null and so gives
    them no unset state to clear to, which makes `searchable: null` a 400 rather than an ambiguity.
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
    """What one list is asked to do. Absent lists default to empty, so every path iterates.

    Generic over its two entry models, with a named subclass per list below rather than the
    parameters spelled out at each use: an inline `_Changes[Metric, MetricUpdate]` names the OpenAPI
    component `_Changes_Metric_MetricUpdate_`, a mangled private name in R8's public document.
    """

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


@dataclass(frozen=True)
class _List:
    """One of a schema's three lists, and what the rest of this module needs to know about it.

    Everything is read off the entry model: `LIST` names the field on both `SuiteSchema` and
    `SchemaPatch`, which carry the same three, and `TABLE` names the table the list extends. So the
    correspondence lives with the entries rather than being restated here.
    """

    entry: type[Entry]

    @property
    def attribute(self) -> str:
        return self.entry.LIST

    @property
    def table(self) -> str:
        return self.entry.TABLE


LISTS = (_List(Metric), _List(CommitField), _List(MachineField))


def _changes(patch: SchemaPatch, of: _List) -> _Changes[Any, Any]:
    changes: _Changes[Any, Any] = getattr(patch, of.attribute)
    return changes


def removes_anything(patch: SchemaPatch) -> bool:
    """Whether the request destroys any stored value, and so needs confirming."""
    return any(_changes(patch, of).remove for of in LISTS)


def _apply(
    of: _List, current: Sequence[Entry], changes: _Changes[Any, Any]
) -> list[dict[str, Any]]:
    """One list after the request's operations, as plain dicts, in D2's terms.

    Dicts rather than entry models on purpose: they go back through `SuiteSchema.model_validate`,
    which revalidates every entry from scratch. Carrying models across would skip that -- pydantic
    does not revalidate an instance it is handed -- and an `update` could then set `searchable` on a
    non-text entry, which is exactly what full revalidation exists to catch.

    Order within the list is preserved and additions go on the end, because the entry order is what
    decides the column order of the suite's tables (D5) and clients see it.
    """
    seen: set[str] = set()
    for name in (
        [entry.name for entry in changes.add]
        + [entry.name for entry in changes.update]
        + changes.remove
    ):
        if name in seen:
            # D2: the same field cannot be the target of more than one operation in a given query.
            # Repeats within one operation's own list count too -- two removes of one name would
            # otherwise reach the second `DROP COLUMN` and fail there rather than as a 400.
            raise ApiError(
                ErrorCode.INVALID_REQUEST,
                f"'{name}' is the target of more than one {of.attribute} operation in this request",
            )
        seen.add(name)

    existing = {entry.name for entry in current}
    for entry in changes.add:
        if entry.name in existing:
            raise ApiError(
                ErrorCode.DUPLICATE, f"{of.attribute} already has an entry named '{entry.name}'"
            )
    for name in [entry.name for entry in changes.update] + changes.remove:
        if name not in existing:
            raise ApiError(ErrorCode.NOT_FOUND, f"{of.attribute} has no entry named '{name}'")

    # `exclude_unset`, so a key the request left out keeps its stored value while one sent as null
    # clears it -- the same convention as `PATCH /api/suites/{testsuite}/commits/{value}`.
    patches = {
        entry.name: entry.model_dump(exclude_unset=True, exclude={"name"})
        for entry in changes.update
    }
    removed = set(changes.remove)

    kept = [
        {**entry.model_dump(), **patches.get(entry.name, {})}
        for entry in current
        if entry.name not in removed
    ]
    return kept + [entry.model_dump() for entry in changes.add]


def resulting_schema(current: SuiteSchema, patch: SchemaPatch) -> SuiteSchema:
    """The schema the request asks for, validated in full (D2).

    Revalidated as a whole rather than per touched entry, which is what catches an `update` making
    a non-text entry searchable, or a `display` arriving beside one that is already set. It also
    lets one request move `display` from one field to another, which incremental checking could not.

    The failure is translated here rather than left to the handler in `errors.py`: that one covers
    what the framework validates, and this is raised while handling a request that already parsed.
    Catching it narrowly also keeps it from swallowing an internal one -- a stored schema that will
    not parse is a 500, not the caller's fault.
    """
    document: dict[str, Any] = {"name": current.name}
    for of in LISTS:
        document[of.attribute] = _apply(of, getattr(current, of.attribute), _changes(patch, of))
    try:
        return SuiteSchema.model_validate(document)
    except ValidationError as error:
        raise ApiError(
            ErrorCode.INVALID_REQUEST,
            f"The resulting schema would be invalid: {validation_problems(error)}",
        ) from error


def _column_changes(
    current: SuiteSchema, resulting: SuiteSchema
) -> Iterator[tuple[_List, list[str], list[str]]]:
    """Which columns each table gains and loses. An update changes no column, only metadata."""
    for of in LISTS:
        was = {entry.name for entry in getattr(current, of.attribute)}
        now = [entry.name for entry in getattr(resulting, of.attribute)]
        yield of, [name for name in now if name not in was], sorted(was - set(now))


def apply(connection: Connection, name: str, current: SuiteSchema, resulting: SuiteSchema) -> None:
    """Bring the suite's columns and its stored schema to `resulting`.

    Nothing at all when the schema is unchanged -- an empty or no-op request should not make every
    other worker reload for a change that did not happen.
    """
    if resulting == current:
        return

    changes = list(_column_changes(current, resulting))
    # Built from the schemas rather than taken from the registry, whose tables other request threads
    # are concurrently compiling queries against. Lazily, because an update-only change touches no
    # column and would otherwise pay for both.
    before = suite_tables.build(current) if any(removed for _, _, removed in changes) else None
    after = suite_tables.build(resulting) if any(added for _, added, _ in changes) else None

    for of, added, removed in changes:
        for column in added:
            assert after is not None
            suite_tables.add_column(connection, getattr(after, of.table).c[column])
        for column in removed:
            assert before is not None
            suite_tables.drop_column(connection, getattr(before, of.table), column)

    connection.execute(
        update(schema_table)
        .where(schema_table.c.name == name)
        .values(schema_json=normalized_json(resulting))
    )
    bump(connection)

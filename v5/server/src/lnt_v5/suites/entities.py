"""D7's entity object, and the `fields` dict of schema-declared metadata it carries.

Machine and Commit are the two entities that carry declared metadata, and both are written the same
way on every path: inline in a run submission, at explicit creation, and by PATCH. This module holds
what those paths share -- the shape of the object, the JSON representation D3 gives each declared
type, and the step that turns a submitted `fields` dict into column values or a 400.

Declared metadata lives in a nested dict of its own rather than flattened onto the entity (R4). That
is what keeps a field from ever colliding with an identity or built-in key, and what makes the
object a submission nests identical to the one the entity's own creation endpoint accepts.

R1's rule about identity attributes lives here too -- the validator that refuses a natural key no
URL could address, and the function that puts one into a URL -- because both are properties of an
entity's identity rather than of any one endpoint's routing.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from datetime import UTC, datetime
from typing import Annotated, Any
from urllib.parse import quote

from pydantic import (
    AfterValidator,
    BaseModel,
    BeforeValidator,
    ConfigDict,
    Field,
    Strict,
    TypeAdapter,
    ValidationError,
)
from sqlalchemy import Row, Table

from lnt_v5.errors import ApiError, ErrorCode, validation_problems
from lnt_v5.suites.schema import AttributeType, Entry, SuiteSchema

# D3's JSON representation of each declared type, as the one type a `fields` value may have. Strict
# on each member, so that the union cannot quietly reshape a value on its way in: `true` is not an
# integer, and `"5"` is not one either. R4 is explicit that these are never stringified, and
# accepting a stringified number here would be the first step towards storing one.
#
# `datetime` is in the union for the way out rather than the way in -- a timestamp arrives as a
# string (D3) and is parsed below, but comes back from the database as a datetime.
FieldValue = (
    Annotated[int, Strict()]
    | Annotated[float, Strict()]
    | Annotated[str, Strict()]
    | datetime
    | None
)


def _iso_8601(value: Any) -> Any:
    """Parse the string form D3 gives a `datetime`, and accept nothing else.

    Parsed here rather than left to pydantic, which reads a bare number -- and a *string* holding
    one -- as a Unix timestamp. That is not a representation D3 offers, and it silently turns a
    mistyped `integer` value into a date in 1970: `"3"` would become 1970-01-01T00:00:03Z rather
    than the 400 D3 asks for. `fromisoformat` accepts the ISO 8601 forms and nothing else.
    """
    if not isinstance(value, str):
        raise ValueError("expected an ISO 8601 timestamp string")
    try:
        return datetime.fromisoformat(value)
    except ValueError as error:
        raise ValueError("expected an ISO 8601 timestamp string") from error


def _whole_number(value: Any) -> Any:
    """Accept `8.0` where an `integer` is declared, but not `8.5`.

    JSON has a single number type, so a producer that serializes through a float -- which
    JavaScript and plenty of report generators do -- writes an integer as `8.0`. Reading it as 8
    loses nothing, whereas `8.5` would have to be rounded and is a mistake worth reporting (D3).
    `True` is not a float, so it still reaches the strict validator that rejects it.
    """
    return int(value) if isinstance(value, float) and value.is_integer() else value


def _utc(value: datetime) -> datetime:
    """D5 stores UTC. A timestamp sent without an offset is read as UTC rather than rejected."""
    return value.astimezone(UTC) if value.tzinfo is not None else value.replace(tzinfo=UTC)


# D3 maps `integer` to a PostgreSQL INTEGER, which is 32 bits wide. Without this, a value outside
# that range passes validation and fails in the database with a range error -- a `DataError` rather
# than an integrity failure, so nothing attributes it and the caller gets a 500 for a value it
# supplied. R4 makes that an `invalid_request`, and stating the bound here also puts it in R8's
# document.
INT32_MIN = -(2**31)
INT32_MAX = 2**31 - 1

# D3's `integer`, as a reusable annotation: strict, so `"5"` and `true` are not integers, but
# reading `8.0` as 8 because JSON has a single number type and a producer serializing through a
# float writes an integer that way. Exported because the built-in integer attributes an entity
# carries beside `fields` -- a commit's `ordinal` -- follow the same rule as a declared one (D7).
IntegerValue = Annotated[
    int, BeforeValidator(_whole_number), Strict(), Field(ge=INT32_MIN, le=INT32_MAX)
]

# The same for a built-in boolean -- a machine's `tracked` -- so that `"true"` and `1` are rejected
# rather than read as booleans, matching how D3 treats every other value on the wire.
BooleanValue = Annotated[bool, Strict()]


_ADAPTERS: dict[AttributeType, TypeAdapter[Any]] = {
    AttributeType.REAL: TypeAdapter(Annotated[float, Strict()]),
    AttributeType.INTEGER: TypeAdapter(IntegerValue),
    AttributeType.TEXT: TypeAdapter(Annotated[str, Strict()]),
    AttributeType.DATETIME: TypeAdapter(
        Annotated[datetime, BeforeValidator(_iso_8601), AfterValidator(_utc)]
    ),
}


def addressable(value: str) -> str:
    """R1: a natural key has to survive being one segment of the URL that addresses the entity.

    A key containing `/`, or equal to `.` or `..`, does not. A server decodes `%2F` back to a
    separator before routing and normalizes a relative segment away long before the request
    arrives, so such a key would name an entity no URL can reach -- and the `Location` header
    handed back at creation would 404. Rejected where the entity is created rather than papered
    over where it is addressed.
    """
    if "/" in value or value in {".", ".."}:
        raise ValueError(
            "must be usable as a URL path segment: it may not contain '/', and may not be "
            "'.' or '..'"
        )
    return value


# What an entity's identity attribute is made of, beyond whatever length its own column allows.
Addressable = AfterValidator(addressable)


def location_of(path: str, testsuite: str, key: str) -> str:
    """Where a `POST` says the entity it created can be read back (R1).

    The counterpart to `addressable` above: that rule is what guarantees a natural key can be one
    segment of a URL, and this is what puts it there. `safe=''` on both segments is the part a
    hand-written copy gets wrong -- `quote` leaves `/` alone by default, which would turn a key
    into two path segments.
    """
    return f"{path.format(testsuite=quote(testsuite, safe=''))}/{quote(key, safe='')}"


class EntityObject(BaseModel):
    """What every write path accepts for an entity carrying declared metadata (D7).

    Subclassed rather than used directly: each entity adds its identity attribute and its built-in
    ones beside `fields`. The values inside `fields` are typed against the *suite's* schema, which
    no static model can describe, so this validates their shape and `validate_fields` does the rest.
    """

    model_config = ConfigDict(extra="forbid")

    fields: dict[str, FieldValue] = Field(
        default_factory=dict,
        description=(
            "Metadata declared by this test suite's schema, keyed by field name. "
            "A key the schema does not declare is rejected."
        ),
    )


def validate_fields(
    schema: SuiteSchema, entry: type[Entry], submitted: Mapping[str, Any]
) -> dict[str, Any]:
    """The column values a submitted `fields` dict stands for, or a 400 (D7).

    Takes the entry *class* rather than the list itself, and reads the list off the schema through
    `Entry.LIST`. A caller writes `validate_fields(schema, MachineField, ...)` and cannot hand one
    list the other's name -- which is a real hazard for run submission, the one handler that
    validates `machine_fields` and `commit_fields` in the same request.

    Every key must be declared in the suite's schema: neither entity has a catch-all blob, so a key
    that is not there has nowhere to go, and storing it silently would leave the submitter believing
    it had. Declaring a new field is a schema change, not something a write can do implicitly.

    An explicit `null` is kept rather than dropped, so that a PATCH can clear a stored value.
    """
    declared = {item.name: item for item in declared_entries(schema, entry)}
    values: dict[str, Any] = {}
    for key, value in submitted.items():
        found = declared.get(key)
        if found is None:
            raise ApiError(
                ErrorCode.INVALID_REQUEST,
                f"'{key}' is not declared in this test suite's {entry.LIST}; "
                f"declared: {', '.join(sorted(declared)) or 'nothing'}",
            )
        if value is None:
            values[key] = None
            continue
        try:
            values[key] = _ADAPTERS[found.type].validate_python(value)
        except ValidationError as error:
            raise ApiError(
                ErrorCode.INVALID_REQUEST,
                f"'{key}' is declared '{found.type.value}' in this test suite's {entry.LIST}: "
                f"{validation_problems(error)}",
            ) from error
    return values


def declared_entries(schema: SuiteSchema, entry: type[Entry]) -> Sequence[Entry]:
    """The list of a schema that holds entries of this class, named by `Entry.LIST`."""
    entries: Sequence[Entry] = getattr(schema, entry.LIST)
    return entries


def rendered_fields(entries: Sequence[Entry], table: Table, row: Row[Any]) -> dict[str, FieldValue]:
    """Every field the suite declares, `null` where this entity has no value (R4).

    The whole declared set rather than only what is populated, so that a client rendering a column
    per field does not have to discover which keys a given row happens to carry. A sample's
    `metrics` is the stated exception (see endpoints.md, Samples).

    Read by column object rather than by name: a field may legally be called `last_run_at`, which
    the machine list also selects under that name as a derived value.
    """
    return {entry.name: row._mapping[table.c[entry.name]] for entry in entries}

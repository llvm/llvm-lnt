"""D7's entity objects, and the `fields` dict of schema-declared metadata they carry.

Machine and Commit are the two entities that carry declared metadata, and both are written the same
way on every path: inline in a run submission, at explicit creation, and by PATCH. This module holds
what those paths share -- the shape of the objects, the JSON representation D3 gives each declared
type, and the step that turns a submitted `fields` dict into column values or a 400.

`MachineObject` and `CommitObject` live here rather than beside their own endpoints because a run
submission nests both (D6), and the layering only runs one way: `routes/` imports `suites/`, never
the reverse. The *response* models built on them stay with their endpoints, which is where the keys
they add -- a machine's derived `last_run_at`, a commit's neighbours -- are specified.

Declared metadata lives in a nested dict of its own rather than flattened onto the entity (R4). That
is what keeps a field from ever colliding with an identity or built-in key, and what makes the
object a submission nests identical to the one the entity's own creation endpoint accepts.

R1's rule about identity attributes lives here too -- the validator that refuses a natural key no
URL could address, and the function that puts one into a URL -- because both are properties of an
entity's identity rather than of any one endpoint's routing.

`reconcile` is here for the same reason the objects are: D7's rule for matching a submission against
a record that already exists is one rule, stated once, and applies identically to a machine's fields
and to a commit's fields and ordinal. What each entity keeps is the wording of the rejection and the
R4 code it carries. `create_or_reconcile` is that rule wired to D13's get-or-create, which is the
whole of the procedure a run submission runs for both entities.
"""

from __future__ import annotations

from collections.abc import Callable, Collection, Mapping, Sequence
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
    StringConstraints,
    TypeAdapter,
    ValidationError,
)
from sqlalchemy import Column, Connection, Row, Table, select, update

from lnt_v5.errors import ApiError, ErrorCode, validation_problems
from lnt_v5.suites import concurrency
from lnt_v5.suites.schema import AttributeType, Entry, SuiteSchema
from lnt_v5.suites.tables import NAME_LENGTH

# D3's JSON representation of each declared type, as the one type a declared value may have. Strict
# on each member, so that the union cannot quietly reshape a value on its way in: `true` is not an
# integer, and `"5"` is not one either. R4 is explicit that these are never stringified, and
# accepting a stringified number here would be the first step towards storing one.
#
# `datetime` is in the union for the way out rather than the way in -- a timestamp arrives as a
# string (D3) and is parsed below, but comes back from the database as a datetime.
DeclaredValue = (
    Annotated[int, Strict()] | Annotated[float, Strict()] | Annotated[str, Strict()] | datetime
)

# The same, for a `fields` dict, where R4 requires a `null` for every declared field the entity has
# no value for. A sample's `metrics` is the stated exception -- it carries only the metrics that
# have a value -- so it uses `DeclaredValue` above and can never render a null.
FieldValue = DeclaredValue | None


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


def utc(value: datetime) -> datetime:
    """D5 stores UTC. A timestamp sent without an offset is read as UTC rather than rejected.

    Shared with the `after=`/`before=` filters (R3), which compare against a `timestamptz` column
    and so must not hand PostgreSQL a naive value for the session's time zone to interpret.
    """
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

# D3's `real`. `allow_inf_nan=False` is what keeps the type honest in both directions: JSON has no
# literal for `NaN` or `Infinity`, but Python's parser -- which is what reads a request body --
# accepts all three, and `double precision` stores them, so one would be accepted here and then come
# back as `null`, since that is the only thing JSON serialization can do with it. A value that
# cannot survive the round trip is a bad request rather than one silently turned into "no value".
RealValue = Annotated[float, Strict(), Field(allow_inf_nan=False)]

# `integer` needs no such bound: a non-finite float has no fractional-free form, so `_whole_number`
# leaves it a float and the strict validator rejects it for not being an integer.

# The one character no string the API accepts may contain. PostgreSQL stores neither a `text` value
# nor a `jsonb` one holding it, and says so with a `DataError` -- not an integrity failure and not
# an undefined relation, so nothing attributes it and the caller gets a 500 for a value it supplied.
NUL = "\x00"


def storable(value: str) -> str:
    """D3: refuse a string the stored representation cannot hold, rather than let it fail below.

    The sibling of `RealValue`'s ban on `NaN` and of `IntegerValue`'s 32-bit bound: each is a value
    JSON will happily carry to a server that cannot store it, and D3's rule is that the caller
    hears 400 rather than 500. Applied to every caller-supplied string -- a declared `text` value, a
    machine's name, a commit's value, a test's name, a commit's tag -- because the failure is the
    column's rather than any one endpoint's, and a per-endpoint check is one endpoint away from
    being forgotten. `run_parameters` gets the same rule by a walk of its own, since it has no
    declared shape to hang a validator on (see `suites/submission.py`).
    """
    if NUL in value:
        raise ValueError("must not contain a NUL character (U+0000), which cannot be stored")
    return value


# What every caller-supplied string is, beyond whatever length and shape its own use allows.
Storable = AfterValidator(storable)

# The identity of an entity a request names but does not create -- an indicator's machine and test,
# a `test=` or `commit=` in a time-series body. Deliberately unconstrained in length and shape: a
# value no machine, test or commit could possibly have still names none, which endpoints.md answers
# with a 404 (or, for a commit filter, an empty result) rather than a 400. `Storable` is the one
# exception, because a NUL cannot even be compared against a stored value -- PostgreSQL refuses it
# as a parameter (D3).
Named = Annotated[str, Storable]

# D3's `datetime`, as a reusable annotation: an ISO 8601 string and nothing else, normalized to
# UTC. Exported because a timestamp on the wire is one thing wherever it appears -- a declared
# field value, and R3's `after=`/`before=` bounds, which would otherwise read `?after=1700000000`
# as a Unix epoch exactly as D3 forbids.
DatetimeValue = Annotated[datetime, BeforeValidator(_iso_8601), AfterValidator(utc)]

_ADAPTERS: dict[AttributeType, TypeAdapter[Any]] = {
    AttributeType.REAL: TypeAdapter(RealValue),
    AttributeType.INTEGER: TypeAdapter(IntegerValue),
    AttributeType.TEXT: TypeAdapter(Annotated[str, Strict(), Storable]),
    AttributeType.DATETIME: TypeAdapter(DatetimeValue),
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

# A UUID as it arrives in a path segment, for the three entities addressed by one (R1). Only the
# lowercasing is shared behaviour: every UUID is stored lowercased, so every lookup has to be. The
# format is deliberately *not* constrained -- a segment that is not a UUID at all passes through
# unchanged and simply matches nothing, which is the 404 endpoints.md asks for. It names no entity
# rather than being a malformed request, and the two endpoint families that take one must not
# diverge on that.
UuidPath = Annotated[str, AfterValidator(str.lower)]


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


MachineName = Annotated[
    str,
    StringConstraints(min_length=1, max_length=NAME_LENGTH),
    Addressable,
    Storable,
    Field(
        description=(
            "Identifies the machine within its test suite. It appears in the URL that addresses "
            "the machine, so it may not contain '/' and may not be '.' or '..' (R1)."
        )
    ),
]

Tracked = Annotated[
    BooleanValue,
    Field(
        description=(
            "Whether the machine takes part in automatic machine selection. An untracked machine "
            "stays fully addressable everywhere a machine is chosen deliberately."
        )
    ),
]

CommitValue = Annotated[
    str,
    StringConstraints(min_length=1, max_length=NAME_LENGTH),
    Addressable,
    Storable,
    Field(
        description=(
            "Identifies the commit within its test suite -- a Git SHA, a version number, or an "
            "ad-hoc label. It appears in the URL that addresses the commit, so it may not contain "
            "'/' and may not be '.' or '..' (R1). It is immutable: commits cannot be renamed."
        )
    ),
]

Ordinal = Annotated[
    IntegerValue,
    Field(
        description=(
            "Places the commit in the suite's total order, and so in every time series. Unique "
            "within the suite, and never inferred from the commit value even when that value is "
            "numeric. Null means unordered."
        )
    ),
]


class MachineObject(EntityObject):
    """D7's entity object for a machine, as every write path accepts it."""

    name: MachineName
    tracked: Tracked = True


class CommitObject(EntityObject):
    """D7's entity object for a commit, as every write path that creates one accepts it.

    `tag` is deliberately absent: it is an editorial label applied after the fact, which D7 makes
    settable only through PATCH. `extra="forbid"` is what turns sending one here into a 400 rather
    than into a value silently dropped.
    """

    value: CommitValue
    ordinal: Ordinal | None = None


def validate_value(entry: Entry, value: Any) -> Any:
    """The column value one submitted value stands for, typed per D3, or a 400.

    Split out of `validate_fields` below because a metric value follows exactly the same rules as a
    declared field's, so D3's typing and the wording of its failure exist once for both. The entry
    names itself and its list in the message, which is what tells a submitter whether the `os` it
    got wrong was the machine field or the metric.

    A null is not handled here: what it means depends on the caller (see `validate_fields` and
    `suites/submission.py`), so each decides before reaching this.
    """
    try:
        return _ADAPTERS[entry.type].validate_python(value)
    except ValidationError as error:
        raise ApiError(
            ErrorCode.INVALID_REQUEST,
            f"'{entry.name}' is declared '{entry.type.value}' in this test suite's {entry.LIST}: "
            f"{validation_problems(error)}",
        ) from error


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

    An explicit `null` is kept rather than dropped, so that a PATCH can clear a stored value. A run
    submission cannot clear anything and drops them again; see `suites/submission.py`.
    """
    declared = declared_by_name(schema, entry)
    values: dict[str, Any] = {}
    for key, value in submitted.items():
        found = declared.get(key)
        if found is None:
            raise undeclared(key, entry, declared)
        values[key] = None if value is None else validate_value(found, value)
    return values


# The 409 an entity answers when a submitted value contradicts the one it already holds, built from
# the key, the stored value and the submitted one. A callback rather than a return value because the
# code and the wording are the entity's -- R4 gives a contradicted field `conflict` and a
# contradicted ordinal `ordinal_conflict` -- while the rule that decides *whether* there is a
# contradiction is D7's and is the same for both.
Contradiction = Callable[[str, Any, Any], ApiError]


def reconcile(
    stored: Mapping[str, Any], submitted: Mapping[str, Any], contradiction: Contradiction
) -> dict[str, Any]:
    """D7's match between a submission and the record it names, as the values still to write.

    Only what the submission actually sends is compared: `submitted` holds the keys that carry a
    value, an explicit null having already been dropped as "no value submitted" (D6). A key the
    submission omits is not compared at all, so its stored value is left alone and can never cause a
    rejection -- which is what lets submitters sending different subsets of a record's metadata
    coexist, and what keeps a field introduced by a schema change from breaking producers that do
    not send it yet.

    Each key that is sent then falls into one of three cases:

    - the stored value is NULL, so the submission fills it in and it comes back in the result;
    - the stored value equals the submitted one, so there is nothing to do;
    - the stored value is something else, which is a contradiction and never an overwrite. Stored
      metadata is only ever changed by PATCH (D7).

    `tracked` is not passed here by anyone: D7 excludes it from the match entirely and makes it
    first-write-wins, because it is a policy flag operators are expected to change rather than a
    fact about the machine. A commit's `ordinal` *is* passed, because D7 has it match like a field
    does -- set when unset, rejected when it contradicts.
    """
    fill: dict[str, Any] = {}
    for key, value in submitted.items():
        held = stored[key]
        if held is None:
            fill[key] = value
        elif held != value:
            raise contradiction(key, held, value)
    return fill


def declared_entries[EntryT: Entry](schema: SuiteSchema, entry: type[EntryT]) -> Sequence[EntryT]:
    """The list of a schema that holds entries of this class, named by `Entry.LIST`.

    Generic in the entry class so that a caller asking for `Metric` gets metrics back rather than
    bare `Entry`s it would have to narrow again.
    """
    entries: Sequence[EntryT] = getattr(schema, entry.LIST)
    return entries


def declared_by_name[EntryT: Entry](schema: SuiteSchema, entry: type[EntryT]) -> dict[str, EntryT]:
    """One of a schema's declared lists as a lookup, which is how every submitted key is resolved.

    A function rather than something each caller writes out, because a caller that builds it per
    item instead of once has turned reading a payload into work proportional to the schema times
    the payload -- which is exactly what a run submission naming tens of thousands of tests does.
    """
    return {item.name: item for item in declared_entries(schema, entry)}


def declared_entry[EntryT: Entry](schema: SuiteSchema, entry: type[EntryT], name: str) -> EntryT:
    """The declared entry of this name, or the 400 for one the schema does not declare.

    What a request naming an entry resolves through -- `GET /tests?metric=`, and the time-series
    endpoints that take a metric as their subject. R3 makes an unknown metric a 400 rather than the
    404 an unknown machine or test gets, and the distinction is not arbitrary: an entry is a column
    the schema declares rather than a row the suite holds, so naming one that is not there is a
    request that could never be answered. Returns the entry rather than the name, because a caller
    that needs more than membership -- a metric's declared type, say -- would otherwise look it up
    again.
    """
    declared = declared_by_name(schema, entry)
    found = declared.get(name)
    if found is None:
        raise undeclared(name, entry, declared)
    return found


def undeclared(key: str, entry: type[Entry], declared: Collection[str]) -> ApiError:
    """R4's 400 for a key the suite's schema does not declare (D6, D7).

    One wording for a machine's `fields`, a commit's `fields` and a test entry's metric names,
    because it is one rule: nothing in a suite has a catch-all, so a key that is not declared has
    nowhere to go, and declaring one is a schema change rather than something a write does
    implicitly. `Entry.LIST` is what makes the message say which list the submitter got wrong --
    whether the `os` it misspelled was a machine field or a metric.

    The declared names are listed, sorted, because a submitter reading this has no other way to
    discover what the suite does declare without a second request.
    """
    return ApiError(
        ErrorCode.INVALID_REQUEST,
        f"'{key}' is not declared in this test suite's {entry.LIST}; "
        f"declared: {', '.join(sorted(declared)) or 'nothing'}",
    )


def _locked_values(
    connection: Connection, table: Table, identifier: int, read: Collection[str]
) -> dict[str, Any]:
    """These columns of one row, re-read with the row itself locked against other writers.

    `FOR UPDATE` rather than a plain SELECT: it blocks until every transaction that is currently
    writing this row has ended, and then -- under READ COMMITTED (see db.py) -- reports the version
    that survived. That is exactly the pair of facts a fill needs, and neither is available from an
    unlocked read.

    By column object rather than by name, for the same reason `concurrency.get_or_create` reads
    that way: a declared field may legally be called anything, and `Row._mapping` keyed by column
    cannot confuse two of them.
    """
    wanted = [table.c[name] for name in read]
    row = connection.execute(
        select(*wanted).where(table.c.id == identifier).with_for_update()
    ).one()
    return {column.name: row._mapping[column] for column in wanted}


def create_or_reconcile(
    connection: Connection,
    key: Column[Any],
    value: Any,
    *,
    constraint: str,
    values: Mapping[str, Any],
    matched: Mapping[str, Any],
    contradiction: Contradiction,
) -> int:
    """The id of the entity a run submission names, created or reconciled as D7 requires (D7, D13).

    The whole of what a machine and a commit share on the submission path, which is everything but
    the table, the constraint names and the wording of the rejection: resolve the row by its natural
    key (D13's get-or-create), and then either return it because this transaction just wrote it, or
    match what was submitted against what is stored and fill in whatever the record has no value
    for.

    `values` is everything the row is created with, and `matched` is the subset D7 compares against
    an existing record -- the two differ, because a machine's `tracked` is written at creation and
    then never compared, and a commit's ordinal is compared only when the submission sends one.

    A fill is the one step that writes to a row this transaction did not create, so it is the one
    step that has to be serialized against other submissions, and it is done twice over: once
    against the unlocked read to find out whether there is anything to fill at all, and then again
    against a locked re-read of the same columns, which is the reconciliation that counts.

    The two-pass shape is what makes D7's "stored metadata is never overwritten" *true* rather than
    usually true. Under READ COMMITTED two submissions can both read the same column as NULL, both
    decide to fill it with different values, and the second -- having waited on the row lock the
    first's UPDATE took -- would then overwrite a value it never compared against. Re-reading under
    `FOR UPDATE` closes that: by the time the lock is granted the competitor has either committed,
    in which case its value is now stored and a differing submission is the 409 D7 owes, or rolled
    back, in which case the column is still NULL and the fill is correct. The unique constraint on
    `{suite}.commit.ordinal` does not cover this case -- it catches a *different* commit holding the
    ordinal, not two submissions giving *this* commit two different ones.

    The lock is taken only when something needs filling, and that is deliberate: a submission
    normally re-sends metadata that is already stored, so the overwhelmingly common path reconciles
    to nothing and returns without locking anything at all.

    Two locks taken in two orders deadlock, so the order is fixed by the caller rather than here;
    see the call site in `routes/runs.py`.
    """
    resolved = concurrency.get_or_create(
        connection, key, value, constraint=constraint, values=values, read=matched
    )
    if resolved.created:
        # Written from the submission a moment ago, so there is nothing it could contradict.
        return resolved.identifier

    if not reconcile(resolved.stored, matched, contradiction):
        # Nothing to fill, so nothing to serialize: the hot path takes no lock at all.
        return resolved.identifier

    locked = _locked_values(connection, key.table, resolved.identifier, matched)
    # Reconciled again, and this is the pass that decides. Possibly empty: a competing submission
    # may have filled in exactly what this one would have, which is agreement rather than work.
    fill = reconcile(locked, matched, contradiction)
    if fill:
        connection.execute(
            update(key.table).where(key.table.c.id == resolved.identifier).values(**fill)
        )
    return resolved.identifier


def identifiers(
    connection: Connection,
    key: Column[Any],
    values: Sequence[str],
    missing: Callable[[str], ApiError],
) -> dict[str, int]:
    """The internal ids the entities these natural keys name, or the caller's 404 for one absent.

    R1 keeps auto-increment ids out of the API, so every request names an entity by its key and
    every query filters on the id behind it. Several paths resolve one that way -- a `machine=` or
    `test=` filter, the run a sub-resource hangs off, a regression's indicators -- and each owes the
    same lookup; what differs is only the wording of the 404, which each entity keeps. Taken as a
    callback rather than a string so that the message is not built on the path where it is not used.

    Plural because one request may name many entities at once: a regression's indicators each name
    a machine and a test, and resolving them one at a time would be two statements per indicator.

    Reported against the first *requested* value that is missing rather than whichever the database
    happened not to return, so that the 404 a caller reads does not depend on row order.
    """
    if not values:
        # A batch that names nothing resolves to nothing, without a statement that could only ever
        # match no rows.
        return {}
    found = {
        name: int(found)
        for name, found in connection.execute(
            select(key, key.table.c.id).where(key.in_(set(values)))
        ).all()
    }
    for value in values:
        if value not in found:
            raise missing(value)
    return found


def identifier(
    connection: Connection, key: Column[Any], value: Any, missing: Callable[[str], ApiError]
) -> int:
    """The internal id of the one entity a natural key names, or the caller's 404 for one absent.

    The singular case of `identifiers` above, which is where the lookup itself lives -- two
    spellings of one SELECT would be two chances for the two to answer differently.
    """
    return identifiers(connection, key, [value], missing)[value]


def rendered_fields(entries: Sequence[Entry], table: Table, row: Row[Any]) -> dict[str, FieldValue]:
    """Every field the suite declares, `null` where this entity has no value (R4).

    The whole declared set rather than only what is populated, so that a client rendering a column
    per field does not have to discover which keys a given row happens to carry. A sample's
    `metrics` is the stated exception (see endpoints.md, Samples).

    Read by column object rather than by name: a field may legally be called `last_run_at`, which
    the machine list also selects under that name as a derived value.
    """
    return {entry.name: row._mapping[table.c[entry.name]] for entry in entries}

"""O1's submission payload, and the pure validation that turns it into what a run write stores.

Two things live here: the shape of the body `POST /api/suites/{testsuite}/runs` accepts, and the
step that resolves it against a suite's schema. Neither touches a database. A submission is the one
request whose meaning depends on the suite -- its metric names are columns the schema declares, its
arrays expand into rows -- so the work of reading it is worth doing once, in front of the write,
rather than interleaved with the inserts. `validate_submission` either returns the whole of what the
run write needs or raises, so nothing half-validated ever reaches a statement.

The run endpoints that address a run rather than create one take their UUID from a path segment,
and read it through `entities.UuidKey`: the normalization a body's UUID gets has to be the same one
a path gets, or the two would disagree about which run is which.

Test entries are the reason the payload model cannot describe the request on its own: a metric name
is data, not part of the format, so `TestEntry` accepts extra keys and `validate_submission` decides
what they mean. Everything else here is declared, and `extra="forbid"` makes a misspelled key a 400
rather than a value silently dropped.

A test entry's profile is decoded, validated and encoded for storage by `profile_document`, which
owns O7's document; this module only routes each entry's string to it.
"""

from __future__ import annotations

from collections.abc import Iterator, Mapping, Sequence
from contextlib import contextmanager
from dataclasses import dataclass
from math import isfinite
from typing import Annotated, Any, Literal
from uuid import uuid4

from pydantic import BaseModel, ConfigDict, Field, StringConstraints

from lnt_v5 import examples
from lnt_v5.errors import ApiError, ErrorCode
from lnt_v5.strings import NUL, Storable
from lnt_v5.suites.entities import (
    CLIENT_UUID_FORMAT,
    ClientUuid,
    CommitObject,
    FieldValue,
    MachineObject,
    declared_by_name,
    undeclared,
    validate_fields,
    validate_value,
)
from lnt_v5.suites.profile_document import (
    MAX_COMPRESSED_SIZE,
    MAX_DOCUMENT_SIZE,
    MAX_FUNCTION_NAME_BYTES,
    MAX_FUNCTIONS,
    MAX_INSTRUCTIONS,
    StoredProfile,
    stored_profile,
)
from lnt_v5.suites.schema import CommitField, Entry, MachineField, Metric, SuiteSchema
from lnt_v5.suites.tables import NAME_LENGTH

# One wording for every NUL the `run_parameters` walk finds, in a key or in a value.
_NO_NUL = (
    "contains a NUL character (U+0000), which cannot be stored; run parameters are stored as JSON"
)

# For stating the profile size limits in MiB, as their constants are written.
_MIB = 1024 * 1024

# The descriptions and docstrings from here to the end of `RunSubmission` are published, in I8's
# document, so they are written for API users.
RunUuid = Annotated[
    ClientUuid,
    Field(
        description=(
            f"The run's UUID. {CLIENT_UUID_FORMAT} Choosing it yourself makes it safe to retry a "
            "submission: if a run with this UUID already exists, you get a 409 `duplicate`."
        )
    ),
]

TestName = Annotated[
    str,
    StringConstraints(min_length=1, max_length=NAME_LENGTH),
    Storable,
    Field(
        description=(
            "The test's name, unique within its test suite. Unlike machine names and commit "
            "values, it can contain '/'."
        ),
        examples=[examples.TEST],
    ),
]


# `extra="allow"`, alone among the models here, because the keys beside the two reserved ones are
# the suite's metric names -- data rather than format, which no static model can enumerate. They are
# validated against the schema by `validate_submission`; what this model contributes is the shape of
# `name` and `profile`, and the fact that everything else is a metric.
class TestEntry(BaseModel):
    """The results of one test: its `name`, an optional `profile`, and one key per metric, named
    after the metric.

    Each metric's value is either a single value or an array of values, one per repetition of the
    test. Each array element is recorded as a separate sample. All arrays in one entry must have the
    same length, and single values next to them are repeated in each sample. An entry without any
    metric still records that the test ran.

    Values must have the JSON type of their metric. Metrics the schema doesn't define are rejected,
    and so are nulls: leave out metrics that have no value.
    """

    model_config = ConfigDict(extra="allow")

    name: TestName
    profile: str | None = Field(
        default=None,
        description=(
            "The test's profile: a profile document (the JSON returned by "
            "`GET /api/suites/{testsuite}/profiles/{uuid}/document`), gzip-compressed and then "
            f"base64-encoded. Limits: {MAX_COMPRESSED_SIZE // _MIB} MiB compressed, "
            f"{MAX_DOCUMENT_SIZE // _MIB} MiB uncompressed, {MAX_FUNCTIONS} functions, "
            f"{MAX_INSTRUCTIONS} instructions per function, and {MAX_FUNCTION_NAME_BYTES} bytes "
            "per function name (in UTF-8). Null is the same as leaving it out."
        ),
    )


class RunSubmission(BaseModel):
    """A run: the results for one machine at one commit, with one entry per test.

    If the machine or the commit doesn't exist yet, it is created. If it does exist, the submission
    must agree with what is stored: fields, ordinal and tag that have no value yet are filled in,
    but a value that differs from the stored one is rejected with a 409 `conflict`. Use `PATCH` to
    change stored values. Keys you leave out, or set to null, aren't checked. The exception is the
    machine's `tracked`, which is only used when the machine is created.
    """

    model_config = ConfigDict(extra="forbid")

    format_version: Literal["5"] = Field(description='The submission format. Always `"5"`.')
    uuid: RunUuid | None = None
    machine: MachineObject = Field(description="The machine the run was measured on.")
    commit: CommitObject = Field(description="The commit the run measured.")
    run_parameters: dict[str, Any] = Field(
        default_factory=dict,
        description=(
            "Any extra information about the run, such as build options. It is stored as-is and "
            "isn't checked against the schema. It can't contain `NaN`, `Infinity` or the NUL "
            "character (U+0000)."
        ),
    )
    tests: list[TestEntry] = Field(
        description="The results, with at most one entry per test. Can be empty, but is required."
    )


@dataclass(frozen=True)
class SubmittedMachine:
    """The machine a submission names, with `fields` already resolved to column values (O2)."""

    name: str
    tracked: bool
    fields: Mapping[str, Any]


@dataclass(frozen=True)
class SubmittedCommit:
    """The commit a submission names, with `fields` already resolved to column values (O2)."""

    value: str
    ordinal: int | None
    tag: str | None
    fields: Mapping[str, Any]


@dataclass(frozen=True)
class SubmittedTest:
    """One test entry, resolved into the rows it stands for.

    `samples` holds one mapping of metric column values per `{suite}.sample` row, and is never
    empty: O1 gives an entry `max(1, array length)` rows, so an entry carrying no metric values at
    all still records that the test ran in this run.

    Every mapping carries every metric the suite declares, with `None` where the entry had no value
    -- which is what an omitted metric means anyway (O1). Uniform key sets are a promise the write
    layer relies on; see `_samples`, which establishes it.
    """

    name: str
    samples: Sequence[Mapping[str, Any]]
    profile: StoredProfile | None


@dataclass(frozen=True)
class ValidatedSubmission:
    """Everything a run write needs, with nothing left to decide (O1).

    Every value here is already typed per D3 and named by the column that stores it, so the write
    layer composes statements and never reinterprets the payload. `uuid` is the client's when it
    supplied one and a fresh v4 otherwise, so the write path has no "maybe" to handle.
    """

    uuid: str
    machine: SubmittedMachine
    commit: SubmittedCommit
    run_parameters: dict[str, Any]
    tests: Sequence[SubmittedTest]


def validate_submission(schema: SuiteSchema, body: RunSubmission) -> ValidatedSubmission:
    """What a submission stands for against this suite's schema, or a 400 (O1, O7).

    Pure, and complete: it reaches no database and leaves nothing for the write path to validate,
    so a submission that is going to be refused is refused before a single row is written. The
    checks it cannot make are exactly the ones that need stored state -- a duplicate run UUID, a
    contradicted ordinal, machine metadata that disagrees with what is already there (O2).
    """
    _reject_unstorable(body.run_parameters, "run_parameters")
    machine = SubmittedMachine(
        name=body.machine.name,
        tracked=body.machine.tracked,
        fields=_submitted_fields(schema, MachineField, body.machine.fields),
    )
    commit = SubmittedCommit(
        value=body.commit.value,
        ordinal=body.commit.ordinal,
        tag=body.commit.tag,
        fields=_submitted_fields(schema, CommitField, body.commit.fields),
    )

    samples: list[Sequence[Mapping[str, Any]]] = []
    seen: set[str] = set()
    # Built once for the whole submission rather than per entry: a submission legitimately names
    # tens of thousands of tests, and rebuilding the table for each would be work proportional to
    # the schema times the payload, thrown away every time.
    declared = declared_by_name(schema, Metric)
    for entry in body.tests:
        if entry.name in seen:
            # O1: one entry per test. The format already expresses a test measured several times
            # with an array value, and D5 allows at most one profile per run+test pair, so two
            # entries for one test could not both be stored. Refused here rather than discovered as
            # an integrity failure halfway through writing the run.
            raise ApiError(
                ErrorCode.INVALID_REQUEST,
                f"two test entries name '{entry.name}'; a test measured several times in one run "
                f"is submitted as one entry with array values, not as several entries",
            )
        seen.add(entry.name)
        with _naming(entry):
            samples.append(_samples(declared, entry))

    # A second pass, because encoding a profile is by far the most expensive part of validation:
    # a submission refused for one of its samples is refused before any of that work is done.
    tests: list[SubmittedTest] = []
    for entry, rows in zip(body.tests, samples, strict=True):
        with _naming(entry):
            profile = None if entry.profile is None else stored_profile(entry.profile)
        tests.append(SubmittedTest(name=entry.name, samples=rows, profile=profile))

    return ValidatedSubmission(
        # O1: the client's UUID when it sent one, and a v4 the server mints otherwise.
        uuid=body.uuid or str(uuid4()),
        machine=machine,
        commit=commit,
        run_parameters=body.run_parameters,
        tests=tests,
    )


@contextmanager
def _naming(entry: TestEntry) -> Iterator[None]:
    """Say which test entry a 400 raised inside is about, since a submission carries thousands."""
    try:
        yield
    except ApiError as error:
        raise ApiError(error.code, f"test '{entry.name}': {error.message}") from error


def _reject_unstorable(value: Any, where: str) -> None:
    """Refuse anything inside `run_parameters` that the stored representation cannot hold (D3, O1).

    D3 states the rule once and gives it two instances: `NaN`/`Infinity`/`-Infinity`, which JSON
    has no literal for, and the NUL character, which PostgreSQL stores in neither `text` nor
    `jsonb`. Everywhere else the rule is enforced by a type -- `RealValue` and `Storable` in
    `entities.py` -- but `run_parameters` is a free-form blob with no declared shape to hang one on,
    so the same rule is applied by walking it. Both instances have the same consequence if they get
    through: the value reaches the INSERT and fails there as a `DataError`, which is neither an
    integrity failure nor a missing relation, so nothing attributes it and the caller reads a 500
    for a value it supplied -- where I4 wants `invalid_request`.

    Keys as well as values: JSONB holds an object key no more willingly than it holds a string, and
    a key is just as much something the caller sent.
    """
    if isinstance(value, float) and not isfinite(value):
        raise ApiError(
            ErrorCode.INVALID_REQUEST,
            f"'{where}' is {value}; JSON has no literal for it, and run parameters are stored as "
            f"JSON",
        )
    if isinstance(value, str) and NUL in value:
        raise ApiError(ErrorCode.INVALID_REQUEST, f"'{where}' {_NO_NUL}")
    if isinstance(value, Mapping):
        for key, item in value.items():
            if isinstance(key, str) and NUL in key:
                raise ApiError(ErrorCode.INVALID_REQUEST, f"a key in '{where}' {_NO_NUL}")
            _reject_unstorable(item, f"{where}.{key}")
    elif isinstance(value, list):
        for index, item in enumerate(value):
            _reject_unstorable(item, f"{where}[{index}]")


def _submitted_fields(
    schema: SuiteSchema, entry: type[Entry], submitted: Mapping[str, FieldValue]
) -> dict[str, Any]:
    """A submission's `fields` dict as column values, with the explicit nulls dropped (O1, O2).

    `validate_fields` keeps a null, because that is how a PATCH clears a stored value. A submission
    has nothing to clear -- it never overwrites metadata -- so a null here means "no value
    submitted for this key" and drops out, leaving nothing to write and nothing to compare against
    what is stored. Dropped after validation rather than before, so that `{"typo": null}` is the
    400 it would be with any other value.
    """
    values = validate_fields(schema, entry, submitted)
    return {key: value for key, value in values.items() if value is not None}


def _samples(declared: Mapping[str, Metric], entry: TestEntry) -> list[dict[str, Any]]:
    """The sample rows one test entry stands for (O1).

    Array values are what make this more than a rename: a test measured several times in one run
    sends an array per metric, and the entry expands into one row per element, with the scalar
    metrics repeated across them. All the arrays therefore describe the same repetitions and must
    agree on how many there were.

    `declared` is the suite's metrics by name, built once for the whole submission by the caller.
    """
    scalars: dict[str, Any] = {}
    arrays: dict[str, list[Any]] = {}
    repetitions: int | None = None

    # `model_extra` is everything that is not `name` or `profile`, which O1 reserves; the schema
    # refuses a metric named either, so a suite can never hold one this loop would hide (D5).
    for key, value in (entry.model_extra or {}).items():
        metric = declared.get(key)
        if metric is None:
            raise undeclared(key, Metric, declared)
        if not isinstance(value, list):
            scalars[key] = _measured(metric, value)
            continue
        if not value:
            # O1: an empty array would produce no rows at all, silently discarding every scalar
            # metric in the same entry -- which is never what a producer meant.
            raise ApiError(
                ErrorCode.INVALID_REQUEST,
                f"'{key}' is an empty array; a metric with no values is omitted from the test "
                f"entry rather than sent as an empty array",
            )
        if repetitions is not None and len(value) != repetitions:
            raise ApiError(
                ErrorCode.INVALID_REQUEST,
                f"'{key}' carries {len(value)} values, but another metric in this entry carries "
                f"{repetitions}; every array in one test entry describes the same repetitions and "
                f"must be the same length",
            )
        repetitions = len(value)
        arrays[key] = [_measured(metric, element) for element in value]

    # Every row carries every declared metric, `None` where the entry sent no value -- which is
    # what a metric the submission omits means anyway (O1). That uniformity is what lets the write
    # layer put the whole submission in one statement: SQLAlchemy Core compiles an executemany from
    # the *first* mapping it is given and binds every later one to those same columns, so rows that
    # disagree on which keys they carry silently write the wrong columns, or drop values entirely.
    # Established here, where the rows are made, rather than repaired by whoever writes them.
    measured = {name: scalars.get(name) for name in declared}

    # O1: an entry yields max(1, array length) rows. With no arrays that is the single row which
    # records that the test ran in this run, whether or not it carries any metric value.
    count = 1 if repetitions is None else repetitions
    return [
        measured | {key: values[index] for key, values in arrays.items()} for index in range(count)
    ]


def _measured(metric: Metric, value: Any) -> Any:
    """One metric value, typed per D3, or a 400.

    A null is refused rather than stored. O1 makes an absent measurement an absent key, so a null
    is a producer emitting a fixed row of metrics without saying which of them it actually has --
    and every `{suite}.sample` column is nullable anyway, so accepting it would buy nothing and
    lose the one signal that the producer is confused.
    """
    if value is None:
        raise ApiError(
            ErrorCode.INVALID_REQUEST,
            f"'{metric.name}' is null; a metric with no value is omitted from the test entry "
            f"rather than sent as null",
        )
    return validate_value(metric, value)

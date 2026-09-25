"""D6's submission payload, and the pure validation that turns it into what a run write stores.

Two things live here: the shape of the body `POST /api/suites/{testsuite}/runs` accepts, and the
step that resolves it against a suite's schema. Neither touches a database. A submission is the one
request whose meaning depends on the suite -- its metric names are columns the schema declares, its
arrays expand into rows -- so the work of reading it is worth doing once, in front of the write,
rather than interleaved with the inserts. `validate_submission` either returns the whole of what the
run write needs or raises, so nothing half-validated ever reaches a statement.

The run endpoints that address a run rather than create one take their UUID from a path segment, and
`RunUuidPath` below is how they read it: the normalization a body's UUID gets has to be the same one
a path gets, or the two would disagree about which run is which.

Test entries are the reason the payload model cannot describe the request on its own: a metric name
is data, not part of the format, so `TestEntry` accepts extra keys and `validate_submission` decides
what they mean. Everything else here is declared, and `extra="forbid"` makes a misspelled key a 400
rather than a value silently dropped.

The profile blob is decoded and its format version checked, and deliberately nothing more: D12's
binary format has a reader of its own, and a submission must not depend on it.
"""

from __future__ import annotations

import base64
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from math import isfinite
from typing import Annotated, Any, Literal
from uuid import uuid4

from pydantic import AfterValidator, BaseModel, ConfigDict, Field, StringConstraints

from lnt_v5.errors import ApiError, ErrorCode
from lnt_v5.suites.entities import (
    NUL,
    CommitObject,
    FieldValue,
    MachineObject,
    Storable,
    declared_by_name,
    undeclared,
    validate_fields,
    validate_value,
)
from lnt_v5.suites.schema import CommitField, Entry, MachineField, Metric, SuiteSchema
from lnt_v5.suites.tables import NAME_LENGTH, UUID_LENGTH

# D6: the standard 8-4-4-4-12 hyphenated hex form, of any UUID version. Deliberately matched with a
# pattern rather than parsed by a UUID library: those also accept braces, a `urn:uuid:` prefix and
# the unhyphenated form, none of which D6 offers, and accepting one would mean the value the server
# stores and addresses the run by is not the value the client sent.
#
# Anchored because pydantic's pattern is a search rather than a full match. The exact length beside
# it is not redundant: `$` matches before a trailing newline in some regex engines, and pinning the
# length to D5's column width closes that whichever engine pydantic is built on.
UUID_PATTERN = r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"

# D12: the first byte of a decoded profile is the format version, and v5 accepts only version 2.
PROFILE_FORMAT_VERSION = 2

# D5's cap on one decoded profile. This is a limit on a profile, not on the request carrying it: an
# oversized request *body* is refused at the transport layer with R4's 413 (see `config.BODY_LIMIT`,
# which is deliberately larger), and one submission may legitimately carry many profiles.
MAX_PROFILE_SIZE = 50 * 1024 * 1024

# The same cap in encoded characters, so an over-sized profile is refused before ~67 MB of base64 is
# materialized as bytes. Base64 spends 4 characters on every 3 bytes, rounded up to a whole group,
# so this is the longest encoding a blob of the permitted size can have. It admits up to two bytes
# more than the cap, which the check on the decoded length then catches; this one is a pre-filter,
# and `MAX_PROFILE_SIZE` is the rule.
MAX_ENCODED_PROFILE_SIZE = 4 * ((MAX_PROFILE_SIZE + 2) // 3)

# The ASCII whitespace D12 makes insignificant inside an encoded profile, removed before decoding.
# Exactly the ASCII set rather than `str.split()`'s: that one also eats U+00A0 and friends, which
# are outside the alphabet and are precisely what strict decoding is there to report.
_WHITESPACE = str.maketrans("", "", " \t\n\r\v\f")

# One wording for both size checks, and the place the two caps are told apart for the submitter.
_TOO_LARGE = (
    f"profile is larger than the {MAX_PROFILE_SIZE} byte limit on a single profile; note that "
    f"this is not the limit on the request body, which is reported as 413"
)

# One wording for every NUL the `run_parameters` walk finds, in a key or in a value.
_NO_NUL = (
    "contains a NUL character (U+0000), which cannot be stored; run parameters are stored as JSON"
)

RunUuid = Annotated[
    str,
    StringConstraints(pattern=UUID_PATTERN, min_length=UUID_LENGTH, max_length=UUID_LENGTH),
    AfterValidator(str.lower),
    Field(
        description=(
            "Identifies the run, in the standard 8-4-4-4-12 hyphenated hex form. Any UUID version "
            "is accepted; only the format is validated. Case-insensitive, and normalized to "
            "lowercase. Omit it to have the server generate one."
        )
    ),
]

# The same UUID as it arrives in a path segment rather than in a body, so that the two agree on
# what "the same run" is by construction rather than by each endpoint remembering to normalize.
# Only the lowercasing is shared: a run is stored lowercased (D6), so the lookup has to be. The
# format is deliberately *not* constrained here -- a segment that is not a UUID at all passes
# through unchanged and simply matches nothing, which is the 404 endpoints.md asks for. It names no
# run rather than being a malformed request.
RunUuidPath = Annotated[str, AfterValidator(str.lower)]

TestName = Annotated[
    str,
    StringConstraints(min_length=1, max_length=NAME_LENGTH),
    Storable,
    Field(
        description=(
            "Identifies the test within its test suite. Unlike a machine name or a commit value, "
            "it is not required to be usable as a URL path segment: test names legitimately "
            "contain '/', and R1 exempts them."
        )
    ),
]


class TestEntry(BaseModel):
    """One test's results within a submission (D6).

    `extra="allow"`, alone among the models here, because the keys beside the two reserved ones are
    the suite's metric names -- data rather than format, which no static model can enumerate. They
    are validated against the schema by `validate_submission`; what this model contributes is the
    shape of `name` and `profile`, and the fact that everything else is a metric.
    """

    model_config = ConfigDict(extra="allow")

    name: TestName
    profile: str | None = Field(
        default=None,
        description=(
            "Base64-encoded profile data for this test in this run (D12). Null means the entry "
            "carries no profile, exactly as omitting the key does."
        ),
    )


class RunSubmission(BaseModel):
    """The body of `POST /api/suites/{testsuite}/runs` (D6)."""

    model_config = ConfigDict(extra="forbid")

    format_version: Literal["5"] = Field(
        description="The submission format. Only '5' exists; v4's formats are not accepted."
    )
    uuid: RunUuid | None = None
    machine: MachineObject = Field(description="The machine this run was measured on (D7).")
    commit: CommitObject = Field(description="The commit this run belongs to (D7).")
    run_parameters: dict[str, Any] = Field(
        default_factory=dict,
        description=(
            "Free-form metadata about the run as a whole, stored verbatim. A run has no declared "
            "field list, so unlike a machine's or a commit's `fields` this is an opaque blob and "
            "its keys are neither declared nor validated. It must still be something the stored "
            "representation can hold: the non-standard `NaN`, `Infinity` and `-Infinity` literals "
            "some parsers accept, and the NUL character (U+0000), are rejected wherever they "
            "appear in it -- in a key as well as in a value."
        ),
    )
    tests: list[TestEntry] = Field(
        description=(
            "The tests this run measured, at most one entry per test. May be empty -- a run that "
            "measured nothing is still a run -- but not omitted."
        )
    )


@dataclass(frozen=True)
class SubmittedMachine:
    """The machine a submission names, with `fields` already resolved to column values (D7)."""

    name: str
    tracked: bool
    fields: Mapping[str, Any]


@dataclass(frozen=True)
class SubmittedCommit:
    """The commit a submission names, with `fields` already resolved to column values (D7)."""

    value: str
    ordinal: int | None
    fields: Mapping[str, Any]


@dataclass(frozen=True)
class SubmittedTest:
    """One test entry, resolved into the rows it stands for.

    `samples` holds one mapping of metric column values per `{suite}.sample` row, and is never
    empty: D6 gives an entry `max(1, array length)` rows, so an entry carrying no metric values at
    all still records that the test ran in this run.

    Every mapping carries every metric the suite declares, with `None` where the entry had no value
    -- which is what an omitted metric means anyway (D6). Uniform key sets are a promise the write
    layer relies on; see `_submitted_test`, which establishes it.
    """

    name: str
    samples: Sequence[Mapping[str, Any]]
    profile: bytes | None


@dataclass(frozen=True)
class ValidatedSubmission:
    """Everything a run write needs, with nothing left to decide (D6).

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
    """What a submission stands for against this suite's schema, or a 400 (D6, D12).

    Pure, and complete: it reaches no database and leaves nothing for the write path to validate,
    so a submission that is going to be refused is refused before a single row is written. The
    checks it cannot make are exactly the ones that need stored state -- a duplicate run UUID, a
    contradicted ordinal, machine metadata that disagrees with what is already there (D7).
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
        fields=_submitted_fields(schema, CommitField, body.commit.fields),
    )

    tests: list[SubmittedTest] = []
    seen: set[str] = set()
    # Built once for the whole submission rather than per entry: a submission legitimately names
    # tens of thousands of tests, and rebuilding the table for each would be work proportional to
    # the schema times the payload, thrown away every time.
    declared = declared_by_name(schema, Metric)
    for entry in body.tests:
        if entry.name in seen:
            # D6: one entry per test. The format already expresses a test measured several times
            # with an array value, and D5 allows at most one profile per run+test pair, so two
            # entries for one test could not both be stored. Refused here rather than discovered as
            # an integrity failure halfway through writing the run.
            raise ApiError(
                ErrorCode.INVALID_REQUEST,
                f"two test entries name '{entry.name}'; a test measured several times in one run "
                f"is submitted as one entry with array values, not as several entries",
            )
        seen.add(entry.name)
        try:
            tests.append(_submitted_test(declared, entry))
        except ApiError as error:
            # A submission carries thousands of entries, so every failure below has to say which
            # one it is about. Named once here rather than by each of the messages underneath,
            # which would then each have to be given the name to say it.
            raise ApiError(error.code, f"test '{entry.name}': {error.message}") from error

    return ValidatedSubmission(
        # D6: the client's UUID when it sent one, and a v4 the server mints otherwise.
        uuid=body.uuid or str(uuid4()),
        machine=machine,
        commit=commit,
        run_parameters=body.run_parameters,
        tests=tests,
    )


def _reject_unstorable(value: Any, where: str) -> None:
    """Refuse anything inside `run_parameters` that the stored representation cannot hold (D3, D6).

    D3 states the rule once and gives it two instances: `NaN`/`Infinity`/`-Infinity`, which JSON
    has no literal for, and the NUL character, which PostgreSQL stores in neither `text` nor
    `jsonb`. Everywhere else the rule is enforced by a type -- `RealValue` and `Storable` in
    `entities.py` -- but `run_parameters` is a free-form blob with no declared shape to hang one on,
    so the same rule is applied by walking it. Both instances have the same consequence if they get
    through: the value reaches the INSERT and fails there as a `DataError`, which is neither an
    integrity failure nor a missing relation, so nothing attributes it and the caller reads a 500
    for a value it supplied -- where R4 wants `invalid_request`.

    Keys as well as values: JSONB holds an object key no more willingly than it holds a string, and
    a key is just as much something the caller sent.

    Recursive, over a structure the JSON parser has itself just built recursively: anything nested
    deeply enough to trouble this walk would have failed to parse in the first place.
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
    """A submission's `fields` dict as column values, with the explicit nulls dropped (D6, D7).

    `validate_fields` keeps a null, because that is how a PATCH clears a stored value. A submission
    has nothing to clear -- it never overwrites metadata -- so a null here means "no value
    submitted for this key" and drops out, leaving nothing to write and nothing to compare against
    what is stored. Dropped after validation rather than before, so that `{"typo": null}` is the
    400 it would be with any other value.
    """
    values = validate_fields(schema, entry, submitted)
    return {key: value for key, value in values.items() if value is not None}


def _submitted_test(declared: Mapping[str, Metric], entry: TestEntry) -> SubmittedTest:
    """One test entry as the sample rows and the profile blob it stands for (D6).

    Array values are what make this more than a rename: a test measured several times in one run
    sends an array per metric, and the entry expands into one row per element, with the scalar
    metrics repeated across them. All the arrays therefore describe the same repetitions and must
    agree on how many there were.

    `declared` is the suite's metrics by name, built once for the whole submission by the caller.
    """
    scalars: dict[str, Any] = {}
    arrays: dict[str, list[Any]] = {}
    repetitions: int | None = None

    # `model_extra` is everything that is not `name` or `profile`, which D6 reserves; the schema
    # refuses a metric named either, so a suite can never hold one this loop would hide (D5).
    for key, value in (entry.model_extra or {}).items():
        metric = declared.get(key)
        if metric is None:
            raise undeclared(key, Metric, declared)
        if not isinstance(value, list):
            scalars[key] = _measured(metric, value)
            continue
        if not value:
            # D6: an empty array would produce no rows at all, silently discarding every scalar
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
    # what a metric the submission omits means anyway (D6). That uniformity is what lets the write
    # layer put the whole submission in one statement: SQLAlchemy Core compiles an executemany from
    # the *first* mapping it is given and binds every later one to those same columns, so rows that
    # disagree on which keys they carry silently write the wrong columns, or drop values entirely.
    # Established here, where the rows are made, rather than repaired by whoever writes them.
    measured = {name: scalars.get(name) for name in declared}

    # D6: an entry yields max(1, array length) rows. With no arrays that is the single row which
    # records that the test ran in this run, whether or not it carries any metric value.
    count = 1 if repetitions is None else repetitions
    samples = [
        measured | {key: values[index] for key, values in arrays.items()} for index in range(count)
    ]
    return SubmittedTest(
        name=entry.name,
        samples=samples,
        profile=None if entry.profile is None else decode_profile(entry.profile),
    )


def _measured(metric: Metric, value: Any) -> Any:
    """One metric value, typed per D3, or a 400.

    A null is refused rather than stored. D6 makes an absent measurement an absent key, so a null
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


def decode_profile(encoded: str) -> bytes:
    """The bytes a base64-encoded profile stands for, or a 400 (D12).

    Only the first byte of the result is looked at, and only to check the format version D12 fixes
    at 2. The body is deliberately not parsed: a submission must not depend on the profile reader,
    and a blob that turns out to be unreadable later is D12's problem rather than this one's.

    D12 makes whitespace insignificant, and everything else outside the alphabet an error, so ASCII
    whitespace is removed and what is left is decoded strictly. Both halves matter. Stripping first
    is what accepts the ubiquitous producers: `base64(1)` wraps at 76 columns by default, and so
    does every MIME encoder. Decoding strictly afterwards is what keeps the rule honest -- Python's
    lenient mode discards *every* character outside the alphabet, so a payload that is not base64
    at all would decode to whatever happened to remain rather than being reported.

    The encoded-size gate is applied to the stripped string, since line breaks are not payload:
    checking before the strip would refuse a wrapped profile that is comfortably inside the cap.
    """
    data_only = encoded.translate(_WHITESPACE)
    if len(data_only) > MAX_ENCODED_PROFILE_SIZE:
        raise ApiError(ErrorCode.INVALID_REQUEST, _TOO_LARGE)
    try:
        data = base64.b64decode(data_only, validate=True)
    except ValueError as error:
        # binascii.Error for a bad alphabet or bad padding, and a plain ValueError for a string
        # carrying non-ASCII; the former is a subclass of the latter.
        raise ApiError(
            ErrorCode.INVALID_REQUEST, f"profile is not valid base64: {error}"
        ) from error
    if len(data) > MAX_PROFILE_SIZE:
        raise ApiError(ErrorCode.INVALID_REQUEST, _TOO_LARGE)
    if not data:
        raise ApiError(
            ErrorCode.INVALID_REQUEST, "profile is empty, so it carries no format version byte"
        )
    if data[0] != PROFILE_FORMAT_VERSION:
        raise ApiError(
            ErrorCode.INVALID_REQUEST,
            f"profile declares format version {data[0]}, but only version "
            f"{PROFILE_FORMAT_VERSION} is supported",
        )
    return data

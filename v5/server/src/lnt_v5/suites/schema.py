"""A test suite's schema document: what it may say, and what it means (D3, D4).

A schema is a JSON document and nothing else -- it is the body of `POST /api/suites`, the body
`GET /api/suites/{name}` returns, and what the `schema` table stores. That is why these are
pydantic models rather than plain dataclasses: one definition validates the request, renders the
response, describes both in I8's document, and produces the normalized form that gets stored.

"Normalized" means every optional key is present and explicit. A schema fetched from one instance
can be posted verbatim to another (see E10), which only holds if the
document that comes back is a complete one.

What a schema *does* is create columns; see `tables.py` for the tables these entries become.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from enum import StrEnum
from typing import Annotated, ClassVar, Self

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, model_validator

from lnt_v5 import examples
from lnt_v5.strings import Storable
from lnt_v5.tables import IDENTIFIER_MAX_LENGTH

# D4: a suite name is also the name of the namespace holding its tables, and an entry name is also
# the name of a column. Both are therefore identifiers, and both follow one rule -- lowercase,
# starting with a letter, and no longer than Postgres allows an identifier to be. Characters and
# bytes are interchangeable because the pattern admits only ASCII.
#
# The rule deliberately does not exclude Postgres' reserved words: `order`, `user` and `table` are
# all legal metric names. Nothing in the schema needs them reserved, and forbidding them would be a
# surprising restriction to explain. It does mean every identifier built from one of these has to
# be quoted -- see tables.py.
#
# Anchored because pydantic's pattern is a *search* rather than a full match, so an unanchored
# pattern would accept anything merely containing a legal name.
NAME_PATTERN = r"^[a-z][a-z0-9_]*$"

# D4: names that satisfy the pattern but still cannot be a suite, because a namespace cannot be
# created under them. The first two already exist in every database; the prefix is reserved by
# PostgreSQL for its own use.
RESERVED_SUITE_NAMES = frozenset({"public", "information_schema"})
RESERVED_SUITE_PREFIX = "pg_"

# O1: a test entry in a submission is `name` plus metric values, with `profile` carrying the test's
# profile document (O7). A metric called either could never be given a value, so a schema
# declaring one is rejected rather than accepted into a state where one of its metrics is
# unreachable. This is a property of the submission format, not of any table's columns.
RESERVED_TEST_ENTRY_KEYS = frozenset({"name", "profile"})

Name = Annotated[str, StringConstraints(pattern=NAME_PATTERN, max_length=IDENTIFIER_MAX_LENGTH)]

# D4: the free text an entry carries for the UI -- `display_name`, `unit` and `unit_abbrev` -- which
# is either absent (null) or a non-empty string. An empty one would only be a second spelling of
# null. Unlike names, nothing restricts its characters, so it needs D3's NUL check.
Label = Annotated[str, StringConstraints(min_length=1), Storable]

# The docstrings of the enum and of the four models without a leading underscore below are
# published, as the descriptions I8's document gives them, so they are written for API users. The
# two private bases are not published themselves; the fields they declare are, through each
# subclass.


# D3: one set shared by metrics, commit fields and machine fields, so that a value's representation
# is described in exactly one place no matter which of the three carries it.
class AttributeType(StrEnum):
    """The type of a metric's or a field's values. It determines their JSON type: a number for
    `real` and `integer`, a string for `text`, and an ISO 8601 string for `datetime`.

    Values must have the right JSON type: `"5"` is not a valid `integer`. An integer is a valid
    `real`, and a whole number like `8.0` is a valid `integer`. Only `real` and `integer` metrics
    can be aggregated.
    """

    REAL = "real"
    INTEGER = "integer"
    TEXT = "text"
    DATETIME = "datetime"


# D3: the types over which arithmetic is defined, and so the ones an aggregation may be asked for.
# Being numeric does not make a metric a meaningful *quantity* -- an integer may encode an enum --
# but that is the schema author's judgement to make, not something a type can express.
NUMERIC_TYPES = frozenset({AttributeType.REAL, AttributeType.INTEGER})


class Entry(BaseModel):
    """What every entry carries, whichever of the three lists it belongs to.

    `extra="forbid"` is doing real work here, not just tidiness: it is what makes the presentation
    keys per-list. A `bigger_is_better` on a machine field, or a `display` on a metric, means
    nothing, and accepting it silently would leave the author believing it had an effect.

    A key with a default is optional in a request but always present in a response (D4's
    normalization, I4), so the document describes the two separately.
    """

    model_config = ConfigDict(extra="forbid", json_schema_serialization_defaults_required=True)

    # The per-suite tables this entry adds a column to, each with the columns it already has (D5).
    # A declared name may not collide with any of those. Each subclass names its own; the validator
    # below is shared, and `test_suite_tables.py` checks each set against the columns the table
    # builder actually creates, since the two are stated separately and could otherwise drift.
    RESERVED_COLUMNS: ClassVar[Mapping[str, frozenset[str]]] = {}

    # Which of a schema's three lists this entry belongs to -- the attribute on `SuiteSchema`, which
    # is also the key under which D4 spells it on the wire. Carried by the class so that code
    # handling an entry can name its list without being told, which is what keeps a caller
    # validating both `machine_fields` and `commit_fields` in one request from labelling one as the
    # other.
    LIST: ClassVar[str] = ""

    name: Name = Field(
        description=(
            "The name, used as the key for its values. Lowercase letters, digits and underscores, "
            "starting with a letter. Must be unique within its list."
        )
    )
    type: AttributeType
    display_name: Label | None = Field(
        default=None,
        description=(
            "A friendlier name for the UI to show instead of `name`. Null if there is none."
        ),
    )

    @model_validator(mode="after")
    def _reject_reserved_column(self) -> Self:
        for table, columns in self.RESERVED_COLUMNS.items():
            if self.name in columns:
                raise ValueError(
                    f"'{self.name}' is already a built-in column on '{table}' and cannot be "
                    f"declared; built-in there: {', '.join(sorted(columns))}"
                )
        return self


class _SearchableEntry(Entry):
    """An entry on an entity that `?search=` covers (O4).

    Substring matching only makes sense over text, so the flag is confined to `text` entries
    rather than quietly ignored on the others (D3).
    """

    searchable: bool = Field(
        default=False,
        description=(
            "Whether the `search` parameter of list operations matches this field's values. Only "
            "`text` fields can be searchable."
        ),
    )

    @model_validator(mode="after")
    def _searchable_is_text_only(self) -> Self:
        if self.searchable and self.type is not AttributeType.TEXT:
            raise ValueError(
                f"'{self.name}' is '{self.type.value}', and only a 'text' entry can be searchable"
            )
        return self


# A column on `{suite}.sample`, and a flag on `{suite}.test_coverage` (D5).
class Metric(Entry):
    """Something the suite's tests measure, such as execution time. In a run submission, each
    test reports its values under the metric's name.

    The name can't be `id`, `run_id`, `test_id`, `machine_id`, `name` or `profile`.
    """

    model_config = ConfigDict(json_schema_extra={"examples": [examples.METRICS[0]]})

    LIST: ClassVar[str] = "metrics"
    RESERVED_COLUMNS: ClassVar[Mapping[str, frozenset[str]]] = {
        "sample": frozenset({"id", "run_id", "test_id"}),
        "test_coverage": frozenset({"machine_id", "test_id"}),
    }

    unit: Label | None = Field(
        default=None,
        description="The unit of the values, such as `seconds`. Null if there is none.",
    )
    unit_abbrev: Label | None = Field(
        default=None, description="The unit's abbreviation, such as `s`. Null if there is none."
    )
    bigger_is_better: bool = Field(
        default=False,
        description=(
            "Whether higher values are better, as for a score. False when lower values are "
            "better, as for a time."
        ),
    )

    @model_validator(mode="after")
    def _reject_reserved_submission_key(self) -> Self:
        # A second, unrelated rule: these names are unusable not because the sample table has them,
        # but because the submission format spells them (see RESERVED_TEST_ENTRY_KEYS).
        if self.name in RESERVED_TEST_ENTRY_KEYS:
            raise ValueError(
                f"'{self.name}' is a reserved key inside a submission's test entries, so no "
                f"metric may be named it; reserved: "
                f"{', '.join(sorted(RESERVED_TEST_ENTRY_KEYS))}"
            )
        return self


# Optional metadata on `{suite}.commit` (D5).
class CommitField(_SearchableEntry):
    """A piece of information a commit can have in its `fields`, such as its author.

    The name can't be `id`, `commit`, `ordinal` or `tag`.
    """

    model_config = ConfigDict(json_schema_extra={"examples": [examples.COMMIT_FIELDS[0]]})

    LIST: ClassVar[str] = "commit_fields"
    RESERVED_COLUMNS: ClassVar[Mapping[str, frozenset[str]]] = {
        "commit": frozenset({"id", "commit", "ordinal", "tag"})
    }

    display: bool = Field(
        default=False,
        description=(
            "Whether the UI should show this field instead of the commit's value, for example a "
            "short SHA. Only one commit field can set this, and it must be a `text` field."
        ),
    )

    @model_validator(mode="after")
    def _display_is_text_only(self) -> Self:
        # D4: the display value stands in for the commit string, which is text.
        if self.display and self.type is not AttributeType.TEXT:
            raise ValueError(
                f"'{self.name}' is '{self.type.value}', and only a 'text' commit field can be the "
                f"display field"
            )
        return self


# Optional metadata on `{suite}.machine` (D5).
class MachineField(_SearchableEntry):
    """A piece of information a machine can have in its `fields`, such as its operating system.

    The name can't be `id`, `name` or `tracked`.
    """

    model_config = ConfigDict(json_schema_extra={"examples": [examples.MACHINE_FIELDS[0]]})

    LIST: ClassVar[str] = "machine_fields"
    RESERVED_COLUMNS: ClassVar[Mapping[str, frozenset[str]]] = {
        "machine": frozenset({"id", "name", "tracked"})
    }


def _reject_duplicates(entries: Sequence[Entry]) -> None:
    """Each entry becomes a column, so one name may appear at most once within a list.

    Across lists is fine and expected: a metric `os` and a machine field `os` are columns on
    different tables and never meet.
    """
    seen: set[str] = set()
    for entry in entries:
        if entry.name in seen:
            raise ValueError(f"'{entry.name}' is declared more than once")
        seen.add(entry.name)


# D4. The whole document: the body `POST /api/suites` accepts and the body `GET /api/suites/{name}`
# returns. There is no `format_version` -- only one format exists for v5.
class SuiteSchema(BaseModel):
    """A test suite's schema: its name, and the metrics, commit fields and machine fields it
    defines. A suite can only store what its schema defines.

    The same document is used to create a suite and is returned when reading one (with all
    optional keys filled in), so a suite read from one instance can be created as-is on another.
    """

    model_config = ConfigDict(
        extra="forbid",
        # As for `Entry`: the lists are optional in a request, and always present in a response.
        json_schema_serialization_defaults_required=True,
        json_schema_extra={"examples": [examples.SUITE_SCHEMA]},
    )

    name: Name = Field(
        description=(
            "The suite's name. Lowercase letters, digits and underscores, starting with a letter. "
            "It can't be "
            + " or ".join(f"`{reserved}`" for reserved in sorted(RESERVED_SUITE_NAMES))
            + f", or start with `{RESERVED_SUITE_PREFIX}`."
        )
    )
    metrics: list[Metric] = Field(
        default_factory=list, description="What the suite's tests measure."
    )
    commit_fields: list[CommitField] = Field(
        default_factory=list, description="The information commits can have."
    )
    machine_fields: list[MachineField] = Field(
        default_factory=list, description="The information machines can have."
    )

    @model_validator(mode="after")
    def _validate(self) -> Self:
        if self.name in RESERVED_SUITE_NAMES or self.name.startswith(RESERVED_SUITE_PREFIX):
            # D4: not a routing concern -- suite-scoped resources live below /api/suites/, so a
            # suite may legally be named `admin` or `suites`. These are rejected only because a
            # namespace cannot be created under them.
            raise ValueError(
                f"'{self.name}' cannot be a suite name: it names an existing namespace, or "
                f"begins with '{RESERVED_SUITE_PREFIX}', which PostgreSQL reserves"
            )

        _reject_duplicates(self.metrics)
        _reject_duplicates(self.commit_fields)
        _reject_duplicates(self.machine_fields)

        display = [field.name for field in self.commit_fields if field.display]
        if len(display) > 1:
            raise ValueError(
                "at most one commit field may set 'display', but these do: " + ", ".join(display)
            )
        return self

    @property
    def display_field(self) -> CommitField | None:
        """The commit field the UI shows in place of the raw commit string, if any (D4)."""
        return next((field for field in self.commit_fields if field.display), None)

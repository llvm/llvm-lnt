"""A test suite's schema document: what it may say, and what it means (D3, D4).

A schema is a JSON document and nothing else -- it is the body of `POST /api/suites`, the body
`GET /api/suites/{name}` returns, and what the `schema` table stores. That is why these are
pydantic models rather than plain dataclasses: one definition validates the request, renders the
response, describes both in R8's document, and produces the normalized form that gets stored.

"Normalized" means every optional key is present and explicit. A schema fetched from one instance
can be posted verbatim to another (see endpoints.md, Test Suites), which only holds if the
document that comes back is a complete one.

What a schema *does* is create columns; see `tables.py` for the tables these entries become.
"""

from __future__ import annotations

from collections.abc import Sequence
from enum import StrEnum
from typing import Annotated, ClassVar, Self

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, model_validator

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

# D6: a test entry in a submission is `name` plus metric values, with `profile` carrying
# base64-encoded profile data. A metric called either could never be given a value, so a schema
# declaring one is rejected rather than accepted into a state where one of its metrics is
# unreachable. This is a property of the submission format, not of any table's columns.
RESERVED_TEST_ENTRY_KEYS = frozenset({"name", "profile"})

Name = Annotated[str, StringConstraints(pattern=NAME_PATTERN, max_length=IDENTIFIER_MAX_LENGTH)]


class AttributeType(StrEnum):
    """The types an entry may declare (D3).

    One set shared by metrics, commit fields and machine fields, so that a value's representation
    is described in exactly one place no matter which of the three carries it.
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
    """

    model_config = ConfigDict(extra="forbid")

    # The per-suite table this entry adds a column to, and the columns that table already has (D5).
    # A declared name may not collide with one of those. Each subclass names its own; the validator
    # below is shared, and `test_suite_tables.py` checks each set against the columns the table
    # builder actually creates, since the two are stated separately and could otherwise drift.
    TABLE: ClassVar[str] = ""
    RESERVED_COLUMNS: ClassVar[frozenset[str]] = frozenset()

    name: Name
    type: AttributeType
    display_name: str | None = None

    @model_validator(mode="after")
    def _reject_reserved_column(self) -> Self:
        if self.name in self.RESERVED_COLUMNS:
            raise ValueError(
                f"'{self.name}' is already a built-in column on '{self.TABLE}' and cannot be "
                f"declared; built-in there: {', '.join(sorted(self.RESERVED_COLUMNS))}"
            )
        return self


class _SearchableEntry(Entry):
    """An entry on an entity that `?search=` covers (D9).

    Substring matching only makes sense over text, so the flag is confined to `text` entries
    rather than quietly ignored on the others (D3).
    """

    searchable: bool = False

    @model_validator(mode="after")
    def _searchable_is_text_only(self) -> Self:
        if self.searchable and self.type is not AttributeType.TEXT:
            raise ValueError(
                f"'{self.name}' is '{self.type.value}', and only a 'text' entry can be searchable"
            )
        return self


class Metric(Entry):
    """A measured value, stored as a column on `{suite}.sample` (D5)."""

    TABLE: ClassVar[str] = "sample"
    RESERVED_COLUMNS: ClassVar[frozenset[str]] = frozenset({"id", "run_id", "test_id"})

    unit: str | None = None
    unit_abbrev: str | None = None
    bigger_is_better: bool = False

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


class CommitField(_SearchableEntry):
    """Optional metadata on `{suite}.commit` (D5)."""

    TABLE: ClassVar[str] = "commit"
    RESERVED_COLUMNS: ClassVar[frozenset[str]] = frozenset({"id", "commit", "ordinal", "tag"})

    display: bool = Field(
        default=False,
        description=(
            "A hint for the UI: show this field's value in place of the raw commit string. "
            "At most one commit field may set it."
        ),
    )


class MachineField(_SearchableEntry):
    """Optional metadata on `{suite}.machine` (D5)."""

    TABLE: ClassVar[str] = "machine"
    RESERVED_COLUMNS: ClassVar[frozenset[str]] = frozenset({"id", "name", "tracked"})


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


class SuiteSchema(BaseModel):
    """A test suite's schema (D4).

    This is the whole document: the body `POST /api/suites` accepts and the body
    `GET /api/suites/{name}` returns. There is no `format_version` -- only one format exists for
    v5.
    """

    model_config = ConfigDict(extra="forbid")

    name: Name = Field(
        description="Identifies the suite, and names the namespace holding its tables."
    )
    metrics: list[Metric] = Field(default_factory=list)
    commit_fields: list[CommitField] = Field(default_factory=list)
    machine_fields: list[MachineField] = Field(default_factory=list)

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

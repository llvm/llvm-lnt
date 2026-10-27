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

import re
from collections.abc import Callable, Mapping, Sequence
from enum import StrEnum
from typing import Annotated, ClassVar, Self

from pydantic import (
    AfterValidator,
    BaseModel,
    ConfigDict,
    Field,
    StringConstraints,
    model_validator,
)

from lnt_v5 import examples
from lnt_v5.strings import Storable
from lnt_v5.tables import IDENTIFIER_MAX_LENGTH

# D4: a suite name is also the name of the namespace holding its tables, and an entry name is also
# the name of a column. Both are therefore identifiers: starting with a letter, and no longer than
# Postgres allows an identifier to be. Characters and bytes are interchangeable because the
# patterns admit only ASCII.
#
# An entry name may have capitals, and its case is significant: `IPC` and `ipc` are two entries,
# and a machine field `ID` does not collide with the built-in `id`. A suite name is lowercase only,
# as a namespace that every URL of the suite names.
#
# Neither rule excludes Postgres' reserved words: `order`, `user` and `table` are all legal metric
# names. Nothing in the schema needs them reserved, and forbidding them would be a surprising
# restriction to explain. It does mean every identifier built from one of these has to be quoted --
# see tables.py -- which is also what keeps an entry name's case: Postgres folds an unquoted
# identifier to lowercase.
#
# Anchored because pydantic's pattern is a *search* rather than a full match, so an unanchored
# pattern would accept anything merely containing a legal name.
#
# The web UI's schema editor checks names as they are typed with a copy of these rules, and of the
# reserved names below and on each entry model: see schema-lists.ts and schema-editor-model.ts in
# client/src/pages/test-suites/schema. So does `lnt v5 convert-v4-mirror`, in
# lnt/util/convert_v4_mirror.py at the root of the repository.
SUITE_NAME_PATTERN = r"^[a-z][a-z0-9_]*$"
ENTRY_NAME_PATTERN = r"^[A-Za-z][A-Za-z0-9_]*$"

# D4: names that satisfy the pattern but still cannot be a suite, because a namespace cannot be
# created under them. The first two already exist in every database; the prefix is reserved by
# PostgreSQL for its own use.
RESERVED_SUITE_NAMES = frozenset({"public", "information_schema"})
RESERVED_SUITE_PREFIX = "pg_"

EntryName = Annotated[
    str, StringConstraints(pattern=ENTRY_NAME_PATTERN, max_length=IDENTIFIER_MAX_LENGTH)
]

# D4's shape for a suite name. Creating a suite also rules out the reserved names above.
SuiteNameStr = Annotated[
    str, StringConstraints(pattern=SUITE_NAME_PATTERN, max_length=IDENTIFIER_MAX_LENGTH)
]

# D4: the free text an entry carries for the UI -- `display_name`, `unit` and `unit_abbrev` -- which
# is either absent (null) or a non-empty string. An empty one would only be a second spelling of
# null. Unlike names, nothing restricts its characters, so it needs D3's NUL check.
Label = Annotated[str, StringConstraints(min_length=1), Storable]

# D4: the URL templates of a suite's `repository`. The rules exist so that filling one in can only
# ever give a link to the host the schema names, over http or https, whatever the commit strings it
# is filled with -- and anyone with `submit` can choose those.
#
# - The scheme is literal, so no placeholder can turn the link into a `javascript:` one.
# - So is the host: a commit string can hold a `.`, and `https://{commit}` would otherwise lead
#   wherever a commit named `evil.com` says.
# - No space or ASCII control character, a set spelled out rather than "whitespace", which Python
#   and JavaScript do not agree on: the web UI checks templates with a copy of these rules, as
#   they are typed in its schema editor and before it builds a link (client/src/repository.ts).
# - No brace outside the placeholders the template accepts, which keeps the syntax free for more
#   placeholders later.
# ASCII only: Python folds case across Unicode, where `s` would also match U+017F (the long s),
# and a browser reads `http` followed by that letter and `://` as a relative link.
_URL_SCHEME = re.compile(r"^https?://", re.IGNORECASE | re.ASCII)
_URL_EXCLUDED = re.compile(r"[\x00-\x20\x7f]")
_PLACEHOLDER = re.compile(r"\{([^{}]*)\}")


def _url_template(*placeholders: str) -> Callable[[str], str]:
    """A check that a template is a URL that accepts exactly `placeholders`, each of them at least
    once."""
    accepted = " and ".join(f"{{{name}}}" for name in placeholders)

    def check(template: str) -> str:
        if _URL_EXCLUDED.search(template):
            raise ValueError("must not contain spaces or ASCII control characters")
        if not (scheme := _URL_SCHEME.match(template)):
            raise ValueError("must start with http:// or https://")
        for name in _PLACEHOLDER.findall(template):
            if name not in placeholders:
                raise ValueError(f"{{{name}}} is not a placeholder it accepts, only {accepted}")
        if re.search(r"[{}]", _PLACEHOLDER.sub("", template)):
            raise ValueError(f"must not contain braces other than those of {accepted}")
        if any(f"{{{name}}}" not in template for name in placeholders):
            raise ValueError(f"must contain {accepted}")
        host = re.split(r"[/?#]", template[scheme.end() :], maxsplit=1)[0]
        if not host:
            raise ValueError("must name a host after the scheme")
        if "{" in host:
            raise ValueError("must name its host literally, without a placeholder")
        return template

    return check


CommitUrl = Annotated[str, StringConstraints(min_length=1), AfterValidator(_url_template("commit"))]
RangeUrl = Annotated[
    str, StringConstraints(min_length=1), AfterValidator(_url_template("from", "to"))
]

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

    name: EntryName = Field(
        description=(
            "The name, used as the key for its values. Letters, digits and underscores, starting "
            "with a letter. Case-sensitive: `IPC` and `ipc` are different names. Must be unique "
            "within its list."
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
    sample of a test reports its value under the metric's name.

    The name can't be `run_id`, `test_id`, `repetition` or `machine_id`.
    """

    model_config = ConfigDict(json_schema_extra={"examples": [examples.METRICS[0]]})

    LIST: ClassVar[str] = "metrics"
    RESERVED_COLUMNS: ClassVar[Mapping[str, frozenset[str]]] = {
        "sample": frozenset({"run_id", "test_id", "repetition"}),
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
    # Last, so that the key global revision 0004 appends to stored metrics is where the server
    # writes it too.
    dashboard: bool = Field(
        default=False,
        description=(
            "Whether the web UI's Dashboard shows a card for this metric. Only `real` and "
            "`integer` metrics can be shown."
        ),
    )

    @model_validator(mode="after")
    def _dashboard_is_numeric_only(self) -> Self:
        # D3: a card charts a geomean, which only a numeric metric has.
        if self.dashboard and self.type not in NUMERIC_TYPES:
            raise ValueError(
                f"'{self.name}' is '{self.type.value}', and only a 'real' or 'integer' metric can "
                f"be shown on the dashboard"
            )
        return self


# Optional metadata on `{suite}.commit` (D5).
class CommitField(_SearchableEntry):
    """A piece of information a commit can have in its `fields`, such as its author.

    The name can't be `id`, `commit`, `ordinal`, `tag`, `first_seen_at` or
    `delete_after_inactive_days`.
    """

    model_config = ConfigDict(json_schema_extra={"examples": [examples.COMMIT_FIELDS[0]]})

    LIST: ClassVar[str] = "commit_fields"
    RESERVED_COLUMNS: ClassVar[Mapping[str, frozenset[str]]] = {
        "commit": frozenset(
            {"id", "commit", "ordinal", "tag", "first_seen_at", "delete_after_inactive_days"}
        )
    }

    display: bool = Field(
        default=False,
        description=(
            "Whether the UI should show this field instead of the commit's value, for example a "
            "short SHA. Only one commit field can set this, and it must be a `text` field."
        ),
    )

    # Last, so that the key global revision 0006 appends to stored commit fields is where the server
    # writes it too.
    listed: bool = Field(
        default=False,
        description=(
            "Whether the web UI's list of commits shows this field in a column of its own."
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

    The name can't be `id`, `name`, `tracked`, `first_seen_at` or `delete_after_inactive_days`.
    """

    model_config = ConfigDict(json_schema_extra={"examples": [examples.MACHINE_FIELDS[0]]})

    LIST: ClassVar[str] = "machine_fields"
    RESERVED_COLUMNS: ClassVar[Mapping[str, frozenset[str]]] = {
        "machine": frozenset(
            {"id", "name", "tracked", "first_seen_at", "delete_after_inactive_days"}
        )
    }

    # As on `CommitField`, last, where global revision 0006 appends it.
    listed: bool = Field(
        default=False,
        description=(
            "Whether the web UI's list of machines shows this field in a column of its own."
        ),
    )


# Shared with the update model in `evolve.py`, which adds what null means there.
TEMPLATE_RULES = (
    "It must start with `http://` or `https://`, name its host literally, and contain no spaces, "
    "ASCII control characters, or braces other than its placeholders'. Clients replace every "
    "placeholder, percent-encoding the value: every character but an ASCII letter, a digit or one "
    "of `-_.!~*'()`."
)
COMMIT_URL = (
    "A template of the URL of a commit in the repository, in which `{commit}` stands for the "
    f"commit's value, such as a Git SHA. It must contain `{{commit}}`. {TEMPLATE_RULES}"
)
RANGE_URL = (
    "A template of the URL of the changes between two commits, in which `{from}` stands for the "
    "commit they start from, whose changes are not included, and `{to}` for the one they end at, "
    "whose changes are, as in Git's `from..to`. It must contain both `{from}` and `{to}`. "
    f"{TEMPLATE_RULES}"
)
REPOSITORY_LABEL = (
    'What the repository is called in links to it, such as `GitHub`, as in "View on GitHub".'
)


# D4: presentation metadata, like `display` and `listed`. The server stores these templates and
# checks them, but never fills them in.
class Repository(BaseModel):
    """The repository holding the suite's commits, so that clients can link a commit, or the changes
    between two commits, to it. Each key is null when not set."""

    model_config = ConfigDict(
        extra="forbid",
        # As for `Entry`: optional in a request, and always present in a response.
        json_schema_serialization_defaults_required=True,
        json_schema_extra={"examples": [examples.REPOSITORY]},
    )

    label: Label | None = Field(
        default=None, description=f"{REPOSITORY_LABEL} Null if it has no name."
    )
    commit_url: CommitUrl | None = Field(default=None, description=f"{COMMIT_URL} Null if none.")
    range_url: RangeUrl | None = Field(default=None, description=f"{RANGE_URL} Null if none.")


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
    """A test suite's schema: its name, the metrics, commit fields and machine fields it defines,
    and the repository its commits come from. A suite can only store what its schema defines.

    The same document is used to create a suite and is returned when reading one (with all
    optional keys filled in), so a suite read from one instance can be created as-is on another.
    """

    model_config = ConfigDict(
        extra="forbid",
        # As for `Entry`: the lists are optional in a request, and always present in a response.
        json_schema_serialization_defaults_required=True,
        json_schema_extra={"examples": [examples.SUITE_SCHEMA]},
    )

    name: SuiteNameStr = Field(
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
    # Last, so that the key global revision 0007 appends to stored schemas is where the server
    # writes it too.
    repository: Repository = Field(
        default_factory=Repository,
        description="The repository holding the suite's commits, for clients to link to.",
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

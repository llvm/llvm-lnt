"""
v5 YAML schema parser.

Parses test suite schema files that define commit_fields, machine_fields,
and metrics for a v5 test suite. Produces dataclass-based schema objects
used by the dynamic model factory.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml


# Column names that are always present on the Commit table and therefore
# cannot be used as user-defined commit_field names.
_RESERVED_COMMIT_NAMES = frozenset({"id", "commit", "ordinal"})

# Column names that are always present on the Machine table.
_RESERVED_MACHINE_NAMES = frozenset({"id", "name", "parameters"})

# Column names that are always present on the Sample table and therefore
# cannot be used as metric names.
_RESERVED_SAMPLE_NAMES = frozenset({"id", "run_id", "test_id"})

# Supported column types for commit_fields and the SQLAlchemy type they map to.
# The mapping to actual SQLAlchemy types is done in models.py; here we just
# validate the string values.
VALID_COMMIT_FIELD_TYPES = frozenset({"default", "text", "integer", "datetime"})

# Supported metric types (maps to Sample column types).
VALID_METRIC_TYPES = frozenset({"real", "status", "hash"})


@dataclass(frozen=True, slots=True)
class CommitField:
    """A user-defined metadata column on the Commit table."""
    name: str
    type: str = "default"       # default | text | integer | datetime
    searchable: bool = False
    display: bool = False


@dataclass(frozen=True, slots=True)
class MachineField:
    """A user-defined column on the Machine table."""
    name: str
    searchable: bool = False


@dataclass(frozen=True, slots=True)
class Metric:
    """A metric column on the Sample table."""
    name: str
    type: str = "real"          # real | status | hash
    display_name: str | None = None
    unit: str | None = None
    unit_abbrev: str | None = None
    bigger_is_better: bool = False


@dataclass(frozen=True, slots=True)
class TestSuiteSchema:
    """Parsed v5 test suite schema."""
    name: str
    metrics: list[Metric] = field(default_factory=list)
    commit_fields: list[CommitField] = field(default_factory=list)
    machine_fields: list[MachineField] = field(default_factory=list)
    # Cached filtered lists (set in __post_init__)
    _searchable_commit_fields: list[CommitField] = field(
        default_factory=list, init=False, repr=False, compare=False,
    )
    _searchable_machine_fields: list[MachineField] = field(
        default_factory=list, init=False, repr=False, compare=False,
    )

    def __post_init__(self) -> None:
        object.__setattr__(
            self,
            "_searchable_commit_fields",
            [f for f in self.commit_fields if f.searchable],
        )
        object.__setattr__(
            self,
            "_searchable_machine_fields",
            [f for f in self.machine_fields if f.searchable],
        )

    @property
    def searchable_commit_fields(self) -> list[CommitField]:
        return self._searchable_commit_fields

    @property
    def searchable_machine_fields(self) -> list[MachineField]:
        return self._searchable_machine_fields


class SchemaError(Exception):
    """Raised when a schema file is invalid."""


def _parse_commit_fields(raw: list[dict[str, Any]]) -> list[CommitField]:
    fields: list[CommitField] = []
    seen: set[str] = set()
    for entry in raw:
        name = entry.get("name")
        if not name or not isinstance(name, str):
            raise SchemaError("commit_fields entry missing 'name'")
        if name in _RESERVED_COMMIT_NAMES:
            raise SchemaError(
                f"commit_fields name {name!r} is reserved "
                f"(cannot use {sorted(_RESERVED_COMMIT_NAMES)})"
            )
        if name in seen:
            raise SchemaError(f"duplicate commit_fields name: {name!r}")
        seen.add(name)

        ftype = entry.get("type", "default")
        if ftype not in VALID_COMMIT_FIELD_TYPES:
            raise SchemaError(
                f"commit_fields[{name!r}] has unknown type {ftype!r}; "
                f"valid types: {sorted(VALID_COMMIT_FIELD_TYPES)}"
            )
        searchable = bool(entry.get("searchable", False))
        display = bool(entry.get("display", False))
        fields.append(CommitField(
            name=name, type=ftype, searchable=searchable, display=display,
        ))

    # At most one commit_field may have display=True (design D4).
    display_count = sum(1 for f in fields if f.display)
    if display_count > 1:
        display_names = [f.name for f in fields if f.display]
        raise SchemaError(
            f"at most one commit_field may have display=true, "
            f"but found {display_count}: {display_names}"
        )

    return fields


def _parse_machine_fields(raw: list[dict[str, Any]]) -> list[MachineField]:
    fields: list[MachineField] = []
    seen: set[str] = set()
    for entry in raw:
        name = entry.get("name")
        if not name or not isinstance(name, str):
            raise SchemaError("machine_fields entry missing 'name'")
        if name in _RESERVED_MACHINE_NAMES:
            raise SchemaError(
                f"machine_fields name {name!r} is reserved "
                f"(cannot use {sorted(_RESERVED_MACHINE_NAMES)})"
            )
        if name in seen:
            raise SchemaError(f"duplicate machine_fields name: {name!r}")
        seen.add(name)

        searchable = bool(entry.get("searchable", False))
        fields.append(MachineField(name=name, searchable=searchable))
    return fields


def _parse_metrics(raw: list[dict[str, Any]]) -> list[Metric]:
    metrics: list[Metric] = []
    seen: set[str] = set()
    for entry in raw:
        name = entry.get("name")
        if not name or not isinstance(name, str):
            raise SchemaError("metrics entry missing 'name'")
        if name in _RESERVED_SAMPLE_NAMES:
            raise SchemaError(
                f"metric name {name!r} is reserved "
                f"(cannot use {sorted(_RESERVED_SAMPLE_NAMES)})"
            )
        if name in seen:
            raise SchemaError(f"duplicate metric name: {name!r}")
        seen.add(name)

        mtype = entry.get("type", "real").lower()
        if mtype not in VALID_METRIC_TYPES:
            raise SchemaError(
                f"metrics[{name!r}] has unknown type {mtype!r}; "
                f"valid types: {sorted(VALID_METRIC_TYPES)}"
            )
        metrics.append(Metric(
            name=name,
            type=mtype,
            display_name=entry.get("display_name"),
            unit=entry.get("unit"),
            unit_abbrev=entry.get("unit_abbrev"),
            bigger_is_better=bool(entry.get("bigger_is_better", False)),
        ))
    return metrics


def parse_schema(data: dict[str, Any]) -> TestSuiteSchema:
    """Parse a raw YAML dict into a :class:`TestSuiteSchema`.

    Raises :class:`SchemaError` on validation failures.
    """
    name = data.get("name")
    if not name or not isinstance(name, str):
        raise SchemaError("schema missing required 'name' field")

    metrics = _parse_metrics(data.get("metrics", []))
    commit_fields = _parse_commit_fields(data.get("commit_fields", []))
    machine_fields = _parse_machine_fields(data.get("machine_fields", []))

    return TestSuiteSchema(
        name=name,
        metrics=metrics,
        commit_fields=commit_fields,
        machine_fields=machine_fields,
    )


def load_schema_file(path: str | Path) -> TestSuiteSchema:
    """Load and parse a YAML schema file.

    Raises :class:`SchemaError` on validation failures or
    :class:`FileNotFoundError` / :class:`yaml.YAMLError` on I/O / parse errors.
    """
    with open(path) as f:
        data = yaml.safe_load(f)
    if not isinstance(data, dict):
        raise SchemaError(f"schema file {path} does not contain a YAML mapping")
    return parse_schema(data)

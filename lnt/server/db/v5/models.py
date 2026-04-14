"""
Dynamic SQLAlchemy model factory for v5 per-suite tables.

Creates model classes at runtime based on a :class:`TestSuiteSchema`, producing
per-suite tables such as ``nts_Commit``, ``nts_Machine``, etc.

Postgres only.  SQLAlchemy 1.3 style (Column, relation, declarative_base).
"""

from __future__ import annotations

import uuid as uuid_module
from dataclasses import dataclass
from typing import Any

import sqlalchemy
import sqlalchemy.ext.declarative
from sqlalchemy import (
    Boolean,
    Column,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import relation

from .schema import TestSuiteSchema


# ---------------------------------------------------------------------------
# Global tables (shared across all suites)
# ---------------------------------------------------------------------------

_global_base = sqlalchemy.ext.declarative.declarative_base()


class V5Schema(_global_base):                          # type: ignore[misc]
    """Persisted test suite schema (one row per suite)."""
    __tablename__ = "v5_schema"
    name = Column("name", String(256), primary_key=True)
    schema_json = Column("schema_json", Text, nullable=False)
    created_at = Column("created_at", DateTime, nullable=False)


class V5SchemaVersion(_global_base):                   # type: ignore[misc]
    """Single-row counter for multi-process schema cache invalidation."""
    __tablename__ = "v5_schema_version"
    id = Column("id", Integer, primary_key=True)
    version = Column("version", Integer, nullable=False)


class APIKey(_global_base):                             # type: ignore[misc]
    """API key for v5 REST API authentication."""
    __tablename__ = "APIKey"
    id = Column("ID", Integer, primary_key=True)
    name = Column("Name", String(256), nullable=False)
    key_prefix = Column("KeyPrefix", String(8), nullable=False)
    key_hash = Column("KeyHash", String(64), nullable=False, unique=True,
                      index=True)
    scope = Column("Scope", String(32), nullable=False)
    created_at = Column("CreatedAt", DateTime, nullable=False)
    last_used_at = Column("LastUsedAt", DateTime, nullable=True)
    is_active = Column("IsActive", Boolean, nullable=False, default=True)


def create_global_tables(engine) -> None:
    """Create the global v5 tables (schema, schema_version, APIKey)."""
    _global_base.metadata.create_all(engine)


# ---------------------------------------------------------------------------
# Column type mapping
# ---------------------------------------------------------------------------

_COMMIT_FIELD_TYPE_MAP: dict[str, Any] = {
    "default": lambda: String(256),
    "text": lambda: Text,
    "integer": lambda: Integer,
    "datetime": lambda: DateTime,
}

_METRIC_TYPE_MAP: dict[str, Any] = {
    "real": lambda: Float,
    "status": lambda: Integer,
    "hash": lambda: String(256),
}


# ---------------------------------------------------------------------------
# Public dataclass holding all generated models for a single test suite
# ---------------------------------------------------------------------------

@dataclass
class SuiteModels:
    """Container for all SQLAlchemy model classes of a single test suite."""
    base: Any                    # declarative base
    Commit: Any = None
    Machine: Any = None
    Run: Any = None
    Test: Any = None
    Sample: Any = None
    FieldChange: Any = None
    Regression: Any = None
    RegressionIndicator: Any = None


# ---------------------------------------------------------------------------
# Factory
# ---------------------------------------------------------------------------

def create_suite_models(schema: TestSuiteSchema) -> SuiteModels:
    """Build SQLAlchemy model classes for the given *schema*.

    Each suite gets its own ``declarative_base()`` so that per-suite tables
    can be created independently.
    """
    base = sqlalchemy.ext.declarative.declarative_base()
    prefix = schema.name

    # -----------------------------------------------------------------------
    # Commit
    # -----------------------------------------------------------------------
    commit_attrs: dict[str, Any] = {
        "__tablename__": f"{prefix}_Commit",
        "id": Column("id", Integer, primary_key=True),
        "commit": Column("commit", String(256), unique=True, nullable=False),
        "ordinal": Column("ordinal", Integer, nullable=True),
        "__table_args__": (
            UniqueConstraint(
                "ordinal",
                name=f"{prefix}_Commit_ordinal_unique",
            ),
        ),
    }
    # Dynamic commit_fields columns
    for cf in schema.commit_fields:
        if cf.name in commit_attrs:
            raise ValueError(
                f"commit_fields name {cf.name!r} collides with a built-in column"
            )
        col_type = _COMMIT_FIELD_TYPE_MAP[cf.type]()
        commit_attrs[cf.name] = Column(
            cf.name, col_type, nullable=True, index=cf.searchable,
        )

    Commit = type("Commit", (base,), commit_attrs)

    # -----------------------------------------------------------------------
    # Machine
    # -----------------------------------------------------------------------
    machine_attrs: dict[str, Any] = {
        "__tablename__": f"{prefix}_Machine",
        "id": Column("id", Integer, primary_key=True),
        "name": Column("name", String(256), unique=True, nullable=False),
        "parameters": Column(
            "parameters", JSONB, nullable=False,
            server_default=sqlalchemy.text("'{}'::jsonb"),
        ),
    }
    for mf in schema.machine_fields:
        if mf.name in machine_attrs:
            raise ValueError(
                f"machine_fields name {mf.name!r} collides with a built-in column"
            )
        machine_attrs[mf.name] = Column(
            mf.name, String(256), nullable=True, index=mf.searchable,
        )

    Machine = type("Machine", (base,), machine_attrs)

    # -----------------------------------------------------------------------
    # Run
    # -----------------------------------------------------------------------
    run_attrs: dict[str, Any] = {
        "__tablename__": f"{prefix}_Run",
        "id": Column("id", Integer, primary_key=True),
        "uuid": Column(
            "uuid", String(36), unique=True, nullable=False, index=True,
            default=lambda: str(uuid_module.uuid4()),
        ),
        "machine_id": Column(
            "machine_id", Integer,
            ForeignKey(f"{prefix}_Machine.id", ondelete="CASCADE"),
            nullable=False, index=True,
        ),
        "commit_id": Column(
            "commit_id", Integer,
            ForeignKey(f"{prefix}_Commit.id", ondelete="CASCADE"),
            nullable=False, index=True,
        ),
        "submitted_at": Column("submitted_at", DateTime, nullable=False, index=True),
        "run_parameters": Column(
            "run_parameters", JSONB, nullable=False,
            server_default=sqlalchemy.text("'{}'::jsonb"),
        ),
        "machine": relation("Machine", foreign_keys=f"{prefix}_Run.c.machine_id"),
        "commit_obj": relation("Commit", foreign_keys=f"{prefix}_Run.c.commit_id"),
    }

    Run = type("Run", (base,), run_attrs)

    # Compound index on (machine_id, commit_id) for time-series join pattern
    Index(
        f"ix_{prefix}_Run_machine_id_commit_id",
        Run.machine_id, Run.commit_id,  # type: ignore[attr-defined]
    )

    # -----------------------------------------------------------------------
    # Test
    # -----------------------------------------------------------------------
    test_attrs: dict[str, Any] = {
        "__tablename__": f"{prefix}_Test",
        "id": Column("id", Integer, primary_key=True),
        "name": Column("name", String(256), unique=True, nullable=False),
    }
    Test = type("Test", (base,), test_attrs)

    # -----------------------------------------------------------------------
    # Sample
    # -----------------------------------------------------------------------
    sample_attrs: dict[str, Any] = {
        "__tablename__": f"{prefix}_Sample",
        "id": Column("id", Integer, primary_key=True),
        "run_id": Column(
            "run_id", Integer,
            ForeignKey(f"{prefix}_Run.id", ondelete="CASCADE"),
            nullable=False,
        ),
        "test_id": Column(
            "test_id", Integer,
            ForeignKey(f"{prefix}_Test.id", ondelete="CASCADE"),
            nullable=False,
        ),
        "run": relation("Run", foreign_keys=f"{prefix}_Sample.c.run_id"),
        "test": relation("Test", foreign_keys=f"{prefix}_Sample.c.test_id"),
    }
    # Dynamic metric columns
    for metric in schema.metrics:
        if metric.name in sample_attrs:
            raise ValueError(
                f"metric name {metric.name!r} collides with a built-in column"
            )
        col_type = _METRIC_TYPE_MAP[metric.type]()
        sample_attrs[metric.name] = Column(metric.name, col_type, nullable=True)

    Sample = type("Sample", (base,), sample_attrs)

    # Covers the most common sample query: "all metrics for a given run+test pair"
    # Compound index on (run_id, test_id)
    Index(
        f"ix_{prefix}_Sample_run_id_test_id",
        Sample.run_id, Sample.test_id,  # type: ignore[attr-defined]
    )

    # -----------------------------------------------------------------------
    # FieldChange
    # -----------------------------------------------------------------------
    fc_attrs: dict[str, Any] = {
        "__tablename__": f"{prefix}_FieldChange",
        "id": Column("id", Integer, primary_key=True),
        "uuid": Column(
            "uuid", String(36), unique=True, nullable=False, index=True,
            default=lambda: str(uuid_module.uuid4()),
        ),
        "test_id": Column(
            "test_id", Integer,
            ForeignKey(f"{prefix}_Test.id"),
            nullable=False, index=True,
        ),
        "machine_id": Column(
            "machine_id", Integer,
            ForeignKey(f"{prefix}_Machine.id"),
            nullable=False, index=True,
        ),
        "field_name": Column("field_name", String(256), nullable=False),
        "start_commit_id": Column(
            "start_commit_id", Integer,
            ForeignKey(f"{prefix}_Commit.id"),
            nullable=False, index=True,
        ),
        "end_commit_id": Column(
            "end_commit_id", Integer,
            ForeignKey(f"{prefix}_Commit.id"),
            nullable=False, index=True,
        ),
        "old_value": Column("old_value", Float, nullable=True),
        "new_value": Column("new_value", Float, nullable=True),
        "test": relation("Test", foreign_keys=f"{prefix}_FieldChange.c.test_id"),
        "machine": relation("Machine", foreign_keys=f"{prefix}_FieldChange.c.machine_id"),
        "start_commit": relation(
            "Commit",
            foreign_keys=f"{prefix}_FieldChange.c.start_commit_id",
        ),
        "end_commit": relation(
            "Commit",
            foreign_keys=f"{prefix}_FieldChange.c.end_commit_id",
        ),
    }
    FieldChange = type("FieldChange", (base,), fc_attrs)

    # Covers regression lookup: "field changes for a specific test on a machine"
    # Compound index on (machine_id, test_id, field_name)
    Index(
        f"ix_{prefix}_FieldChange_machine_test_field",
        FieldChange.machine_id, FieldChange.test_id, FieldChange.field_name,  # type: ignore[attr-defined]
    )

    # -----------------------------------------------------------------------
    # Regression
    # -----------------------------------------------------------------------
    reg_attrs: dict[str, Any] = {
        "__tablename__": f"{prefix}_Regression",
        "id": Column("id", Integer, primary_key=True),
        "uuid": Column(
            "uuid", String(36), unique=True, nullable=False, index=True,
            default=lambda: str(uuid_module.uuid4()),
        ),
        "title": Column("title", String(256), nullable=True),
        "bug": Column("bug", String(256), nullable=True),
        "state": Column("state", Integer, nullable=False, index=True),
    }
    Regression = type("Regression", (base,), reg_attrs)

    # -----------------------------------------------------------------------
    # RegressionIndicator
    # -----------------------------------------------------------------------
    ri_attrs: dict[str, Any] = {
        "__tablename__": f"{prefix}_RegressionIndicator",
        "id": Column("id", Integer, primary_key=True),
        "regression_id": Column(
            "regression_id", Integer,
            ForeignKey(f"{prefix}_Regression.id", ondelete="CASCADE"),
            nullable=False, index=True,
        ),
        "field_change_id": Column(
            "field_change_id", Integer,
            ForeignKey(f"{prefix}_FieldChange.id", ondelete="CASCADE"),
            nullable=False, index=True,
        ),
        "__table_args__": (
            UniqueConstraint("regression_id", "field_change_id",
                             name=f"uq_{prefix}_ri_regression_fieldchange"),
        ),
        "regression": relation(
            "Regression",
            foreign_keys=f"{prefix}_RegressionIndicator.c.regression_id",
        ),
        "field_change": relation(
            "FieldChange",
            foreign_keys=f"{prefix}_RegressionIndicator.c.field_change_id",
        ),
    }
    RegressionIndicator = type("RegressionIndicator", (base,), ri_attrs)

    # -----------------------------------------------------------------------
    # Back-references (added after all classes exist)
    # -----------------------------------------------------------------------
    Machine.runs = relation(  # type: ignore[attr-defined]
        Run,
        foreign_keys=[Run.machine_id],  # type: ignore[attr-defined]
        back_populates="machine",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )
    Commit.runs = relation(  # type: ignore[attr-defined]
        Run,
        foreign_keys=[Run.commit_id],  # type: ignore[attr-defined]
        back_populates="commit_obj",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )
    Run.samples = relation(  # type: ignore[attr-defined]
        Sample,
        foreign_keys=[Sample.run_id],  # type: ignore[attr-defined]
        back_populates="run",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )
    Test.samples = relation(  # type: ignore[attr-defined]
        Sample,
        foreign_keys=[Sample.test_id],  # type: ignore[attr-defined]
        back_populates="test",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )
    FieldChange.regression_indicators = relation(  # type: ignore[attr-defined]
        RegressionIndicator,
        foreign_keys=[RegressionIndicator.field_change_id],  # type: ignore[attr-defined]
        back_populates="field_change",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )
    Regression.indicators = relation(  # type: ignore[attr-defined]
        RegressionIndicator,
        foreign_keys=[RegressionIndicator.regression_id],  # type: ignore[attr-defined]
        back_populates="regression",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )

    return SuiteModels(
        base=base,
        Commit=Commit,
        Machine=Machine,
        Run=Run,
        Test=Test,
        Sample=Sample,
        FieldChange=FieldChange,
        Regression=Regression,
        RegressionIndicator=RegressionIndicator,
    )

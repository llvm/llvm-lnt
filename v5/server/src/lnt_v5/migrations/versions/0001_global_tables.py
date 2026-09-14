"""The global tables: schema, schema_version, api_key.

Revision ID: 0001
Revises:
Create Date: 2026-09-11

A migration is a frozen snapshot, so the widths, defaults and constraint names below are spelled
out literally rather than imported from `lnt_v5.tables`. If that module changes, this file must
not: a new revision carries the change forward. `test_migrations.py` compares the two and fails
when they have drifted apart.
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0001"
down_revision: str | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "schema",
        sa.Column("name", sa.String(length=63), nullable=False),
        sa.Column("schema_json", sa.Text(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("name", name=op.f("pk_schema")),
    )

    op.create_table(
        "schema_version",
        sa.Column("id", sa.Integer(), autoincrement=False, nullable=False),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.CheckConstraint("id = 1", name=op.f("ck_schema_version_single_row")),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_schema_version")),
    )
    # D5: the row exists from the moment the database does, so every reader can address it
    # directly instead of coping with its absence.
    op.execute("INSERT INTO schema_version (id, version) VALUES (1, 0)")

    op.create_table(
        "api_key",
        sa.Column("id", sa.Integer(), sa.Identity(always=False), nullable=False),
        sa.Column("prefix", sa.String(length=8), nullable=False),
        sa.Column("key_hash", sa.String(length=64), nullable=False),
        sa.Column("name", sa.String(length=256), nullable=False),
        sa.Column("scope", sa.String(length=32), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("last_used_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("is_active", sa.Boolean(), server_default=sa.text("true"), nullable=False),
        sa.CheckConstraint(
            "scope IN ('read', 'submit', 'triage', 'manage', 'admin')",
            name=op.f("ck_api_key_scope"),
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_api_key")),
        sa.UniqueConstraint("key_hash", name=op.f("uq_api_key_key_hash")),
        sa.UniqueConstraint("prefix", name=op.f("uq_api_key_prefix")),
    )


def downgrade() -> None:
    op.drop_table("api_key")
    op.drop_table("schema_version")
    op.drop_table("schema")

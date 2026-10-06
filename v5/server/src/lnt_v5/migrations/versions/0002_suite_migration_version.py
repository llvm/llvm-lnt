"""Record how far each suite's tables have been brought forward.

Revision ID: 0002
Revises: 0001
Create Date: 2026-10-06

D6 migrates the tables of every existing suite, and `schema.migration_version` is where
each suite's position in that sequence is recorded (D5). Frozen like 0001: nothing is imported from
`lnt_v5.tables`.
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0002"
down_revision: str | None = "0001"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # Any suite that already exists has the structure from before the first per-suite step, which
    # is version 0. The default only fills in those rows and is dropped straight away: creating a
    # suite has to state the version it creates, so that forgetting to cannot record a suite at 0
    # and replay every step onto tables that already have them.
    op.add_column(
        "schema",
        sa.Column("migration_version", sa.Integer(), server_default=sa.text("0"), nullable=False),
    )
    op.alter_column("schema", "migration_version", server_default=None)


def downgrade() -> None:
    op.drop_column("schema", "migration_version")

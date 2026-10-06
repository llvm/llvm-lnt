"""Record which migration version each suite's tables are at.

Revision ID: 0002
Revises: 0001
Create Date: 2026-10-06

Each suite's tables are migrated separately (D6), and `schema.migration_version` records how many
of those migrations each suite has had (D5). Like 0001, this revision is frozen: nothing is imported
from `lnt_v5.tables`.
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
    # Suites that already exist have the structure from before the first per-suite step, which is
    # version 0. The default only fills in those rows, and is dropped immediately afterwards.
    # Creating a suite then has to give the version explicitly. Otherwise, a new suite could be
    # recorded at 0 by mistake, and every step would later be applied again to tables that already
    # have it.
    op.add_column(
        "schema",
        sa.Column("migration_version", sa.Integer(), server_default=sa.text("0"), nullable=False),
    )
    op.alter_column("schema", "migration_version", server_default=None)


def downgrade() -> None:
    op.drop_column("schema", "migration_version")

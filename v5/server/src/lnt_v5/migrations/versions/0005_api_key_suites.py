"""Let an API key be restricted to some test suites.

Revision ID: 0005
Revises: 0004
Create Date: 2026-10-25

Adds `api_key.suites` (D5): null for a key valid across the instance, which is what every existing
key stays, or the names of the suites the key is restricted to (I5). Like the earlier revisions,
this one is frozen: nothing is imported from `lnt_v5.tables`.
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0005"
down_revision: str | None = "0004"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("api_key", sa.Column("suites", sa.ARRAY(sa.String(length=63)), nullable=True))
    op.create_check_constraint(
        op.f("ck_api_key_suites"),
        "api_key",
        "suites IS NULL OR (cardinality(suites) > 0 AND array_position(suites, NULL) IS NULL "
        "AND scope NOT IN ('read', 'admin'))",
    )


def downgrade() -> None:
    # Earlier builds would read a restricted key as valid across the instance, so it is revoked
    # rather than silently widened.
    op.execute("UPDATE api_key SET is_active = false WHERE suites IS NOT NULL")
    op.drop_constraint(op.f("ck_api_key_suites"), "api_key", type_="check")
    op.drop_column("api_key", "suites")

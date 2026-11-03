"""Restrict API keys to whole projects.

Revision ID: 0012
Revises: 0011
Create Date: 2026-10-30

An entry of a restricted key's list is a whole project or a single suite (I5), so an
`api_key_restriction` row refers to a project or to a suite, exactly one of the two, each by
identity and removed with it (D5). Existing rows are single-suite entries, and stay as they are.

Like the earlier revisions, this one is frozen: nothing is imported from `lnt_v5.tables`.
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0012"
down_revision: str | None = "0011"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("api_key_restriction", sa.Column("project_id", sa.Integer(), nullable=True))
    op.create_foreign_key(
        op.f("fk_api_key_restriction_project_id_project"),
        "api_key_restriction",
        "project",
        ["project_id"],
        ["id"],
        ondelete="CASCADE",
    )
    op.alter_column("api_key_restriction", "suite_id", existing_type=sa.Integer(), nullable=True)
    op.create_check_constraint(
        op.f("ck_api_key_restriction_one_target"),
        "api_key_restriction",
        "(project_id IS NULL) <> (suite_id IS NULL)",
    )
    op.create_unique_constraint(
        op.f("uq_api_key_restriction_api_key_id_project_id"),
        "api_key_restriction",
        ["api_key_id", "project_id"],
    )


def downgrade() -> None:
    # Earlier builds list single suites only. A whole project becomes the suites it holds now, which
    # narrows the key (it no longer covers the suites created in the project later, nor the project
    # in full) rather than widening it. A key may already list one of them too (I5). A key whose
    # projects held no suite, and that listed nothing else, is left restricted to nothing, which
    # earlier builds store.
    op.execute(
        "INSERT INTO api_key_restriction (api_key_id, suite_id) "
        "SELECT api_key_restriction.api_key_id, schema.id "
        "FROM api_key_restriction JOIN schema "
        "ON schema.project_id = api_key_restriction.project_id "
        "ON CONFLICT ON CONSTRAINT uq_api_key_restriction_api_key_id_suite_id DO NOTHING"
    )
    op.execute("DELETE FROM api_key_restriction WHERE project_id IS NOT NULL")

    op.drop_constraint(
        op.f("uq_api_key_restriction_api_key_id_project_id"), "api_key_restriction", type_="unique"
    )
    op.drop_constraint(
        op.f("ck_api_key_restriction_one_target"), "api_key_restriction", type_="check"
    )
    op.alter_column("api_key_restriction", "suite_id", existing_type=sa.Integer(), nullable=False)
    op.drop_constraint(
        op.f("fk_api_key_restriction_project_id_project"),
        "api_key_restriction",
        type_="foreignkey",
    )
    op.drop_column("api_key_restriction", "project_id")

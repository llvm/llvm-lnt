"""Group test suites into projects.

Revision ID: 0011
Revises: 0010
Create Date: 2026-10-30

D7 has every suite belong to exactly one project, with suite names unique within their project
only. Each existing suite is put in a project of its own, named after it, with no display name.
API keys are unaffected: their restrictions refer to suites by identity (D5), which this revision
keeps.

Like the earlier revisions, this one is frozen: nothing is imported from `lnt_v5.tables`. It stays
in the default namespace (D6): the label of each suite's namespace, which now names the suite by its
full name, is rewritten by a step of the suite's own migrations (version 8, in
`lnt_v5.suites.migrations`).
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0011"
down_revision: str | None = "0010"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "project",
        sa.Column("id", sa.Integer(), sa.Identity(always=False), nullable=False),
        sa.Column("name", sa.String(length=64), nullable=False),
        sa.Column("display_name", sa.String(length=256), nullable=True),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_project")),
        sa.UniqueConstraint("name", name=op.f("uq_project_name")),
    )
    op.execute("INSERT INTO project (name) SELECT name FROM schema ORDER BY name")

    op.add_column("schema", sa.Column("project_id", sa.Integer(), nullable=True))
    op.execute(
        "UPDATE schema SET project_id = project.id FROM project WHERE project.name = schema.name"
    )
    op.alter_column("schema", "project_id", existing_type=sa.Integer(), nullable=False)
    op.create_foreign_key(
        op.f("fk_schema_project_id_project"), "schema", "project", ["project_id"], ["id"]
    )
    op.drop_constraint(op.f("uq_schema_name"), "schema", type_="unique")
    op.create_unique_constraint(op.f("uq_schema_project_id_name"), "schema", ["project_id", "name"])

    # Creating a project bumps the counter, like any other change to one (D2, D5).
    op.execute(
        "UPDATE schema_version SET version = version + 1 "
        "WHERE id = 1 AND EXISTS (SELECT FROM project)"
    )


def downgrade() -> None:
    # Earlier builds address a suite by its name alone, which must then be unique across the
    # instance again.
    connection = op.get_bind()
    shared = connection.execute(
        sa.text("SELECT name FROM schema GROUP BY name HAVING count(*) > 1 ORDER BY name")
    ).scalars()
    if names := list(shared):
        raise RuntimeError(
            "cannot downgrade: earlier builds need every test suite to have a name of its own, "
            "and several projects have a suite named " + ", ".join(names)
        )

    op.drop_constraint(op.f("uq_schema_project_id_name"), "schema", type_="unique")
    op.create_unique_constraint(op.f("uq_schema_name"), "schema", ["name"])
    op.drop_constraint(op.f("fk_schema_project_id_project"), "schema", type_="foreignkey")
    op.drop_column("schema", "project_id")
    op.drop_table("project")

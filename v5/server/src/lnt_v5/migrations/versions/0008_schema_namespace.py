"""Record the namespace holding each suite's tables, and allow longer suite names.

Revision ID: 0008
Revises: 0007
Create Date: 2026-10-29

D5 now has the server choose a suite's namespace when it creates the suite, and record it in
`schema.namespace`, rather than name the namespace after the suite. Every existing suite keeps the
namespace it was created in, which is its name: this revision records it as it is, and renames
nothing, so it stays confined to the default namespace (D6). The sequence numbers the namespaces of
the suites created from now on (see `lnt_v5.suites.store`).

D4 also allows suite names of 64 characters now, which `schema.name` and `api_key.suites` widen to.

Like the earlier revisions, this one is frozen: nothing is imported from `lnt_v5.tables`.
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0008"
down_revision: str | None = "0007"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("schema", sa.Column("namespace", sa.String(length=63), nullable=True))
    op.execute("UPDATE schema SET namespace = name")
    op.alter_column("schema", "namespace", existing_type=sa.String(length=63), nullable=False)
    op.create_unique_constraint(op.f("uq_schema_namespace"), "schema", ["namespace"])
    op.alter_column(
        "schema",
        "name",
        existing_type=sa.String(length=63),
        type_=sa.String(length=64),
        existing_nullable=False,
    )
    op.alter_column(
        "api_key",
        "suites",
        existing_type=sa.ARRAY(sa.String(length=63)),
        type_=sa.ARRAY(sa.String(length=64)),
        existing_nullable=True,
    )
    op.execute("CREATE SEQUENCE schema_namespace_seq OWNED BY schema.namespace")


def downgrade() -> None:
    # Earlier builds look for a suite's tables in the namespace named after it, and renaming a
    # namespace would reach into a suite's namespace, which no global migration may do (D6). A
    # restricted key may also still name a deleted suite whose name is too long for them.
    connection = op.get_bind()
    moved = connection.execute(
        sa.text("SELECT name FROM schema WHERE namespace <> name ORDER BY name")
    ).scalars()
    if names := list(moved):
        raise RuntimeError(
            "cannot downgrade: these test suites are not in the namespace named after them, so "
            f"earlier builds would not find their tables: {', '.join(names)}"
        )
    too_long = connection.execute(
        sa.text(
            "SELECT DISTINCT suite FROM api_key, unnest(suites) AS suite "
            "WHERE length(suite) > 63 ORDER BY suite"
        )
    ).scalars()
    if names := list(too_long):
        raise RuntimeError(
            "cannot downgrade: API keys name test suites longer than earlier builds allow: "
            + ", ".join(names)
        )

    op.alter_column(
        "api_key",
        "suites",
        existing_type=sa.ARRAY(sa.String(length=64)),
        type_=sa.ARRAY(sa.String(length=63)),
        existing_nullable=True,
    )
    op.alter_column(
        "schema",
        "name",
        existing_type=sa.String(length=64),
        type_=sa.String(length=63),
        existing_nullable=False,
    )
    op.drop_constraint(op.f("uq_schema_namespace"), "schema", type_="unique")
    # Takes the sequence it owns along.
    op.drop_column("schema", "namespace")

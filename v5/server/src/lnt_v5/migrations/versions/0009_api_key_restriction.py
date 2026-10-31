"""Link API key restrictions to suites by identity.

Revision ID: 0009
Revises: 0008
Create Date: 2026-10-29

D5 gives each suite an internal identity, `schema.id`, which becomes the table's primary key in
place of its name. A restricted key now records that it is restricted in `api_key.restricted`, and
the suites it is restricted to as `api_key_restriction` rows referring to them by identity (I5), in
place of the names in `api_key.suites`. Each existing key is restricted to the suites it names that
still exist; the names of deleted suites are dropped, so a key that named only those is restricted
to nothing.

Like the earlier revisions, this one is frozen: nothing is imported from `lnt_v5.tables`.
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0009"
down_revision: str | None = "0008"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # Postgres numbers the existing rows as it adds the identity column.
    op.add_column(
        "schema", sa.Column("id", sa.Integer(), sa.Identity(always=False), nullable=False)
    )
    op.drop_constraint(op.f("pk_schema"), "schema", type_="primary")
    op.create_primary_key(op.f("pk_schema"), "schema", ["id"])
    op.create_unique_constraint(op.f("uq_schema_name"), "schema", ["name"])

    op.add_column(
        "api_key",
        sa.Column("restricted", sa.Boolean(), server_default=sa.text("false"), nullable=False),
    )
    op.execute("UPDATE api_key SET restricted = suites IS NOT NULL")
    op.create_check_constraint(
        op.f("ck_api_key_restricted"),
        "api_key",
        "NOT restricted OR scope NOT IN ('read', 'admin')",
    )

    op.create_table(
        "api_key_restriction",
        sa.Column("api_key_id", sa.Integer(), nullable=False),
        sa.Column("suite_id", sa.Integer(), nullable=False),
        sa.ForeignKeyConstraint(
            ["api_key_id"],
            ["api_key.id"],
            name=op.f("fk_api_key_restriction_api_key_id_api_key"),
        ),
        sa.ForeignKeyConstraint(
            ["suite_id"],
            ["schema.id"],
            name=op.f("fk_api_key_restriction_suite_id_schema"),
            ondelete="CASCADE",
        ),
        sa.UniqueConstraint(
            "api_key_id", "suite_id", name=op.f("uq_api_key_restriction_api_key_id_suite_id")
        ),
    )
    # DISTINCT because nothing but the code creating keys kept a key from naming a suite twice.
    op.execute(
        "INSERT INTO api_key_restriction (api_key_id, suite_id) "
        "SELECT DISTINCT api_key.id, schema.id "
        "FROM api_key, unnest(api_key.suites) AS suite JOIN schema ON schema.name = suite"
    )

    op.drop_constraint(op.f("ck_api_key_suites"), "api_key", type_="check")
    op.drop_column("api_key", "suites")


def downgrade() -> None:
    op.add_column("api_key", sa.Column("suites", sa.ARRAY(sa.String(length=64)), nullable=True))
    # Earlier builds name a key's suites, so a key covers whatever suite has the name now: a suite
    # created later under the name of one deleted since is covered again.
    op.execute(
        "UPDATE api_key SET suites = ARRAY("
        "SELECT schema.name FROM api_key_restriction JOIN schema "
        "ON schema.id = api_key_restriction.suite_id "
        'WHERE api_key_restriction.api_key_id = api_key.id ORDER BY schema.name COLLATE "C")'
        " WHERE restricted"
    )
    # Earlier builds cannot store a key restricted to nothing: an empty list is refused, and a null
    # one would make the key valid across the instance. Such a key is revoked instead, and left with
    # no suites: earlier builds show it as an inactive key valid in every suite, and refuse its
    # token with a 401 even where it could read before.
    op.execute(
        "UPDATE api_key SET is_active = false, suites = NULL "
        "WHERE restricted AND cardinality(suites) = 0"
    )
    op.create_check_constraint(
        op.f("ck_api_key_suites"),
        "api_key",
        "suites IS NULL OR (cardinality(suites) > 0 AND array_position(suites, NULL) IS NULL "
        "AND scope NOT IN ('read', 'admin'))",
    )

    # Before the primary key it refers to.
    op.drop_table("api_key_restriction")

    op.drop_constraint(op.f("ck_api_key_restricted"), "api_key", type_="check")
    op.drop_column("api_key", "restricted")

    op.drop_constraint(op.f("uq_schema_name"), "schema", type_="unique")
    op.drop_constraint(op.f("pk_schema"), "schema", type_="primary")
    op.create_primary_key(op.f("pk_schema"), "schema", ["name"])
    op.drop_column("schema", "id")

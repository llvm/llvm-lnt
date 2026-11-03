"""Group test suites into projects, and link API key restrictions to them by identity.

Revision ID: 0009
Revises: 0008
Create Date: 2026-11-03

D7 has every suite belong to exactly one project, with suite names unique within their project
only. D5 gives each suite an internal identity, `schema.id`, which becomes the table's primary key
in place of its name. Each existing suite is put in a project of its own, named after it, with no
display name.

A restricted key now records that it is restricted in `api_key.restricted`, and what it is
restricted to as `api_key_restriction` rows, each referring by identity to a whole project or to a
single suite (I5), in place of the names in `api_key.suites`. Each existing key is restricted to the
suites it names that still exist; the names of deleted suites are dropped, so a key that named only
those is restricted to nothing.

D4 also lets a suite have a display name, a top-level key of its schema that defaults to null.
Earlier builds had no notion of one, so adding it to every stored schema changes nothing a suite
does, but keeps stored schemas normalized (D5).

Like the earlier revisions, this one is frozen: nothing is imported from `lnt_v5.tables`, and
`schema_json` is read and written with the standard library rather than through
`lnt_v5.suites.schema`, which always describes the latest format.
"""

from __future__ import annotations

import json
from collections.abc import Callable, Sequence
from typing import Any

import sqlalchemy as sa
from alembic import op

revision: str = "0009"
down_revision: str | None = "0008"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_DISPLAY_NAME = "display_name"

_schema = sa.table("schema", sa.column("id", sa.Integer), sa.column("schema_json", sa.Text))


def _add_display_name(document: Any) -> bool:
    """Give a schema that lacks the display name one, unset, whatever else it holds or lacks.

    Earlier builds refused the key, so a stored schema that has one is already in this format. Only
    a document that is not an object at all is left alone, as in 0003: a global revision that raises
    stops the server from starting at all (D6).
    """
    if not isinstance(document, dict) or _DISPLAY_NAME in document:
        return False
    document[_DISPLAY_NAME] = None
    return True


def _strip_display_name(document: Any) -> bool:
    if not isinstance(document, dict) or _DISPLAY_NAME not in document:
        return False
    del document[_DISPLAY_NAME]
    return True


def _rewrite_schemas(change: Callable[[Any], bool]) -> bool:
    """Apply `change` to every stored schema, and return whether it changed any."""
    connection = op.get_bind()
    # Locked like any other change to a stored schema, so that nothing changes a row between
    # reading and rewriting it.
    rows = connection.execute(sa.select(_schema.c.id, _schema.c.schema_json).with_for_update())
    rewritten = False
    for id_, schema_json in rows.all():
        try:
            document = json.loads(schema_json)
        except ValueError:
            continue
        if change(document):
            # With the separators the server itself writes.
            text = json.dumps(document, ensure_ascii=False, separators=(",", ":"))
            connection.execute(
                sa.update(_schema).where(_schema.c.id == id_).values(schema_json=text)
            )
            rewritten = True
    return rewritten


def upgrade() -> None:
    # Postgres numbers the existing rows as it adds the identity column.
    op.add_column(
        "schema", sa.Column("id", sa.Integer(), sa.Identity(always=False), nullable=False)
    )
    op.drop_constraint(op.f("pk_schema"), "schema", type_="primary")
    op.create_primary_key(op.f("pk_schema"), "schema", ["id"])

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
    op.create_unique_constraint(op.f("uq_schema_project_id_name"), "schema", ["project_id", "name"])

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
        sa.Column("suite_id", sa.Integer(), nullable=True),
        sa.Column("project_id", sa.Integer(), nullable=True),
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
        sa.ForeignKeyConstraint(
            ["project_id"],
            ["project.id"],
            name=op.f("fk_api_key_restriction_project_id_project"),
            ondelete="CASCADE",
        ),
        sa.CheckConstraint(
            "(project_id IS NULL) <> (suite_id IS NULL)",
            name=op.f("ck_api_key_restriction_one_target"),
        ),
        sa.UniqueConstraint(
            "api_key_id", "suite_id", name=op.f("uq_api_key_restriction_api_key_id_suite_id")
        ),
        sa.UniqueConstraint(
            "api_key_id", "project_id", name=op.f("uq_api_key_restriction_api_key_id_project_id")
        ),
    )
    # Every existing entry is a single suite. DISTINCT because nothing but the code creating keys
    # kept a key from naming a suite twice.
    op.execute(
        "INSERT INTO api_key_restriction (api_key_id, suite_id) "
        "SELECT DISTINCT api_key.id, schema.id "
        "FROM api_key, unnest(api_key.suites) AS suite JOIN schema ON schema.name = suite"
    )
    op.drop_constraint(op.f("ck_api_key_suites"), "api_key", type_="check")
    op.drop_column("api_key", "suites")

    _rewrite_schemas(_add_display_name)

    # Creating projects and rewriting stored schemas are changes workers cache, so they bump the
    # counter, once (D2, D5). Both happen exactly when there is a suite.
    op.execute(
        "UPDATE schema_version SET version = version + 1 "
        "WHERE id = 1 AND EXISTS (SELECT FROM schema)"
    )


def downgrade() -> None:
    # Earlier builds address a suite by its name alone, which must then be unique across the
    # instance again. Checked before changing anything.
    connection = op.get_bind()
    shared = connection.execute(
        sa.text("SELECT name FROM schema GROUP BY name HAVING count(*) > 1 ORDER BY name")
    ).scalars()
    if names := list(shared):
        raise RuntimeError(
            "cannot downgrade: earlier builds need every test suite to have a name of its own, "
            "and several projects have a suite named " + ", ".join(names)
        )

    # Earlier builds list single suites only. A whole project becomes the suites it holds now, which
    # narrows the key (it no longer covers the suites created in the project later) rather than
    # widening it. A key may already list one of them too (I5).
    op.execute(
        "INSERT INTO api_key_restriction (api_key_id, suite_id) "
        "SELECT api_key_restriction.api_key_id, schema.id "
        "FROM api_key_restriction JOIN schema "
        "ON schema.project_id = api_key_restriction.project_id "
        "ON CONFLICT ON CONSTRAINT uq_api_key_restriction_api_key_id_suite_id DO NOTHING"
    )
    op.execute("DELETE FROM api_key_restriction WHERE project_id IS NOT NULL")

    # Earlier builds reject the key, so it goes, whatever its value.
    if _rewrite_schemas(_strip_display_name):
        op.execute("UPDATE schema_version SET version = version + 1 WHERE id = 1")

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
    # Before the primary keys it refers to.
    op.drop_table("api_key_restriction")
    op.drop_constraint(op.f("ck_api_key_restricted"), "api_key", type_="check")
    op.drop_column("api_key", "restricted")

    op.drop_constraint(op.f("uq_schema_project_id_name"), "schema", type_="unique")
    op.drop_constraint(op.f("fk_schema_project_id_project"), "schema", type_="foreignkey")
    op.drop_column("schema", "project_id")
    op.drop_table("project")

    # The names are unique again, as checked above.
    op.drop_constraint(op.f("pk_schema"), "schema", type_="primary")
    op.create_primary_key(op.f("pk_schema"), "schema", ["name"])
    op.drop_column("schema", "id")

"""Put the projects of the instance, and the suites of each project, in an order.

Revision ID: 0011
Revises: 0010
Create Date: 2026-11-04

D7 has the instance keep an order of its projects, and each project an order of its suites, which
D5 records as each row's `position`, lowest first. A new row draws its position from a sequence the
column owns, which puts it last.

The existing projects and suites are put in the order the web UI listed them in until now (AR22): by
label -- the display name if there is one, the name otherwise -- compared case-insensitively, then
by name. The browser compares labels in the order of the user's language, which this approximates.
A suite's display name is in its stored schema; a schema that cannot be read is labelled by the
suite's name, rather than stopping the server from starting (D6).

Like the earlier revisions, this one is frozen: nothing is imported from `lnt_v5.tables`, and
`schema_json` is read with the standard library rather than through `lnt_v5.suites.schema`.
"""

from __future__ import annotations

import json
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0011"
down_revision: str | None = "0010"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _suite_display_name(schema_json: str) -> str | None:
    try:
        document = json.loads(schema_json)
    except ValueError:
        return None
    if not isinstance(document, dict):
        return None
    display_name = document.get("display_name")
    return display_name if isinstance(display_name, str) else None


def _add_position(table: str, labelled: list[tuple[int, str, str | None]]) -> None:
    """Give `table` its `position` column and the sequence it draws from, numbering the existing
    rows, each `(id, name, display name)`, in label order."""
    sequence = f"{table}_position_seq"
    op.add_column(table, sa.Column("position", sa.Integer(), nullable=True))
    op.execute(f"CREATE SEQUENCE {sequence} OWNED BY {table}.position")
    connection = op.get_bind()
    ordered = sorted(labelled, key=lambda row: ((row[2] or row[1]).casefold(), row[1]))
    if ordered:
        # Run row by row, in order, so that the positions follow it.
        connection.execute(
            sa.text(f"UPDATE {table} SET position = nextval('{sequence}') WHERE id = :id"),
            [{"id": id_} for id_, _, _ in ordered],
        )
    op.alter_column(
        table,
        "position",
        existing_type=sa.Integer(),
        nullable=False,
        server_default=sa.text(f"nextval('{sequence}')"),
    )


def upgrade() -> None:
    connection = op.get_bind()
    projects = connection.execute(sa.text("SELECT id, name, display_name FROM project")).all()
    _add_position("project", [(row.id, row.name, row.display_name) for row in projects])
    suites = connection.execute(sa.text("SELECT id, name, schema_json FROM schema")).all()
    # The suites of every project at once: only those of one project are compared with each other.
    _add_position(
        "schema", [(row.id, row.name, _suite_display_name(row.schema_json)) for row in suites]
    )

    # The order is something workers cache (D2, D5).
    op.execute(
        "UPDATE schema_version SET version = version + 1 "
        "WHERE id = 1 AND EXISTS (SELECT FROM project)"
    )


def downgrade() -> None:
    # Each takes the sequence it owns along. Earlier builds cache nothing about the order, so
    # nothing they cache changes.
    op.drop_column("schema", "position")
    op.drop_column("project", "position")

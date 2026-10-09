"""Rewrite stored schema labels that D4 no longer accepts to null.

Revision ID: 0003
Revises: 0002
Create Date: 2026-10-09

D4 now requires an entry's `display_name`, `unit` and `unit_abbrev` to be null or a non-empty
string, and D3 rejects a NUL character in any string. Earlier builds accepted both an empty string
and one containing a NUL, so stored schemas may hold either, and would no longer parse. An empty
label meant what null means. A label containing a NUL could never have been submitted legitimately,
so it is dropped rather than repaired.

Like 0001 and 0002, this revision is frozen: it reads and writes `schema_json` with the standard
library rather than through `lnt_v5.suites.schema`, which always describes the latest format.
"""

from __future__ import annotations

import json
from collections.abc import Sequence
from typing import Any

import sqlalchemy as sa
from alembic import op

revision: str = "0003"
down_revision: str | None = "0002"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_LISTS = ("metrics", "commit_fields", "machine_fields")
_LABELS = ("display_name", "unit", "unit_abbrev")

_schema = sa.table("schema", sa.column("name", sa.String), sa.column("schema_json", sa.Text))
_schema_version = sa.table(
    "schema_version", sa.column("id", sa.Integer), sa.column("version", sa.Integer)
)


def _clean(document: Any) -> bool:
    """Set the labels D4 rejects to null, in place. Returns whether anything changed.

    Anything that does not have the shape of a schema is left alone rather than refused: a global
    revision that raises stops the server from starting at all (D6), whereas the server already
    serves every other suite when one stored schema cannot be parsed.
    """
    if not isinstance(document, dict):
        return False
    changed = False
    for list_name in _LISTS:
        entries = document.get(list_name)
        if not isinstance(entries, list):
            continue
        for entry in entries:
            if not isinstance(entry, dict):
                continue
            for key in _LABELS:
                value = entry.get(key)
                if isinstance(value, str) and (value == "" or "\x00" in value):
                    entry[key] = None
                    changed = True
    return changed


def upgrade() -> None:
    connection = op.get_bind()
    # Locked like any other change to a stored schema, so that nothing changes a row between
    # reading and rewriting it.
    rows = connection.execute(sa.select(_schema.c.name, _schema.c.schema_json).with_for_update())
    rewritten = False
    for name, schema_json in rows.all():
        try:
            document = json.loads(schema_json)
        except ValueError:
            continue
        if _clean(document):
            # With the separators the server itself writes.
            text = json.dumps(document, ensure_ascii=False, separators=(",", ":"))
            connection.execute(
                sa.update(_schema).where(_schema.c.name == name).values(schema_json=text)
            )
            rewritten = True

    # A changed stored schema bumps the counter, like any other change to one (D2).
    if rewritten:
        connection.execute(
            sa.update(_schema_version)
            .where(_schema_version.c.id == 1)
            .values(version=_schema_version.c.version + 1)
        )


def downgrade() -> None:
    # Nothing to undo: null is a valid label for every earlier build too, and the values replaced
    # by it are not worth restoring.
    pass

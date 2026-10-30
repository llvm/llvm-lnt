"""Give every stored schema the suite's `display_name`, unset.

Revision ID: 0010
Revises: 0009
Create Date: 2026-10-29

D4 now lets a suite have a display name, a top-level key of its schema that defaults to null.
Earlier builds had no notion of one, so this changes nothing a suite does, but keeps stored schemas
normalized (D5). The key goes right after `name`, where the server writes it, so that a rewritten
schema is the text the server would write for it.

Like the earlier revisions, this one is frozen: it reads and writes `schema_json` with the standard
library rather than through `lnt_v5.suites.schema`, which always describes the latest format.
"""

from __future__ import annotations

import json
from collections.abc import Callable, Sequence
from typing import Any

import sqlalchemy as sa
from alembic import op

revision: str = "0010"
down_revision: str | None = "0009"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_KEY = "display_name"

_schema = sa.table("schema", sa.column("id", sa.Integer), sa.column("schema_json", sa.Text))
_schema_version = sa.table(
    "schema_version", sa.column("id", sa.Integer), sa.column("version", sa.Integer)
)


def _add(document: Any) -> Any:
    """The schema with the key, unset, right after `name`, or None if it needs no change.

    Earlier builds refused the key, so a stored schema that has one is already in this format. Only
    a document that is not an object at all is left alone, as in 0003: a global revision that raises
    stops the server from starting at all (D6). One without a `name` gets the key first.
    """
    if not isinstance(document, dict) or _KEY in document:
        return None
    rewritten: dict[str, Any] = {}
    if "name" in document:
        rewritten["name"] = document["name"]
    rewritten[_KEY] = None
    return rewritten | document


def _strip(document: Any) -> Any:
    if not isinstance(document, dict) or _KEY not in document:
        return None
    return {key: value for key, value in document.items() if key != _KEY}


def _rewrite(change: Callable[[Any], Any]) -> None:
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
        changed = change(document)
        if changed is None:
            continue
        # With the separators the server itself writes.
        text = json.dumps(changed, ensure_ascii=False, separators=(",", ":"))
        connection.execute(sa.update(_schema).where(_schema.c.id == id_).values(schema_json=text))
        rewritten = True

    # A changed stored schema bumps the counter, like any other change to one (D2).
    if rewritten:
        connection.execute(
            sa.update(_schema_version)
            .where(_schema_version.c.id == 1)
            .values(version=_schema_version.c.version + 1)
        )


def upgrade() -> None:
    _rewrite(_add)


def downgrade() -> None:
    # Earlier builds reject the key, so it goes, whatever its value.
    _rewrite(_strip)

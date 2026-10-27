"""Give every stored schema the `repository` block, with none of its keys set.

Revision ID: 0007
Revises: 0006
Create Date: 2026-10-27

D4 now has a schema name the repository its commits come from, in a `repository` block whose keys
all default to null. Earlier builds had no notion of one, so this changes nothing a suite does, but
keeps stored schemas normalized (D5).

Like the earlier revisions, this one is frozen: it reads and writes `schema_json` with the standard
library rather than through `lnt_v5.suites.schema`, which always describes the latest format.
"""

from __future__ import annotations

import json
from collections.abc import Callable, Sequence
from typing import Any

import sqlalchemy as sa
from alembic import op

revision: str = "0007"
down_revision: str | None = "0006"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_KEY = "repository"
_BLOCK = {"label": None, "commit_url": None, "range_url": None}

_schema = sa.table("schema", sa.column("name", sa.String), sa.column("schema_json", sa.Text))
_schema_version = sa.table(
    "schema_version", sa.column("id", sa.Integer), sa.column("version", sa.Integer)
)


def _add(document: Any) -> bool:
    """Give a schema that lacks the block one, whatever else it holds or lacks.

    Earlier builds refused the key, so a stored schema that has one is already in this format.
    Only a document that is not an object at all is left alone, as in 0003: a global revision that
    raises stops the server from starting at all (D6).
    """
    if not isinstance(document, dict) or _KEY in document:
        return False
    document[_KEY] = dict(_BLOCK)
    return True


def _strip(document: Any) -> bool:
    if not isinstance(document, dict) or _KEY not in document:
        return False
    del document[_KEY]
    return True


def _rewrite(change: Callable[[Any], bool]) -> None:
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
        if change(document):
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


def upgrade() -> None:
    _rewrite(_add)


def downgrade() -> None:
    # Earlier builds reject the key, so it goes, whatever its value.
    _rewrite(_strip)

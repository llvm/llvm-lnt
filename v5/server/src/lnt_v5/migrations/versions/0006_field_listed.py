"""Give every stored commit and machine field the `listed` key, set to keep the lists as they were.

Revision ID: 0006
Revises: 0005
Create Date: 2026-10-25

D4 now has commit and machine fields opt in to a column of the Commits and Machines tabs with
`listed: true`, which defaults to false. Earlier builds showed every machine field on the Machines
tab, and no commit field on the Commits tab, so this revision sets it to true on every machine field
and to false on every commit field. The latter changes nothing the UI shows, but keeps stored
schemas normalized (D5).

Like the earlier revisions, this one is frozen: it reads and writes `schema_json` with the standard
library rather than through `lnt_v5.suites.schema`, which always describes the latest format.
"""

from __future__ import annotations

import json
from collections.abc import Callable, Sequence
from typing import Any

import sqlalchemy as sa
from alembic import op

revision: str = "0006"
down_revision: str | None = "0005"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_KEY = "listed"
# Each list, and the value that keeps its entries shown or not, as they were.
_LISTS = {"machine_fields": True, "commit_fields": False}

_schema = sa.table("schema", sa.column("name", sa.String), sa.column("schema_json", sa.Text))
_schema_version = sa.table(
    "schema_version", sa.column("id", sa.Integer), sa.column("version", sa.Integer)
)


def _fields(document: Any, list_name: str) -> list[dict[str, Any]]:
    """The entries of one of a stored schema's field lists.

    Anything else is left alone rather than refused, as in 0003: a global revision that raises stops
    the server from starting at all (D6), whereas the server already serves every other suite when
    one stored schema cannot be parsed.
    """
    if not isinstance(document, dict):
        return []
    fields = document.get(list_name)
    if not isinstance(fields, list):
        return []
    return [field for field in fields if isinstance(field, dict)]


def _add(document: Any) -> bool:
    """Give each field that lacks the key the value that keeps it listed or not."""
    changed = False
    for list_name, listed in _LISTS.items():
        for field in _fields(document, list_name):
            if _KEY not in field:
                field[_KEY] = listed
                changed = True
    return changed


def _strip(document: Any) -> bool:
    changed = False
    for list_name in _LISTS:
        for field in _fields(document, list_name):
            if _KEY in field:
                del field[_KEY]
                changed = True
    return changed


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

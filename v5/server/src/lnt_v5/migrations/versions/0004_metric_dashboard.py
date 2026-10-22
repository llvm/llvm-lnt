"""Give every stored metric the `dashboard` key, set to keep the Dashboard showing what it showed.

Revision ID: 0004
Revises: 0003
Create Date: 2026-10-22

D4 now has metrics opt in to a card on the Dashboard with `dashboard: true`, which defaults to
false. Earlier builds showed a card for every numeric metric, so a stored schema read without the
key would lose all of its cards. This revision sets it to true on every `real` and `integer` metric,
and to false on the others, which the Dashboard never showed, so that stored schemas stay
normalized (D5).

Like the earlier revisions, this one is frozen: it reads and writes `schema_json` with the standard
library rather than through `lnt_v5.suites.schema`, which always describes the latest format.
"""

from __future__ import annotations

import json
from collections.abc import Callable, Sequence
from typing import Any

import sqlalchemy as sa
from alembic import op

revision: str = "0004"
down_revision: str | None = "0003"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_KEY = "dashboard"
_NUMERIC = ("real", "integer")
_TYPES = (*_NUMERIC, "text", "datetime")

_schema = sa.table("schema", sa.column("name", sa.String), sa.column("schema_json", sa.Text))
_schema_version = sa.table(
    "schema_version", sa.column("id", sa.Integer), sa.column("version", sa.Integer)
)


def _metrics(document: Any) -> list[dict[str, Any]]:
    """The metrics of a stored schema that have a known type.

    Anything else is left alone rather than refused, as in 0003: a global revision that raises stops
    the server from starting at all (D6), whereas the server already serves every other suite when
    one stored schema cannot be parsed.
    """
    if not isinstance(document, dict):
        return []
    metrics = document.get("metrics")
    if not isinstance(metrics, list):
        return []
    return [
        metric for metric in metrics if isinstance(metric, dict) and metric.get("type") in _TYPES
    ]


def _add(document: Any) -> bool:
    """Give each metric that lacks the key the value that keeps it on the Dashboard or off it."""
    changed = False
    for metric in _metrics(document):
        if _KEY not in metric:
            metric[_KEY] = metric["type"] in _NUMERIC
            changed = True
    return changed


def _strip(document: Any) -> bool:
    changed = False
    for metric in _metrics(document):
        if _KEY in metric:
            del metric[_KEY]
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

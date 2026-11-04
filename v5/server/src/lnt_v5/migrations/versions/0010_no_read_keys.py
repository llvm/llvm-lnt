"""Delete the API keys with the `read` scope, which no key can have any more.

Revision ID: 0010
Revises: 0009
Create Date: 2026-11-03

Every request gets `read`, with or without a key, so a key holding it grants nothing (I5). Existing
`read` keys are deleted, revoked ones included, and `api_key.scope` no longer accepts `read` (D5).
A deleted key's token is then unknown, and so a 401 even on the operations that need no key: a
client still sending one has to stop sending it. Their prefixes are free again, but only for a new
token that happens to start the same way, which is as unlikely as any other prefix collision.

The constraint on which keys can be restricted names the scopes that can be, rather than those that
cannot, which no longer include `read`.

Downgrading puts the constraints back as they were, but not the deleted keys: their tokens cannot be
recovered, and earlier builds do not need them.

Like the earlier revisions, this one is frozen: nothing is imported from `lnt_v5.tables`.
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "0010"
down_revision: str | None = "0009"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _replace_constraints(scope: str, restricted: str) -> None:
    op.drop_constraint(op.f("ck_api_key_scope"), "api_key", type_="check")
    op.create_check_constraint(op.f("ck_api_key_scope"), "api_key", scope)
    op.drop_constraint(op.f("ck_api_key_restricted"), "api_key", type_="check")
    op.create_check_constraint(op.f("ck_api_key_restricted"), "api_key", restricted)


def upgrade() -> None:
    # A `read` key is never restricted, so no `api_key_restriction` row refers to one.
    op.execute("DELETE FROM api_key WHERE scope = 'read'")
    _replace_constraints(
        "scope IN ('submit', 'triage', 'manage', 'admin')",
        "NOT restricted OR scope IN ('submit', 'triage', 'manage')",
    )


def downgrade() -> None:
    _replace_constraints(
        "scope IN ('read', 'submit', 'triage', 'manage', 'admin')",
        "NOT restricted OR scope NOT IN ('read', 'admin')",
    )

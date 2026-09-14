"""API keys: the tokens that authenticate a caller, and how one is created (R5, D5).

This is the `api_key` table's access layer, shared by the CLI (which mints the first key
out of band), the admin endpoints, and the authentication path. R5's HTTP semantics -- which
failure is a 400 and which a 401 -- live in `auth.py` instead.
"""

from __future__ import annotations

import hashlib
import logging
import re
import secrets
from dataclasses import dataclass
from datetime import datetime

from sqlalchemy import Connection, Engine, func, insert, select, update
from sqlalchemy.exc import IntegrityError, SQLAlchemyError

from .db import unique_violation_constraint
from .scopes import Scope
from .tables import KEY_NAME_MAX_LENGTH, TOKEN_PREFIX_LENGTH, api_key

logger = logging.getLogger(__name__)

# R5: 256 bits from a cryptographically secure source, rendered as lowercase hex.
TOKEN_BYTES = 32

# The shape R5 fixes for a token, and so the shape anything else cannot be. Checking it before
# hashing keeps a garbage credential from costing a database round trip.
TOKEN_PATTERN = re.compile(r"\A[0-9a-f]{64}\Z")

# A prefix is 8 hex characters, so two of them collide only by a birthday coincidence in a 2**32
# space. D5 says to discard such a token and generate another rather than fail the request; a
# handful of attempts is far more than that needs, and the bound stops a genuinely broken table
# from spinning forever.
_MAX_ATTEMPTS = 8

# What tables.py's NAMING_CONVENTION names the unique constraint on `api_key.prefix`. Written out
# because it is fixed -- no part of it depends on anything known only at runtime -- and checked
# against what Postgres reports by `test_tables.py`, so a change to the convention fails there
# rather than silently turning the retry below into a re-raise.
PREFIX_CONSTRAINT = "uq_api_key_prefix"


@dataclass(frozen=True)
class ApiKeyInfo:
    """Everything about a key that may be shown (D5). The token and its hash are not here."""

    prefix: str
    name: str
    scope: Scope
    created_at: datetime
    last_used_at: datetime | None
    is_active: bool


@dataclass(frozen=True)
class CreatedKey(ApiKeyInfo):
    """A newly created key, carrying the only copy of its token there will ever be (R5)."""

    token: str


@dataclass(frozen=True)
class ResolvedKey:
    """What a presented token resolved to. Internal: carries the row id, which no response does.

    `is_active` is read rather than filtered on, so the caller can log whether a rejected key was
    unknown or revoked. Both are a 401 either way (R5).
    """

    id: int
    prefix: str
    scope: Scope
    is_active: bool


def generate_token() -> str:
    return secrets.token_hex(TOKEN_BYTES)


def hash_token(token: str) -> str:
    """R5's single SHA-256 over the token's ASCII bytes.

    Deliberately not a password KDF: these tokens carry 256 bits of entropy from the server, so
    there is nothing to slow an attacker down against, and slow hashing would instead hand any
    unauthenticated caller a way to burn server CPU by presenting garbage.
    """
    return hashlib.sha256(token.encode("ascii")).hexdigest()


def create_key(connection: Connection, name: str, scope: Scope) -> CreatedKey:
    """Mint a key and store it, returning the raw token to show the operator once.

    The caller owns the transaction. Runs inside a savepoint so that a prefix collision can be
    retried without discarding work the caller did earlier in the same transaction.
    """
    if not name:
        raise ValueError("An API key's name must not be empty.")
    if len(name) > KEY_NAME_MAX_LENGTH:
        raise ValueError(f"An API key's name must be at most {KEY_NAME_MAX_LENGTH} characters.")

    for _ in range(_MAX_ATTEMPTS):
        token = generate_token()
        prefix = token[:TOKEN_PREFIX_LENGTH]
        try:
            with connection.begin_nested():
                # Read the defaults back rather than assuming them: `created_at` is the database's
                # clock, and `last_used_at` and `is_active` are column defaults (D5).
                row = connection.execute(
                    insert(api_key)
                    .values(
                        prefix=prefix,
                        key_hash=hash_token(token),
                        name=name,
                        scope=scope.value,
                    )
                    .returning(api_key.c.created_at, api_key.c.last_used_at, api_key.c.is_active)
                ).one()
        except IntegrityError as error:
            if unique_violation_constraint(error) != PREFIX_CONSTRAINT:
                raise
            continue
        return CreatedKey(
            prefix=prefix,
            name=name,
            scope=scope,
            created_at=row.created_at,
            last_used_at=row.last_used_at,
            is_active=row.is_active,
            token=token,
        )

    raise RuntimeError(
        f"Could not generate a token with an unused prefix in {_MAX_ATTEMPTS} attempts."
    )


def resolve_token(connection: Connection, token: str) -> ResolvedKey | None:
    """The key a presented token belongs to, or None if it belongs to none.

    R5 resolves every authenticated request against the database rather than caching the decision,
    so that revoking a key takes effect immediately. That is affordable because this is a single
    indexed match on a table holding one row per key.

    A token that is not the shape R5 fixes cannot be one we issued, so it is rejected without a
    round trip -- which also means an unauthenticated caller cannot make the server query on its
    behalf just by presenting garbage.
    """
    if not TOKEN_PATTERN.match(token):
        return None

    row = connection.execute(
        select(api_key.c.id, api_key.c.prefix, api_key.c.scope, api_key.c.is_active).where(
            api_key.c.key_hash == hash_token(token)
        )
    ).one_or_none()
    if row is None:
        return None
    return ResolvedKey(
        id=row.id, prefix=row.prefix, scope=Scope(row.scope), is_active=row.is_active
    )


def touch_last_used(engine: Engine, key_id: int) -> None:
    """Record that a key was just used (D5), on a transaction of its own.

    Takes an Engine rather than a Connection on purpose. D5 forbids this write from joining the
    request's transaction: a key may be shared by many submitting bots, and an in-transaction
    update would serialize every one of their requests behind a row lock held for the length of
    each request. On its own short transaction the lock lasts microseconds.

    D5 also says no request's outcome may depend on this write, so a failure is logged and
    dropped. That is the reason it is not folded into `resolve_token` as a single
    `UPDATE ... RETURNING`, tempting though one round trip is: a failed write would then fail
    authentication.
    """
    try:
        with engine.begin() as connection:
            connection.execute(
                update(api_key).where(api_key.c.id == key_id).values(last_used_at=func.now())
            )
    except SQLAlchemyError:
        logger.warning("Could not record last use of API key %d", key_id, exc_info=True)


def list_keys(connection: Connection) -> list[ApiKeyInfo]:
    """Every key, revoked ones included, newest first.

    Ordered by `created_at` rather than by `last_used_at`, which is mutable, nullable and only
    approximate; `prefix` breaks ties, and since `created_at` never changes the order is stable
    across requests.
    """
    rows = connection.execute(
        select(
            api_key.c.prefix,
            api_key.c.name,
            api_key.c.scope,
            api_key.c.created_at,
            api_key.c.last_used_at,
            api_key.c.is_active,
        ).order_by(api_key.c.created_at.desc(), api_key.c.prefix)
    ).all()
    return [
        ApiKeyInfo(
            prefix=row.prefix,
            name=row.name,
            scope=Scope(row.scope),
            created_at=row.created_at,
            last_used_at=row.last_used_at,
            is_active=row.is_active,
        )
        for row in rows
    ]


def revoke_key(connection: Connection, prefix: str) -> bool:
    """Revoke a key, reporting whether one had that prefix.

    The row is kept and flagged rather than deleted, so the revocation stays visible and the
    prefix is never reused by a later key. An already-revoked key still matches, which is what
    makes a retried revocation a success rather than a 404.
    """
    result = connection.execute(
        update(api_key).where(api_key.c.prefix == prefix).values(is_active=False)
    )
    return result.rowcount > 0

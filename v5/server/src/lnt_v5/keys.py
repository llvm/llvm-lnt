"""API keys: the tokens that authenticate a caller, and how one is created (R5, D5)."""

from __future__ import annotations

import hashlib
import secrets
from dataclasses import dataclass
from datetime import datetime

from sqlalchemy import Connection, insert
from sqlalchemy.exc import IntegrityError

from .db import unique_violation_constraint
from .scopes import Scope
from .tables import KEY_NAME_MAX_LENGTH, TOKEN_PREFIX_LENGTH, api_key

# R5: 256 bits from a cryptographically secure source, rendered as lowercase hex.
TOKEN_BYTES = 32

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
class CreatedKey:
    """A newly created key, carrying the only copy of its token there will ever be (R5)."""

    token: str
    prefix: str
    name: str
    scope: Scope
    created_at: datetime


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
                created_at: datetime = connection.execute(
                    insert(api_key)
                    .values(
                        prefix=prefix,
                        key_hash=hash_token(token),
                        name=name,
                        scope=scope.value,
                    )
                    .returning(api_key.c.created_at)
                ).scalar_one()
        except IntegrityError as error:
            if unique_violation_constraint(error) != PREFIX_CONSTRAINT:
                raise
            continue
        return CreatedKey(token=token, prefix=prefix, name=name, scope=scope, created_at=created_at)

    raise RuntimeError(
        f"Could not generate a token with an unused prefix in {_MAX_ATTEMPTS} attempts."
    )

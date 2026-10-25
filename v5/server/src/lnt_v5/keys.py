"""API keys: the tokens that authenticate a caller, and how one is created (I5, D5).

This is the `api_key` table's access layer, shared by the CLI (which mints the first key
out of band), the admin endpoints, and the authentication path. I5's HTTP semantics -- which
failure is a 400 and which a 401 -- live in `auth.py` instead.
"""

from __future__ import annotations

import hashlib
import logging
import re
import secrets
from collections.abc import Sequence
from dataclasses import dataclass, fields
from datetime import datetime
from time import monotonic
from typing import Any

from sqlalchemy import Connection, Engine, Row, func, insert, select, update
from sqlalchemy.exc import IntegrityError, SQLAlchemyError

from .db import unique_violation_constraint
from .scopes import UNRESTRICTABLE_SCOPES, Scope
from .tables import KEY_NAME_MAX_LENGTH, TOKEN_PREFIX_LENGTH, api_key, schema

logger = logging.getLogger(__name__)

# I5: 256 bits from a cryptographically secure source, rendered as lowercase hex.
TOKEN_BYTES = 32

# The shape I5 fixes for a token, and so the shape anything else cannot be. Checking it before
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

# How long, in seconds, a worker waits before recording a key's use again (see `LastUseRecorder`).
LAST_USED_INTERVAL = 60.0


@dataclass(frozen=True)
class ApiKeyInfo:
    """Everything about a key that may be shown (D5). The token and its hash are not here."""

    prefix: str
    name: str
    scope: Scope
    # None for a key valid across the instance, or the suites it is restricted to, sorted (I5).
    suites: tuple[str, ...] | None
    created_at: datetime
    last_used_at: datetime | None
    is_active: bool

    def grants(self, required: Scope, suite: str | None) -> bool:
        """Whether this key satisfies an endpoint requiring `required`, on a request addressing
        `suite` (None for one that addresses no suite).

        I5: a restricted key has its scope only on a request addressing one of its suites, and
        only `read` -- what anonymous access gets -- on any other.
        """
        if self.suites is None or suite in self.suites:
            return self.scope.grants(required)
        return Scope.READ.grants(required)


@dataclass(frozen=True)
class CreatedKey(ApiKeyInfo):
    """A newly created key, carrying the only copy of its token there will ever be (I5)."""

    token: str


@dataclass(frozen=True)
class ResolvedKey(ApiKeyInfo):
    """What a presented token resolved to. Internal: carries the row id, which no response does.

    `is_active` is read rather than filtered on, so the caller can log whether a rejected key was
    unknown or revoked. Both are a 401 either way (I5).
    """

    id: int


# The columns an `ApiKeyInfo` is read from, named as its fields are, and how to read one back out of
# a row selecting them.
_SHOWN_COLUMNS = tuple(api_key.c[field.name] for field in fields(ApiKeyInfo))


def _shown(row: Row[Any]) -> dict[str, Any]:
    values = {field.name: row._mapping[field.name] for field in fields(ApiKeyInfo)}
    suites = values["suites"]
    return values | {
        "scope": Scope(values["scope"]),
        "suites": None if suites is None else tuple(suites),
    }


class UnknownSuitesError(ValueError):
    """A key was to be restricted to suites that do not exist (a 404, per E11)."""

    def __init__(self, names: Sequence[str]) -> None:
        self.names = tuple(names)
        listed = ", ".join(f"'{name}'" for name in self.names)
        super().__init__(f"No test suite is named {listed}.")


def generate_token() -> str:
    return secrets.token_hex(TOKEN_BYTES)


def hash_token(token: str) -> str:
    """I5's single SHA-256 over the token's ASCII bytes.

    Deliberately not a password KDF: these tokens carry 256 bits of entropy from the server, so
    there is nothing to slow an attacker down against, and slow hashing would instead hand any
    unauthenticated caller a way to burn server CPU by presenting garbage.
    """
    return hashlib.sha256(token.encode("ascii")).hexdigest()


def create_key(
    connection: Connection, name: str, scope: Scope, suites: Sequence[str] | None = None
) -> CreatedKey:
    """Mint a key and store it, returning the raw token to show the operator once.

    `suites` restricts the key to those suites, or None makes it valid across the instance (I5).
    E11's rules for a key are checked here, so that the API and the CLI share them: a `ValueError`
    for a key that can never be valid, or its subclass `UnknownSuitesError` for suites that do not
    exist (yet).

    The caller owns the transaction. Runs inside a savepoint so that a prefix collision can be
    retried without discarding work the caller did earlier in the same transaction.
    """
    if not name:
        raise ValueError("An API key's name must not be empty.")
    if len(name) > KEY_NAME_MAX_LENGTH:
        raise ValueError(f"An API key's name must be at most {KEY_NAME_MAX_LENGTH} characters.")
    if suites is not None:
        suites = _checked_suites(connection, scope, suites)

    for _ in range(_MAX_ATTEMPTS):
        token = generate_token()
        prefix = token[:TOKEN_PREFIX_LENGTH]
        try:
            with connection.begin_nested():
                # Read the row back rather than assuming its defaults: `created_at` is the
                # database's clock, and `last_used_at` and `is_active` are column defaults (D5).
                row = connection.execute(
                    insert(api_key)
                    .values(
                        prefix=prefix,
                        key_hash=hash_token(token),
                        name=name,
                        scope=scope.value,
                        suites=suites,
                    )
                    .returning(*_SHOWN_COLUMNS)
                ).one()
        except IntegrityError as error:
            if unique_violation_constraint(error) != PREFIX_CONSTRAINT:
                raise
            continue
        return CreatedKey(token=token, **_shown(row))

    raise RuntimeError(
        f"Could not generate a token with an unused prefix in {_MAX_ATTEMPTS} attempts."
    )


def _checked_suites(connection: Connection, scope: Scope, suites: Sequence[str]) -> list[str]:
    """The suites a key is to be restricted to, sorted, once E11's rules are checked.

    Existence is checked only here, at creation: a key is not linked to its suites, so one deleted
    later stays on the key (I5).
    """
    if scope in UNRESTRICTABLE_SCOPES:
        raise ValueError(
            f"A key with the '{scope.value}' scope cannot be restricted to test suites."
        )
    if not suites:
        raise ValueError("A key restricted to test suites must name at least one.")
    if len(set(suites)) != len(suites):
        raise ValueError("A key's test suites must not name a suite more than once.")
    existing = set(
        connection.execute(select(schema.c.name).where(schema.c.name.in_(suites))).scalars()
    )
    if missing := [name for name in suites if name not in existing]:
        raise UnknownSuitesError(missing)
    return sorted(suites)


def resolve_token(connection: Connection, token: str) -> ResolvedKey | None:
    """The key a presented token belongs to, or None if it belongs to none.

    I5 resolves every authenticated request against the database rather than caching the decision,
    so that revoking a key takes effect immediately. That is affordable because this is a single
    indexed match on a table holding one row per key.

    A token that is not the shape I5 fixes cannot be one we issued, so it is rejected without a
    round trip -- which also means an unauthenticated caller cannot make the server query on its
    behalf just by presenting garbage.
    """
    if not TOKEN_PATTERN.match(token):
        return None

    # Every shown column, not only what authorization needs: a resolved key is a whole `ApiKeyInfo`,
    # and the row is being read anyway.
    row = connection.execute(
        select(api_key.c.id, *_SHOWN_COLUMNS).where(api_key.c.key_hash == hash_token(token))
    ).one_or_none()
    if row is None:
        return None
    return ResolvedKey(id=row.id, **_shown(row))


class LastUseRecorder:
    """When this worker last recorded each key's use, so it can skip recording it again (D5).

    One per app rather than one per module, like the suite registry: a key id is only unique within
    one database, and the tests reuse ids across the databases they empty between tests.
    """

    def __init__(self) -> None:
        # Key id -> `monotonic()` at the last write that succeeded.
        self._recorded: dict[int, float] = {}

    def record(self, engine: Engine, key_id: int) -> None:
        """Record that a key was just used, unless this worker did so less than an interval ago.

        Takes an Engine rather than a Connection on purpose. D5 forbids this write from joining the
        request's transaction: a key may be shared by many submitting bots, and an in-transaction
        update would serialize every one of their requests behind a row lock held for the length
        of each request.

        A transaction of its own is not enough, though: every request sharing the key would still
        queue on that one row and pay for a commit before doing any work. D5 lets these writes be
        coalesced, so a worker records each key at most once per `LAST_USED_INTERVAL`. Threads
        racing past the check cost a redundant, harmless write, so there is no lock.

        D5 also says no request's outcome may depend on this write, so a failure is logged and
        dropped. It is not remembered, so the next request retries it. That is also the reason it
        is not folded into `resolve_token` as a single `UPDATE ... RETURNING`, tempting though one
        round trip is: a failed write would then fail authentication.
        """
        now = monotonic()
        # Membership rather than a default of 0: `monotonic()` has an arbitrary origin, so in a
        # freshly booted container 0 could itself be less than an interval ago.
        last = self._recorded.get(key_id)
        if last is not None and now - last < LAST_USED_INTERVAL:
            return
        try:
            with engine.begin() as connection:
                connection.execute(
                    update(api_key).where(api_key.c.id == key_id).values(last_used_at=func.now())
                )
        except SQLAlchemyError:
            logger.warning("Could not record last use of API key %d", key_id, exc_info=True)
            return
        self._recorded[key_id] = now


def list_keys(connection: Connection) -> list[ApiKeyInfo]:
    """Every key, revoked ones included, newest first.

    Ordered by `created_at` rather than by `last_used_at`, which is mutable, nullable and only
    approximate; `prefix` breaks ties, and since `created_at` never changes the order is stable
    across requests.
    """
    rows = connection.execute(
        select(*_SHOWN_COLUMNS).order_by(api_key.c.created_at.desc(), api_key.c.prefix)
    ).all()
    return [ApiKeyInfo(**_shown(row)) for row in rows]


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

"""API keys: the tokens that authenticate a caller, and how one is created (I5, D5).

This is the access layer of the `api_key` table, and of the `api_key_restriction` rows that list
what a restricted key is restricted to, shared by the CLI (which mints the first key
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
from typing import Any, NamedTuple

from sqlalchemy import Connection, Engine, Row, func, insert, select, tuple_, update
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from sqlalchemy.sql.elements import ColumnElement

from .db import unique_violation_constraint
from .scopes import UNRESTRICTABLE_SCOPES, Scope
from .suites.store import full_name
from .tables import (
    KEY_NAME_MAX_LENGTH,
    TOKEN_PREFIX_LENGTH,
    api_key,
    api_key_restriction,
    project,
    schema,
)

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


class Entry(NamedTuple):
    """An entry of a restricted key's list (I5), under the current names of what it lists: a single
    suite, or a whole project when `suite` is None."""

    project: str
    suite: str | None

    def __str__(self) -> str:
        if self.suite is None:
            return f"{self.project} (all)"
        return full_name(self.project, self.suite)


@dataclass(frozen=True)
class ApiKeyInfo:
    """Everything about a key that may be shown (D5). The token and its hash are not here."""

    prefix: str
    name: str
    scope: Scope
    # None for a key valid across the instance, or the entries it is restricted to, ordered as E11
    # lists them (I5). Empty once everything they listed has been deleted.
    restricted_to: tuple[Entry, ...] | None
    created_at: datetime
    last_used_at: datetime | None
    is_active: bool

    def covers(self, project: str | None, suite: str | None) -> bool:
        """Whether this key covers what a request addresses (I5): the suite `suite` of the project
        `project`, the project `project` in full when `suite` is None, or, with neither, the
        instance, which only an instance-wide key covers.
        """
        if self.restricted_to is None:
            return True
        return project is not None and any(
            entry.project == project and entry.suite in (None, suite)
            for entry in self.restricted_to
        )

    def grants(self, required: Scope, project: str | None, suite: str | None) -> bool:
        """Whether this key satisfies an endpoint requiring `required`, on a request addressing
        what `covers` takes `project` and `suite` for.

        I5: a restricted key has its scope only on a request addressing what it covers, and only
        `read` -- what anonymous access gets -- on any other. A key whose entries were all deleted
        therefore grants only `read`, anywhere.
        """
        if self.covers(project, suite):
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


def _entries() -> ColumnElement[Any]:
    """The entries a key's restriction rows list, under the current names of what they list, as an
    array of texts: a project's name for a whole project, and a suite's full name (D7) for a single
    suite, ordered as E11 lists them.

    Correlated with the `api_key` row being read, so that a key is read together with its entries
    in one statement (I5 looks the key up on every request). The names come from `schema` and
    `project` rather than being stored with the key, so that an entry follows what it lists (I5): a
    single suite's project is the one the suite is in now. Sorted by code point, rather than by the
    database's collation, which may ignore `-` and `_`, with a whole project before the suites of
    that project. Neither name can contain the `/` between them (D4, D7), so each splits back
    exactly.
    """
    return func.array(
        select(project.c.name + func.coalesce("/" + schema.c.name, ""))
        .select_from(
            api_key_restriction.outerjoin(schema).join(
                project,
                project.c.id
                == func.coalesce(api_key_restriction.c.project_id, schema.c.project_id),
            )
        )
        .where(api_key_restriction.c.api_key_id == api_key.c.id)
        .order_by(project.c.name.collate("C"), schema.c.name.collate("C").nulls_first())
        .scalar_subquery()
    ).label("restricted_to")


def _entry(text: str) -> Entry:
    """The entry `text` stands for (see `_entries`)."""
    project_name, _, suite = text.partition("/")
    return Entry(project_name, suite or None)


# The columns an `ApiKeyInfo` is read from, named as its fields are, and how to read one back out of
# a row selecting them.
_SHOWN_COLUMNS = (
    *(api_key.c[field.name] for field in fields(ApiKeyInfo) if field.name != "restricted_to"),
    api_key.c.restricted,
    _entries(),
)


def _shown(row: Row[Any]) -> dict[str, Any]:
    values = {field.name: row._mapping[field.name] for field in fields(ApiKeyInfo)}
    return values | {
        "scope": Scope(values["scope"]),
        "restricted_to": (
            tuple(_entry(text) for text in values["restricted_to"]) if row.restricted else None
        ),
    }


class UnknownEntriesError(ValueError):
    """A key was to be restricted to projects or suites that do not exist (a 404, per E11)."""


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
    connection: Connection, name: str, scope: Scope, restricted_to: Sequence[Entry] | None = None
) -> CreatedKey:
    """Mint a key and store it, returning the raw token to show the operator once.

    `restricted_to` restricts the key to those entries, or None makes it valid across the instance
    (I5). E11's rules for a key are checked here, so that the API and the CLI share them: a
    `ValueError` for a key that can never be valid, or its subclass `UnknownEntriesError` for
    projects or suites that do not exist (yet).

    The caller owns the transaction, and the projects and suites the key lists stay locked against
    deletion until it ends (see `_checked_entries`). The key's row is inserted inside a savepoint,
    so that a prefix collision can be retried without discarding work the caller did earlier in the
    same transaction.
    """
    if not name:
        raise ValueError("An API key's name must not be empty.")
    if len(name) > KEY_NAME_MAX_LENGTH:
        raise ValueError(f"An API key's name must be at most {KEY_NAME_MAX_LENGTH} characters.")
    targets = None if restricted_to is None else _checked_entries(connection, scope, restricted_to)

    for _ in range(_MAX_ATTEMPTS):
        token = generate_token()
        prefix = token[:TOKEN_PREFIX_LENGTH]
        try:
            with connection.begin_nested():
                key_id = connection.execute(
                    insert(api_key)
                    .values(
                        prefix=prefix,
                        key_hash=hash_token(token),
                        name=name,
                        scope=scope.value,
                        restricted=targets is not None,
                    )
                    .returning(api_key.c.id)
                ).scalar_one()
        except IntegrityError as error:
            if unique_violation_constraint(error) != PREFIX_CONSTRAINT:
                raise
            continue
        if targets:
            connection.execute(
                insert(api_key_restriction),
                [{"api_key_id": key_id, **target} for target in targets],
            )
        # Read back rather than assembled from what was sent: `created_at` is the database's clock,
        # and `last_used_at` and `is_active` are column defaults (D5).
        shown = connection.execute(select(*_SHOWN_COLUMNS).where(api_key.c.id == key_id)).one()
        return CreatedKey(token=token, **_shown(shown))

    raise RuntimeError(
        f"Could not generate a token with an unused prefix in {_MAX_ATTEMPTS} attempts."
    )


def _checked_entries(
    connection: Connection, scope: Scope, entries: Sequence[Entry]
) -> list[dict[str, int | None]]:
    """The restriction rows of a key to be restricted to `entries`, each with the `project_id` of a
    whole project or the `suite_id` of a single suite, once E11's rules are checked.

    What the key lists is locked against deletion until the caller's transaction ends, so that a
    project or a suite deleted concurrently is either gone already, and refused here, or deleted
    once the key is stored, which removes it from the key (I5). Without the lock, a deletion
    committed between this read and the insert of the key's rows would fail that insert on its
    foreign key instead. The projects are locked before the suites, the order writers that lock
    both take, so that none can deadlock with it.
    """
    if scope in UNRESTRICTABLE_SCOPES:
        raise ValueError(f"A key with the '{scope.value}' scope cannot be restricted.")
    if not entries:
        raise ValueError("A restricted key must list at least one entry.")
    if len(set(entries)) != len(entries):
        raise ValueError("A restricted key must not list an entry more than once.")

    projects = {
        row.name: row.id
        for row in connection.execute(
            select(project.c.name, project.c.id)
            .where(project.c.name.in_({entry.project for entry in entries}))
            .with_for_update(read=True, key_share=True)
        )
    }
    single = [entry for entry in entries if entry.suite is not None and entry.project in projects]
    suites = {}
    if single:
        rows = connection.execute(
            select(schema.c.project_id, schema.c.name, schema.c.id)
            .where(
                tuple_(schema.c.project_id, schema.c.name).in_(
                    [(projects[entry.project], entry.suite) for entry in single]
                )
            )
            .with_for_update(of=schema, read=True, key_share=True)
        )
        suites = {(row.project_id, row.name): row.id for row in rows}

    targets: list[dict[str, int | None]] = []
    problems = []
    for entry in entries:
        project_id = projects.get(entry.project)
        if project_id is None:
            problems.append(f"No project is named '{entry.project}'.")
        elif entry.suite is None:
            targets.append({"project_id": project_id, "suite_id": None})
        elif (suite_id := suites.get((project_id, entry.suite))) is None:
            problems.append(f"Project '{entry.project}' has no test suite named '{entry.suite}'.")
        else:
            targets.append({"project_id": None, "suite_id": suite_id})
    if problems:
        raise UnknownEntriesError(" ".join(dict.fromkeys(problems)))
    return targets


def resolve_token(connection: Connection, token: str) -> ResolvedKey | None:
    """The key a presented token belongs to, or None if it belongs to none.

    I5 resolves every authenticated request against the database rather than caching the decision,
    so that revoking a key takes effect immediately. That is affordable because this is a single
    statement: an indexed match on a table holding one row per key, which also reads the current
    names of what the key lists from tables just as small.

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

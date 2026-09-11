"""API keys and the scope hierarchy (R5)."""

from __future__ import annotations

import hashlib
from collections.abc import Iterator

import pytest
from sqlalchemy import Connection, func, select

from conftest import TOKEN_PATTERN
from lnt_v5 import keys
from lnt_v5.keys import CreatedKey, create_key
from lnt_v5.scopes import Scope
from lnt_v5.tables import KEY_NAME_MAX_LENGTH, TOKEN_PREFIX_LENGTH, api_key


def stub_tokens(monkeypatch: pytest.MonkeyPatch, *tokens: str) -> None:
    """Make token generation deterministic, so a prefix collision can be arranged."""
    remaining: Iterator[str] = iter(tokens)
    monkeypatch.setattr(keys, "generate_token", lambda: next(remaining))


class TestToken:
    def test_is_64_lowercase_hex_characters(self) -> None:
        # R5 fixes both the length and the alphabet: 256 bits rendered as hex.
        assert TOKEN_PATTERN.match(keys.generate_token())

    def test_differs_every_time(self) -> None:
        assert len({keys.generate_token() for _ in range(100)}) == 100

    def test_is_hashed_with_a_bare_sha256_of_its_ascii_bytes(self) -> None:
        # R5 rules out a password KDF deliberately, so this is pinned rather than left to
        # whatever a future refactor finds convenient: auth has to compute the same hash.
        token = "ab" * 32

        assert keys.hash_token(token) == hashlib.sha256(b"ab" * 32).hexdigest()


class TestCreateKey:
    def test_returns_the_token_once_and_stores_only_its_hash(self, db: Connection) -> None:
        created = create_key(db, "bot", Scope.SUBMIT)

        stored = db.execute(select(api_key.c.prefix, api_key.c.key_hash, api_key.c.scope)).one()
        assert stored.key_hash == keys.hash_token(created.token)
        assert stored.prefix == created.token[:TOKEN_PREFIX_LENGTH]
        assert stored.scope == "submit"
        # Nothing anywhere in the row lets the token be reconstructed.
        assert created.token not in str(tuple(stored))

    def test_describes_the_key_it_created(self, db: Connection) -> None:
        created = create_key(db, "bot", Scope.SUBMIT)

        assert isinstance(created, CreatedKey)
        assert created.name == "bot"
        assert created.scope is Scope.SUBMIT
        assert created.created_at is not None

    @pytest.mark.parametrize("scope", list(Scope))
    def test_accepts_every_scope(self, db: Connection, scope: Scope) -> None:
        created = create_key(db, "a key", scope)

        assert created.scope is scope

    def test_generates_a_new_token_when_a_prefix_is_already_taken(
        self, db: Connection, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # D5: a colliding token is discarded and another generated, rather than the request
        # failing. The second token below shares a prefix with the first but not a hash, so only
        # the prefix constraint trips.
        taken = "abcdef01" + "0" * 56
        collides = "abcdef01" + "1" * 56
        free = "99999999" + "2" * 56
        stub_tokens(monkeypatch, taken, collides, free)
        create_key(db, "first", Scope.READ)

        created = create_key(db, "second", Scope.READ)

        assert created.token == free
        assert created.prefix == "99999999"
        # The retry runs inside a savepoint, so the attempt that collided neither persists nor
        # poisons the caller's transaction (D13's pattern).
        assert db.execute(select(func.count()).select_from(api_key)).scalar_one() == 2

    def test_gives_up_rather_than_spinning_when_every_prefix_collides(
        self, db: Connection, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # Every token shares one prefix but has its own hash, so each attempt trips the prefix
        # constraint and retries. Only reachable through a broken generator -- but an unbounded
        # loop would hang the request rather than fail it.
        suffixes = iter(range(1, 100))

        def colliding_token() -> str:
            return "abcdef01" + f"{next(suffixes):056x}"

        monkeypatch.setattr(keys, "generate_token", colliding_token)
        create_key(db, "first", Scope.READ)

        with pytest.raises(RuntimeError, match="unused prefix"):
            create_key(db, "second", Scope.READ)

    @pytest.mark.parametrize(
        ("name", "why"),
        [("", "empty"), ("x" * (KEY_NAME_MAX_LENGTH + 1), "longer than the column")],
    )
    def test_rejects_an_unusable_name(self, db: Connection, name: str, why: str) -> None:
        # The API answers 400 for these; rejecting here means the CLI does too, and neither has
        # to discover it as a database error.
        with pytest.raises(ValueError, match="name"):
            create_key(db, name, Scope.READ)

    def test_accepts_a_name_at_the_limit(self, db: Connection) -> None:
        created = create_key(db, "x" * KEY_NAME_MAX_LENGTH, Scope.READ)

        assert created.name == "x" * KEY_NAME_MAX_LENGTH

    def test_lets_two_keys_share_a_name(self, db: Connection) -> None:
        # D5 is explicit that a name is a label, not an identifier.
        create_key(db, "bot", Scope.READ)
        create_key(db, "bot", Scope.READ)

        assert db.execute(select(func.count()).select_from(api_key)).scalar_one() == 2


class TestScopeHierarchy:
    def test_admin_grants_everything(self) -> None:
        assert all(Scope.ADMIN.grants(required) for required in Scope)

    def test_read_grants_only_itself(self) -> None:
        assert Scope.READ.grants(Scope.READ)
        assert not any(Scope.READ.grants(other) for other in Scope if other is not Scope.READ)

    def test_every_scope_grants_itself(self) -> None:
        assert all(scope.grants(scope) for scope in Scope)

    def test_is_not_the_alphabetical_order_str_comparison_would_give(self) -> None:
        # Compared as plain strings, "admin" sorts below "read" -- the exact inversion of R5's
        # ladder. A `<` between two members would hand the highest-privilege scope the fewest
        # rights, so `grants` reads declaration order instead.
        assert Scope.ADMIN < Scope.READ
        assert Scope.ADMIN.grants(Scope.READ)
        assert not Scope.READ.grants(Scope.ADMIN)

    @pytest.mark.parametrize(
        ("holder", "required", "granted"),
        [
            (Scope.SUBMIT, Scope.READ, True),
            (Scope.SUBMIT, Scope.TRIAGE, False),
            (Scope.TRIAGE, Scope.SUBMIT, True),
            (Scope.TRIAGE, Scope.MANAGE, False),
            (Scope.MANAGE, Scope.TRIAGE, True),
            (Scope.MANAGE, Scope.ADMIN, False),
            (Scope.ADMIN, Scope.MANAGE, True),
        ],
    )
    def test_grants_along_r5s_ladder(self, holder: Scope, required: Scope, granted: bool) -> None:
        assert holder.grants(required) is granted

    def test_serializes_as_the_wire_spelling(self) -> None:
        # These strings are what the API accepts and what the `scope` column stores.
        assert [str(scope) for scope in Scope] == [
            "read",
            "submit",
            "triage",
            "manage",
            "admin",
        ]

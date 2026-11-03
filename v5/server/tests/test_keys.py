"""API keys and the scope hierarchy (I5)."""

from __future__ import annotations

import hashlib
import logging
from collections.abc import Callable, Iterator
from datetime import UTC, datetime
from typing import Any

import pytest
from sqlalchemy import Connection, Engine, create_engine, delete, func, insert, select, update

from conftest import TOKEN_PATTERN, UNREACHABLE_URL
from introspection import counting_statements
from lnt_v5 import keys
from lnt_v5.keys import ApiKeyInfo, CreatedKey, Entry, UnknownEntriesError, create_key
from lnt_v5.scopes import Scope
from lnt_v5.tables import (
    KEY_NAME_MAX_LENGTH,
    TOKEN_PREFIX_LENGTH,
    api_key,
    api_key_restriction,
    project,
    schema,
)


def stub_tokens(monkeypatch: pytest.MonkeyPatch, *tokens: str) -> None:
    """Make token generation deterministic, so a prefix collision can be arranged."""
    remaining: Iterator[str] = iter(tokens)
    monkeypatch.setattr(keys, "generate_token", lambda: next(remaining))


class TestToken:
    def test_is_64_lowercase_hex_characters(self) -> None:
        # I5 fixes both the length and the alphabet: 256 bits rendered as hex.
        assert TOKEN_PATTERN.match(keys.generate_token())

    def test_differs_every_time(self) -> None:
        assert len({keys.generate_token() for _ in range(100)}) == 100

    def test_is_hashed_with_a_bare_sha256_of_its_ascii_bytes(self) -> None:
        # I5 rules out a password KDF deliberately, so this is pinned rather than left to
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
        # poisons the caller's transaction (O8's pattern).
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


class TestCreateRestrictedKey:
    @pytest.fixture(autouse=True)
    def suites(self, db: Connection) -> None:
        # Rows alone: `create_key` only checks that the projects and suites exist. Two projects
        # have a suite named `nts`, which are two suites (D7).
        for project_name, names in {
            "llvm": ["nts", "a-b", "a_c", "ab"],
            "libcxx": ["benchmarks"],
            "other": ["nts"],
            "empty": [],
            "lib-a": [],
            "lib_b": [],
        }.items():
            project_id = db.execute(
                insert(project).values(name=project_name).returning(project.c.id)
            ).scalar_one()
            for name in names:
                db.execute(
                    insert(schema).values(
                        project_id=project_id,
                        name=name,
                        namespace=f"{project_name}_{name}",
                        schema_json="{}",
                        migration_version=0,
                    )
                )

    def test_stores_and_describes_its_entries_in_order(self, db: Connection) -> None:
        created = create_key(
            db, "bot", Scope.SUBMIT, [Entry("llvm", "nts"), Entry("libcxx", "benchmarks")]
        )

        expected = (Entry("libcxx", "benchmarks"), Entry("llvm", "nts"))
        assert created.restricted_to == expected
        assert db.execute(select(api_key.c.restricted)).scalar_one() is True
        # By identity rather than by name (I5).
        stored = db.execute(
            select(schema.c.namespace).join(api_key_restriction).order_by(schema.c.namespace)
        ).scalars()
        assert list(stored) == ["libcxx_benchmarks", "llvm_nts"]
        resolved = keys.resolve_token(db, created.token)
        assert resolved is not None
        assert resolved.restricted_to == expected

    def test_tells_suites_of_the_same_name_apart_by_their_project(self, db: Connection) -> None:
        created = create_key(db, "bot", Scope.SUBMIT, [Entry("other", "nts")])

        assert created.restricted_to == (Entry("other", "nts"),)
        assert created.covers("other", "nts")
        assert not created.covers("llvm", "nts")

    def test_sorts_its_entries_by_code_point(self, db: Connection) -> None:
        # Not by the database's collation, which may ignore `-` and `_`.
        created = create_key(
            db,
            "bot",
            Scope.SUBMIT,
            [Entry("llvm", "ab"), Entry("llvm", "a_c"), Entry("llvm", "a-b")],
        )

        expected = (Entry("llvm", "a-b"), Entry("llvm", "a_c"), Entry("llvm", "ab"))
        assert created.restricted_to == expected
        (listed,) = keys.list_keys(db)
        assert listed.restricted_to == expected

    def test_is_not_restricted_by_default(self, db: Connection) -> None:
        created = create_key(db, "bot", Scope.SUBMIT)

        assert created.restricted_to is None
        assert db.execute(select(api_key.c.restricted)).scalar_one() is False
        assert db.execute(select(func.count()).select_from(api_key_restriction)).scalar_one() == 0

    def test_is_resolved_with_its_entries_in_one_statement(self, db: Connection) -> None:
        # I5 looks the key up on every request: its entries must not cost a round trip of their own.
        created = create_key(
            db, "bot", Scope.SUBMIT, [Entry("llvm", "nts"), Entry("libcxx", "benchmarks")]
        )

        # Every statement, whatever it names, since what is counted is round trips.
        with counting_statements("") as statements:
            resolved = keys.resolve_token(db, created.token)

        assert resolved is not None
        assert len(resolved.restricted_to or ()) == 2
        assert len(statements) == 1

    def test_loses_a_suite_that_is_deleted(self, db: Connection) -> None:
        created = create_key(
            db, "bot", Scope.SUBMIT, [Entry("llvm", "nts"), Entry("libcxx", "benchmarks")]
        )

        db.execute(delete(schema).where(schema.c.namespace == "llvm_nts"))
        resolved = keys.resolve_token(db, created.token)
        assert resolved is not None
        assert resolved.restricted_to == (Entry("libcxx", "benchmarks"),)

        # Restricted to nothing, rather than valid across the instance (I5).
        db.execute(delete(schema).where(schema.c.namespace == "libcxx_benchmarks"))
        resolved = keys.resolve_token(db, created.token)
        assert resolved is not None
        assert resolved.restricted_to == ()
        (listed,) = keys.list_keys(db)
        assert listed.restricted_to == ()

    @pytest.mark.parametrize(
        ("scope", "entries", "why"),
        [
            (Scope.READ, [Entry("llvm", "nts")], "a read key"),
            (Scope.ADMIN, [Entry("llvm", "nts")], "an admin key"),
            (Scope.SUBMIT, [], "no entry at all"),
            (Scope.SUBMIT, [Entry("llvm", "nts"), Entry("llvm", "nts")], "an entry twice"),
            (Scope.SUBMIT, [Entry("llvm", None), Entry("llvm", None)], "a project twice"),
        ],
    )
    def test_rejects_a_restriction_that_cannot_be_valid(
        self, db: Connection, scope: Scope, entries: list[Entry], why: str
    ) -> None:
        # The API answers 400 for these; rejecting here means the CLI does too.
        with pytest.raises(ValueError) as raised:
            create_key(db, "bot", scope, entries)
        assert not isinstance(raised.value, UnknownEntriesError)

    def test_lists_a_suite_along_with_its_whole_project(self, db: Connection) -> None:
        # A suite along with its whole project (I5): both entries stay.
        created = create_key(db, "bot", Scope.SUBMIT, [Entry("llvm", "nts"), Entry("llvm", None)])

        assert created.restricted_to == (Entry("llvm", None), Entry("llvm", "nts"))

    def test_names_the_projects_and_suites_that_do_not_exist(self, db: Connection) -> None:
        entries = [
            Entry("llvm", "nts"),
            Entry("llvm", "ntss"),
            Entry("swift", "nts"),
            Entry("go", None),
            Entry("go", "x"),
        ]
        with pytest.raises(UnknownEntriesError) as raised:
            create_key(db, "bot", Scope.SUBMIT, entries)

        assert str(raised.value) == (
            "Project 'llvm' has no test suite named 'ntss'. No project is named 'swift'. "
            "No project is named 'go'."
        )
        assert db.execute(select(func.count()).select_from(api_key)).scalar_one() == 0

    def test_stores_whole_projects_by_identity_before_their_suites(self, db: Connection) -> None:
        created = create_key(
            db,
            "bot",
            Scope.MANAGE,
            [Entry("other", "nts"), Entry("llvm", None), Entry("empty", None)],
        )

        # By project name, a whole project before the suites of that project (E11).
        expected = (Entry("empty", None), Entry("llvm", None), Entry("other", "nts"))
        assert created.restricted_to == expected
        rows = db.execute(
            select(project.c.name, schema.c.namespace)
            .select_from(api_key_restriction)
            .outerjoin(project, project.c.id == api_key_restriction.c.project_id)
            .outerjoin(schema, schema.c.id == api_key_restriction.c.suite_id)
            .order_by(project.c.name, schema.c.namespace)
        ).all()
        assert [tuple(row) for row in rows] == [
            ("empty", None),
            ("llvm", None),
            (None, "other_nts"),
        ]
        resolved = keys.resolve_token(db, created.token)
        assert resolved is not None
        assert resolved.restricted_to == expected
        assert resolved.covers("llvm", "nts")
        assert resolved.covers("llvm", None)
        assert resolved.covers("empty", None)
        assert not resolved.covers("other", None)

    def test_sorts_projects_by_code_point(self, db: Connection) -> None:
        # Not by the database's collation, which may ignore `-` and `_`, and put `lib_b` before a
        # suite of `lib-a`.
        created = create_key(
            db,
            "bot",
            Scope.SUBMIT,
            [Entry("lib_b", None), Entry("lib-a", None), Entry("libcxx", None)],
        )

        expected = (Entry("lib-a", None), Entry("lib_b", None), Entry("libcxx", None))
        assert created.restricted_to == expected

    def test_follows_a_suite_moved_into_a_project_it_lists(self, db: Connection) -> None:
        created = create_key(db, "bot", Scope.MANAGE, [Entry("llvm", "nts"), Entry("libcxx", None)])

        # A move changes only the suite's project (D7). Both entries stay, and the suite's follows
        # the suite (I5).
        libcxx = db.execute(select(project.c.id).where(project.c.name == "libcxx")).scalar_one()
        db.execute(update(schema).where(schema.c.namespace == "llvm_nts").values(project_id=libcxx))
        resolved = keys.resolve_token(db, created.token)
        assert resolved is not None
        assert resolved.restricted_to == (Entry("libcxx", None), Entry("libcxx", "nts"))
        assert resolved.covers("libcxx", "nts")
        assert resolved.covers("libcxx", None)
        assert not resolved.covers("llvm", "nts")

    def test_a_whole_project_gains_a_suite_moved_into_it_and_loses_one_moved_out(
        self, db: Connection
    ) -> None:
        created = create_key(db, "bot", Scope.MANAGE, [Entry("llvm", None)])
        other = db.execute(select(project.c.id).where(project.c.name == "other")).scalar_one()

        db.execute(update(schema).where(schema.c.namespace == "llvm_ab").values(project_id=other))
        db.execute(
            update(schema)
            .where(schema.c.namespace == "libcxx_benchmarks")
            .values(
                project_id=db.execute(
                    select(project.c.id).where(project.c.name == "llvm")
                ).scalar_one()
            )
        )
        resolved = keys.resolve_token(db, created.token)
        assert resolved is not None
        assert resolved.restricted_to == (Entry("llvm", None),)
        assert resolved.covers("llvm", "benchmarks")
        assert not resolved.covers("other", "ab")

    def test_loses_a_project_that_is_deleted(self, db: Connection) -> None:
        created = create_key(db, "bot", Scope.MANAGE, [Entry("empty", None), Entry("llvm", "nts")])

        db.execute(delete(project).where(project.c.name == "empty"))
        resolved = keys.resolve_token(db, created.token)
        assert resolved is not None
        assert resolved.restricted_to == (Entry("llvm", "nts"),)

        # Restricted to nothing, rather than valid across the instance (I5).
        db.execute(delete(schema).where(schema.c.namespace == "llvm_nts"))
        resolved = keys.resolve_token(db, created.token)
        assert resolved is not None
        assert resolved.restricted_to == ()

    def test_names_a_whole_project_as_such(self) -> None:
        assert str(Entry("llvm", None)) == "llvm (all)"
        assert str(Entry("llvm", "nts")) == "llvm/nts"


def key_with(scope: Scope, restricted_to: tuple[Entry, ...] | None) -> ApiKeyInfo:
    return ApiKeyInfo(
        prefix="0123abcd",
        name="a key",
        scope=scope,
        restricted_to=restricted_to,
        created_at=datetime.now(UTC),
        last_used_at=None,
        is_active=True,
    )


NTS = Entry("llvm", "nts")
BENCHMARKS = Entry("libcxx", "benchmarks")
LIBCXX = Entry("libcxx", None)


class TestRestriction:
    """`ApiKeyInfo.grants`: I5's scope hierarchy, narrowed to `read` outside what a key covers."""

    @pytest.mark.parametrize(
        ("restricted_to", "project_name", "suite", "granted"),
        [
            (None, "llvm", "nts", True),
            (None, "llvm", None, True),
            (None, None, None, True),
            ((BENCHMARKS, NTS), "llvm", "nts", True),
            ((BENCHMARKS,), "llvm", "nts", False),
            # The same suite name in another project is another suite (D7).
            ((NTS,), "other", "nts", False),
            # A suite is not its project in full, nor the instance.
            ((NTS,), "llvm", None, False),
            ((NTS,), None, None, False),
            # A whole project covers its suites and itself in full, and nothing else.
            ((LIBCXX,), "libcxx", "benchmarks", True),
            ((LIBCXX,), "libcxx", None, True),
            ((LIBCXX,), "llvm", None, False),
            ((LIBCXX,), None, None, False),
            # Only None is "valid across the instance". A key whose entries have all been deleted
            # lists none, and is not mistaken for it.
            ((), "llvm", "nts", False),
            ((), None, None, False),
        ],
    )
    def test_grants_its_scope_only_where_it_covers(
        self,
        restricted_to: tuple[Entry, ...] | None,
        project_name: str | None,
        suite: str | None,
        granted: bool,
    ) -> None:
        key = key_with(Scope.MANAGE, restricted_to)
        assert key.grants(Scope.MANAGE, project_name, suite) is granted

    @pytest.mark.parametrize(
        ("project_name", "suite"), [("llvm", "nts"), ("llvm", None), (None, None)]
    )
    def test_grants_read_everywhere(self, project_name: str | None, suite: str | None) -> None:
        assert key_with(Scope.MANAGE, (BENCHMARKS,)).grants(Scope.READ, project_name, suite)
        assert key_with(Scope.MANAGE, ()).grants(Scope.READ, project_name, suite)

    def test_keeps_the_hierarchy_within_what_it_covers(self) -> None:
        key = key_with(Scope.TRIAGE, (NTS,))

        assert key.grants(Scope.SUBMIT, "llvm", "nts")
        assert not key.grants(Scope.MANAGE, "llvm", "nts")


class TestLastUseRecorder:
    def test_drops_a_failed_write_and_retries_it_on_the_next_use(
        self,
        db_engine: Engine,
        make_key: Callable[..., str],
        read_key: Callable[[str], Any],
        caplog: pytest.LogCaptureFixture,
    ) -> None:
        prefix = make_key()[:8]
        key_id = read_key(prefix).id
        recorder = keys.LastUseRecorder()

        with caplog.at_level(logging.WARNING, logger=keys.__name__):
            recorder.record(create_engine(UNREACHABLE_URL), key_id)

        assert f"Could not record last use of API key {key_id}" in caplog.text
        recorder.record(db_engine, key_id)
        assert read_key(prefix).last_used_at is not None


class TestScopeHierarchy:
    def test_admin_grants_everything(self) -> None:
        assert all(Scope.ADMIN.grants(required) for required in Scope)

    def test_read_grants_only_itself(self) -> None:
        assert Scope.READ.grants(Scope.READ)
        assert not any(Scope.READ.grants(other) for other in Scope if other is not Scope.READ)

    def test_every_scope_grants_itself(self) -> None:
        assert all(scope.grants(scope) for scope in Scope)

    def test_is_not_the_alphabetical_order_str_comparison_would_give(self) -> None:
        # Compared as plain strings, "admin" sorts below "read" -- the exact inversion of I5's
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
    def test_grants_along_the_scope_ladder(
        self, holder: Scope, required: Scope, granted: bool
    ) -> None:
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

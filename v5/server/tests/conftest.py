"""Shared fixtures.

Every test gets a clean settings cache and an environment scrubbed of LNT variables, so that a
developer's `.env` or exported shell variables cannot change what the suite asserts.

Tests that touch the database run against a real PostgreSQL server -- see `database_factory`.
"""

from __future__ import annotations

import re
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any
from uuid import uuid4

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import Connection, Engine, create_engine, insert, make_url, select, text
from sqlalchemy.exc import OperationalError
from sqlalchemy.pool import NullPool

from lnt_v5.app import create_app
from lnt_v5.config import Settings, get_settings
from lnt_v5.keys import create_key
from lnt_v5.migrate import upgrade_to_head
from lnt_v5.scopes import Scope
from lnt_v5.tables import SCHEMA_VERSION_ID, api_key, metadata, schema_version

# Derived rather than hardcoded: a setting added to Settings but forgotten here would silently
# stop being scrubbed, which is exactly the leak this fixture exists to prevent.
LNT_ENV_VARS = [name.upper() for name in Settings.model_fields]

# The server to create throwaway databases on. Matches docker-compose.yml, so `npm run db:up` is
# all a developer needs, and CI runs a service container on the same port. Not overridable from the
# environment: nothing had reason to, and a knob nothing sets is one more thing to keep working.
# Anyone who needs a different server can change this line.
TEST_DATABASE_URL = "postgresql+psycopg://lnt:lnt@127.0.0.1:5432/lnt"

# R5's token shape. Written out from the specification rather than derived from the constants the
# generator uses, so that changing those has to be a deliberate change here too.
TOKEN_PATTERN = re.compile(r"\A[0-9a-f]{64}\Z")


@pytest.fixture(autouse=True)
def clean_env(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    for name in LNT_ENV_VARS:
        monkeypatch.delenv(name, raising=False)
    get_settings.cache_clear()
    yield


@pytest.fixture
def client_dist(tmp_path: Path) -> Path:
    """A stand-in for a built client bundle."""
    dist = tmp_path / "dist"
    dist.mkdir()
    (dist / "index.html").write_text("<!doctype html><title>LNT</title>")
    (dist / "real.css").write_text("body{}")
    return dist


@pytest.fixture
def settings(client_dist: Path) -> Settings:
    return Settings(
        database_url="postgresql://lnt:lnt@127.0.0.1:5432/lnt",
        client_dist=str(client_dist),
    )


@pytest.fixture
def client(settings: Settings) -> TestClient:
    """A client over the real application, without entering its lifespan.

    Enough for everything that does not touch the database; tests that need an engine build the
    app themselves so they can replace it after startup.
    """
    return TestClient(create_app(settings))


# --------------------------------------------------------------------------------------------
# Database
#
# These tests run against a real PostgreSQL server rather than a stand-in, because essentially
# everything they cover is Postgres-specific: savepoint retry (D13), partial and compound
# indexes, cascades, and geomean in SQL. An unreachable server is a hard failure rather than a
# skip -- a suite that quietly stops testing the database is worse than one that stops.
# --------------------------------------------------------------------------------------------


@pytest.fixture(scope="session")
def database_factory() -> Iterator[Callable[[], str]]:
    """Hands out throwaway databases, and drops every one of them at the end of the session."""
    # AUTOCOMMIT because CREATE DATABASE cannot run inside a transaction. NullPool so this holds
    # no connection open for the length of the session.
    admin = create_engine(TEST_DATABASE_URL, isolation_level="AUTOCOMMIT", poolclass=NullPool)
    created: list[str] = []

    def make() -> str:
        name = f"lnt_test_{uuid4().hex[:12]}"
        try:
            with admin.connect() as connection:
                connection.execute(text(f'CREATE DATABASE "{name}"'))
        except OperationalError as error:
            pytest.fail(
                "These tests need a PostgreSQL server at "
                f"{make_url(TEST_DATABASE_URL).render_as_string()}. Start one with "
                f"`npm run db:up`.\n\n{error.orig}",
                pytrace=False,
            )
        created.append(name)
        return make_url(TEST_DATABASE_URL).set(database=name).render_as_string(hide_password=False)

    yield make

    with admin.connect() as connection:
        for name in created:
            # FORCE because a test that leaked a connection would otherwise block the drop.
            connection.execute(text(f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)'))
    admin.dispose()


@pytest.fixture
def empty_database_url(database_factory: Callable[[], str]) -> str:
    """A brand-new database with nothing in it, not even a migration history."""
    return database_factory()


@pytest.fixture
def empty_engine(empty_database_url: str) -> Iterator[Engine]:
    """An engine over a database that has never been migrated."""
    engine = create_engine(empty_database_url)
    yield engine
    engine.dispose()


@pytest.fixture(scope="session")
def migrated_database_url(database_factory: Callable[[], str]) -> str:
    """A database at the current head revision, shared by every test that just needs tables."""
    url = database_factory()
    engine = create_engine(url, poolclass=NullPool)
    try:
        upgrade_to_head(engine)
    finally:
        engine.dispose()
    return url


@pytest.fixture(scope="session")
def _session_engine(migrated_database_url: str) -> Iterator[Engine]:
    engine = create_engine(migrated_database_url)
    yield engine
    engine.dispose()


@pytest.fixture
def db_engine(_session_engine: Engine) -> Iterator[Engine]:
    """The migrated database, emptied again after the test.

    Emptying rather than rolling back, so that code under test is free to manage its own
    transactions and savepoints -- which D13's get-or-create does, and which an outer
    rollback-everything transaction would quietly interfere with.
    """
    yield _session_engine
    with _session_engine.begin() as connection:
        # Driven by the metadata rather than a written-out list, so that a global table added by a
        # later revision is emptied too. Missing one would leak rows into whatever test ran next,
        # and surface as an unrelated flake rather than as an obvious omission here.
        tables = ", ".join(f'"{table.name}"' for table in metadata.sorted_tables)
        connection.execute(text(f"TRUNCATE {tables} RESTART IDENTITY CASCADE"))
        # D5 requires this row to exist, so it is restored rather than left truncated away.
        connection.execute(insert(schema_version).values(id=SCHEMA_VERSION_ID, version=0))


@pytest.fixture
def db(db_engine: Engine) -> Iterator[Connection]:
    """A connection in a transaction, committed when the test ends."""
    with db_engine.begin() as connection:
        yield connection


def _key_values(**overrides: Any) -> dict[str, Any]:
    """The columns of a stand-in `api_key` row, with whichever ones a test cares about replaced.

    One definition so that the tests which insert a row to collide with, and those which insert
    one to read back, agree on what "the same key" is.
    """
    values: dict[str, Any] = {
        "prefix": "0123abcd",
        "key_hash": "a" * 64,
        "name": "a key",
        "scope": Scope.READ.value,
    }
    return values | overrides


@pytest.fixture
def insert_key(db: Connection) -> Callable[..., None]:
    """Insert an `api_key` row into the test's own transaction."""

    def add(**overrides: Any) -> None:
        db.execute(insert(api_key).values(**_key_values(**overrides)))

    return add


@pytest.fixture
def store_key(db_engine: Engine) -> Callable[..., None]:
    """Insert an `api_key` row and commit it.

    Distinct from `insert_key` because a row written into the test's own open transaction is
    invisible to the server, which reaches the database on a connection of its own.
    """

    def add(**overrides: Any) -> None:
        with db_engine.begin() as connection:
            connection.execute(insert(api_key).values(**_key_values(**overrides)))

    return add


# --------------------------------------------------------------------------------------------
# The API
#
# These drive the real application over a real database, which is what the authentication path
# needs: it resolves every token against the `api_key` table rather than against a stand-in.
# --------------------------------------------------------------------------------------------


@pytest.fixture
def api_settings(db_engine: Engine, client_dist: Path) -> Settings:
    return Settings(
        database_url=db_engine.url.render_as_string(hide_password=False),
        client_dist=str(client_dist),
    )


@pytest.fixture
def api_app(api_settings: Settings) -> FastAPI:
    return create_app(api_settings)


@pytest.fixture
def api_client(api_app: FastAPI) -> Iterator[TestClient]:
    """A client over the application, with its lifespan entered so it has an engine."""
    with TestClient(api_app) as client:
        yield client


@pytest.fixture
def make_key(db_engine: Engine) -> Callable[..., str]:
    """Mint a real key and return its token, committed so the server can resolve it."""

    def make(scope: Scope = Scope.ADMIN, name: str = "test key") -> str:
        with db_engine.begin() as connection:
            return create_key(connection, name, scope).token

    return make


@pytest.fixture
def read_key(db_engine: Engine) -> Callable[[str], Any]:
    """The stored row for a key prefix, read on a connection of its own."""

    def read(prefix: str) -> Any:
        with db_engine.connect() as connection:
            return connection.execute(select(api_key).where(api_key.c.prefix == prefix)).one()

    return read


@pytest.fixture
def bearer() -> Callable[[str], dict[str, str]]:
    def header(token: str) -> dict[str, str]:
        return {"Authorization": f"Bearer {token}"}

    return header


@pytest.fixture
def configured_database(db_engine: Engine, monkeypatch: pytest.MonkeyPatch) -> Engine:
    """Point `Settings` -- and so the CLI -- at the migrated test database."""
    monkeypatch.setenv("DATABASE_URL", db_engine.url.render_as_string(hide_password=False))
    get_settings.cache_clear()
    return db_engine


@pytest.fixture
def configured_empty_database(empty_database_url: str, monkeypatch: pytest.MonkeyPatch) -> str:
    """Point `Settings` at a real database that has never been migrated."""
    monkeypatch.setenv("DATABASE_URL", empty_database_url)
    get_settings.cache_clear()
    return empty_database_url

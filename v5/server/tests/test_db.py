"""How an endpoint reaches the database, and reading Postgres' errors."""

from __future__ import annotations

from collections.abc import Callable, Iterator

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from httpx2 import Response
from sqlalchemy import Connection, Engine, func, insert, select, text
from sqlalchemy.exc import DBAPIError, IntegrityError
from sqlalchemy.pool import QueuePool

from lnt_v5.db import EngineDep, is_undefined_table, unique_violation_constraint
from lnt_v5.errors import register_error_handlers
from lnt_v5.tables import schema


def make_app(engine: Engine) -> FastAPI:
    """A bare app carrying an engine, so the dependency is exercised on its own.

    Deliberately not `create_app`: that mounts the SPA at "/", which matches everything, so a
    route registered afterwards would be unreachable.
    """
    app = FastAPI()
    register_error_handlers(app)
    app.state.engine = engine
    return app


def suites(engine: Engine) -> list[str]:
    with engine.connect() as connection:
        return list(connection.execute(select(schema.c.name)).scalars())


@pytest.fixture
def commit_probe(db_engine: Engine) -> Iterator[None]:
    """A table whose unique constraint is checked at COMMIT rather than at INSERT."""
    with db_engine.begin() as connection:
        connection.execute(
            text(
                "CREATE TABLE commit_probe (v integer, CONSTRAINT uq_commit_probe "
                "UNIQUE (v) DEFERRABLE INITIALLY DEFERRED)"
            )
        )
    yield
    with db_engine.begin() as connection:
        connection.execute(text("DROP TABLE commit_probe"))


@pytest.fixture
def failing_commit(db_engine: Engine, commit_probe: None) -> Response:
    """The response from a request whose endpoint succeeds but whose COMMIT does not.

    A deferred unique constraint arranges it: the duplicate is accepted at INSERT and rejected at
    COMMIT, which is the shape of every real commit failure -- a dropped connection, a session
    killed for being idle, a full disk.
    """
    app = make_app(db_engine)

    @app.post("/commit-fails")
    def commit_fails(db: EngineDep) -> dict[str, bool]:
        with db.begin() as connection:
            connection.execute(text("INSERT INTO commit_probe (v) VALUES (1), (1)"))
        return {"ok": True}

    return TestClient(app, raise_server_exceptions=False).post("/commit-fails")


class TestUnitOfWork:
    def test_commits_what_the_endpoint_wrote(self, db_engine: Engine) -> None:
        app = make_app(db_engine)

        @app.post("/write")
        def write(db: EngineDep) -> dict[str, bool]:
            with db.begin() as connection:
                connection.execute(insert(schema).values(name="nts", schema_json="{}"))
            return {"ok": True}

        response = TestClient(app).post("/write")

        assert response.status_code == 200
        assert suites(db_engine) == ["nts"]

    def test_rolls_back_everything_when_the_endpoint_raises(self, db_engine: Engine) -> None:
        # What D13 requires of a run submission: it either fully succeeds or leaves no trace,
        # including rows written before whatever went wrong.
        app = make_app(db_engine)

        @app.post("/half-written")
        def half_written(db: EngineDep) -> dict[str, bool]:
            with db.begin() as connection:
                connection.execute(insert(schema).values(name="nts", schema_json="{}"))
                raise RuntimeError("something went wrong after the first write")

        response = TestClient(app, raise_server_exceptions=False).post("/half-written")

        assert response.status_code == 500
        assert response.json()["error"]["code"] == "internal_error"
        assert suites(db_engine) == []

    def test_a_failing_commit_is_not_reported_as_success(
        self, db_engine: Engine, failing_commit: Response
    ) -> None:
        """Why the unit of work is a block inside the endpoint rather than a `yield` dependency.

        FastAPI closes the exit stack holding a `yield` dependency only after the response has been
        sent, so a COMMIT there lands too late to influence the status: a commit that failed would
        reach the client as a success for data that does not exist, and a submitting bot would mark
        the job done and move on. Committing inside the endpoint keeps it an ordinary 500.
        """
        assert failing_commit.status_code == 500
        assert failing_commit.json()["error"]["code"] == "internal_error"

        with db_engine.connect() as connection:
            probed = connection.execute(text("SELECT count(*) FROM commit_probe")).scalar_one()
        assert probed == 0

    def test_releases_its_connection_before_the_response_is_built(self, db_engine: Engine) -> None:
        # The other half of keeping the unit of work inside the endpoint. A `yield` dependency
        # holds its connection until after the response has been serialized and written, so a slow
        # client pins one of the pool's ten for that whole time; leaving the block hands it back at
        # once. Asserted from inside the endpoint, the only place the difference is visible.
        app = make_app(db_engine)

        @app.get("/checkedout")
        def checkedout(db: EngineDep) -> dict[str, int]:
            with db.begin() as connection:
                connection.execute(select(func.count()).select_from(schema))
            pool = db.pool
            assert isinstance(pool, QueuePool)
            return {"checkedout": pool.checkedout()}

        assert TestClient(app).get("/checkedout").json() == {"checkedout": 0}

    def test_returns_its_connection_to_the_pool(self, db_engine: Engine) -> None:
        app = make_app(db_engine)

        @app.get("/count")
        def count(db: EngineDep) -> dict[str, int]:
            with db.begin() as connection:
                total = connection.execute(select(func.count()).select_from(schema)).scalar_one()
            return {"n": total}

        client = TestClient(app)

        # More requests than the pool holds, because a leaked connection would only show up once
        # the pool ran dry.
        assert [client.get("/count").json()["n"] for _ in range(15)] == [0] * 15


class TestReadingErrors:
    def test_names_the_unique_constraint_that_was_violated(
        self, db: Connection, insert_key: Callable[..., None]
    ) -> None:
        # The distinction R4 turns into `duplicate` versus `ordinal_conflict`, and the one
        # create_key reads to decide whether to retry.
        insert_key()

        with pytest.raises(IntegrityError) as caught, db.begin_nested():
            insert_key(key_hash="b" * 64)

        assert unique_violation_constraint(caught.value) == "uq_api_key_prefix"

    def test_distinguishes_two_constraints_on_the_same_table(
        self, db: Connection, insert_key: Callable[..., None]
    ) -> None:
        insert_key()

        with pytest.raises(IntegrityError) as caught, db.begin_nested():
            insert_key(prefix="ffffffff")

        assert unique_violation_constraint(caught.value) == "uq_api_key_key_hash"

    def test_returns_no_constraint_for_an_error_of_another_kind(self, db: Connection) -> None:
        with pytest.raises(DBAPIError) as caught, db.begin_nested():
            db.execute(text("SELECT * FROM a_table_that_does_not_exist"))

        assert unique_violation_constraint(caught.value) is None

    def test_recognizes_a_database_that_was_never_migrated(self, db: Connection) -> None:
        # How the CLI tells "your database has no tables" from "your database is unreachable".
        with pytest.raises(DBAPIError) as caught, db.begin_nested():
            db.execute(text("SELECT * FROM a_table_that_does_not_exist"))

        assert is_undefined_table(caught.value)

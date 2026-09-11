from __future__ import annotations

from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.pool import NullPool

from lnt_v5.app import create_app
from lnt_v5.config import Settings

# Port 1 is reserved and never listening, so a connection attempt fails fast with ECONNREFUSED.
# This exercises a real connect-time failure -- which is how production actually fails (pool
# exhaustion, DNS, failover) -- rather than a stubbed execute() that raises.
UNREACHABLE_URL = "postgresql+psycopg://lnt:lnt@127.0.0.1:1/lnt"


def test_returns_ok_when_the_database_responds(settings: Settings) -> None:
    # Also covers route ordering: the SPA is mounted at "/" and matches everything, so registering
    # it before this route would shadow it and every health test would 404 uniformly.
    app = create_app(settings)
    with TestClient(app) as client:
        # An in-memory SQLite engine stands in for Postgres: /healthz only asserts that a trivial
        # query round-trips, so the dialect is irrelevant. NullPool because `healthz` is a sync
        # def and so opens its connection in an anyio worker thread; SQLite's default
        # SingletonThreadPool would hold it past the request and then fail to close it from the
        # event loop thread at shutdown, leaking it until GC.
        app.state.engine = create_engine("sqlite://", poolclass=NullPool)

        response = client.get("/healthz")

    assert response.status_code == 200
    assert response.json() == {"ok": True}


def test_returns_500_when_the_database_is_unreachable(settings: Settings) -> None:
    app = create_app(settings)
    with TestClient(app) as client:
        app.state.engine = create_engine(UNREACHABLE_URL)

        response = client.get("/healthz")

    assert response.status_code == 500
    # R7 specifies this exact body. It must not be rewritten into the R4 error envelope: /healthz
    # is an infrastructure probe, deliberately outside the REST API surface.
    assert response.json() == {"ok": False}
    assert "error" not in response.json()

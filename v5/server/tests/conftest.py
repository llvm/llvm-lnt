"""Shared fixtures.

Every test gets a clean settings cache and an environment scrubbed of LNT variables, so that a
developer's `.env` or exported shell variables cannot change what the suite asserts.
"""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from lnt_v5.app import create_app
from lnt_v5.config import Settings, get_settings

# Derived rather than hardcoded: a setting added to Settings but forgotten here would silently
# stop being scrubbed, which is exactly the leak this fixture exists to prevent.
LNT_ENV_VARS = [name.upper() for name in Settings.model_fields]


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

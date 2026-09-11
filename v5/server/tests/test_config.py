from __future__ import annotations

import pytest
from pydantic import ValidationError

from lnt_v5.config import Settings, get_settings


class TestDatabaseUrl:
    def test_reports_the_environment_variable_name_when_unset(self) -> None:
        # The message is operator-facing: it shows up in `docker logs` when a deployment is
        # missing configuration, so it names the variable rather than the pydantic field.
        with pytest.raises(
            ValidationError, match="Missing required environment variable: DATABASE_URL"
        ):
            Settings()

    def test_reads_the_environment_variable(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("DATABASE_URL", "postgres://localhost/test")
        assert get_settings().database_url == "postgres://localhost/test"


class TestSqlalchemyUrl:
    @pytest.mark.parametrize(
        "given",
        [
            "postgres://lnt:lnt@localhost:5432/lnt",
            "postgresql://lnt:lnt@localhost:5432/lnt",
            "postgresql+psycopg://lnt:lnt@localhost:5432/lnt",
        ],
    )
    def test_normalizes_to_the_psycopg_driver(self, given: str) -> None:
        # SQLAlchemy 2.0 removed the `postgres://` alias, and bare `postgresql://` selects
        # psycopg2, which is not installed. Both forms appear in .env.example, the README and CI.
        settings = Settings(database_url=given)
        assert settings.sqlalchemy_url == "postgresql+psycopg://lnt:lnt@localhost:5432/lnt"

    def test_leaves_a_non_postgres_url_alone(self) -> None:
        settings = Settings(database_url="sqlite:///tmp.db")
        assert settings.sqlalchemy_url == "sqlite:///tmp.db"


class TestDatabaseSslCa:
    def test_defaults_to_none(self) -> None:
        assert Settings(database_url="postgres://x/y").database_ssl_ca is None

    def test_reads_the_environment_variable(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("DATABASE_URL", "postgres://x/y")
        monkeypatch.setenv("DATABASE_SSL_CA", "/etc/ssl/rds.pem")
        assert get_settings().database_ssl_ca == "/etc/ssl/rds.pem"


class TestBodyLimit:
    def test_default_admits_a_base64_encoded_maximum_profile(self) -> None:
        # Stated as the invariant rather than the literal: D5 caps a profile at 50 MB decoded and
        # D6 carries it inline as base64, which inflates by 4/3.
        assert Settings(database_url="postgres://x/y").body_limit > 50 * 1024 * 1024 * 4 / 3

    def test_reads_the_environment_variable(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("DATABASE_URL", "postgres://x/y")
        monkeypatch.setenv("BODY_LIMIT", "1048576")
        assert get_settings().body_limit == 1048576


class TestWebConcurrency:
    def test_defaults_to_a_single_worker(self) -> None:
        assert Settings(database_url="postgres://x/y").web_concurrency == 1

    def test_reads_the_environment_variable(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("DATABASE_URL", "postgres://x/y")
        monkeypatch.setenv("WEB_CONCURRENCY", "4")
        assert get_settings().web_concurrency == 4

    @pytest.mark.parametrize("workers", [0, -1])
    def test_rejects_a_non_positive_count(self, workers: int) -> None:
        # uvicorn would otherwise come up serving nothing, which reads as a hung deploy rather
        # than as the configuration error it is.
        with pytest.raises(ValidationError):
            Settings(database_url="postgres://x/y", web_concurrency=workers)

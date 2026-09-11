"""The `lnt-v5` command-line entry point.

uvicorn is stubbed throughout: these assert how the server would be started, not that it starts.
Migrations are stubbed in the same spirit, except where a test names a database of its own.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest
import uvicorn
from sqlalchemy import Engine, func, inspect, select
from sqlalchemy.exc import OperationalError

from conftest import TOKEN_PATTERN
from lnt_v5 import cli, migrate
from lnt_v5.config import get_settings
from lnt_v5.scopes import Scope
from lnt_v5.tables import api_key, metadata


@pytest.fixture
def configured(monkeypatch: pytest.MonkeyPatch) -> None:
    """Valid-looking configuration that nothing can actually connect to.

    Port 1 is reserved and never listening, so a test that reaches the database when it meant to
    stub it fails fast instead of quietly migrating whatever a developer has on 5432.
    """
    monkeypatch.setenv("DATABASE_URL", "postgresql://lnt:lnt@127.0.0.1:1/lnt")


@pytest.fixture
def uvicorn_run(monkeypatch: pytest.MonkeyPatch) -> list[dict[str, Any]]:
    """Capture how the serving subcommands would start uvicorn, without starting it."""
    calls: list[dict[str, Any]] = []

    def record(app: str, **kwargs: Any) -> None:
        calls.append({"app": app, **kwargs})

    monkeypatch.setattr(uvicorn, "run", record)
    return calls


@pytest.fixture
def migrations(monkeypatch: pytest.MonkeyPatch) -> list[str]:
    """Capture that migrations would run, without touching a database."""
    applied: list[str] = []

    def record(engine: Engine) -> migrate.MigrationResult:
        applied.append(engine.url.render_as_string())
        return migrate.MigrationResult(before="0001", after="0001")

    monkeypatch.setattr(migrate, "upgrade_to_head", record)
    return applied


class TestArgumentParsing:
    @pytest.mark.parametrize(
        ("argv", "why"),
        [
            ([], "bare invocation"),
            (["server"], "group without a command"),
            (["server", "nonesuch"], "unknown command"),
            (["server", "create-key"], "neither --name nor --scope"),
            (["server", "create-key", "--name", "k"], "no --scope"),
            (["server", "create-key", "--scope", "admin"], "no --name"),
            (["server", "create-key", "--name", "k", "--scope", "root"], "not a scope"),
        ],
    )
    def test_rejects_with_the_conventional_usage_status(self, argv: list[str], why: str) -> None:
        # 2 is what argparse and the shell convention reserve for a usage error, as distinct from
        # the 1 the commands themselves return when they run but fail.
        with pytest.raises(SystemExit) as exit_info:
            cli.main(argv)

        assert exit_info.value.code == 2, why

    def test_lists_the_scopes_when_one_is_misspelled(
        self, capsys: pytest.CaptureFixture[str]
    ) -> None:
        # An operator bootstrapping a deployment hits this over an SSM session, so the error has
        # to say what is accepted rather than only that the input was not.
        with pytest.raises(SystemExit):
            cli.main(["server", "create-key", "--name", "k", "--scope", "root"])

        assert "admin" in capsys.readouterr().err

    def test_parses_before_reading_configuration(self) -> None:
        # No DATABASE_URL is set here (conftest scrubs it), so reaching a usage error at all
        # proves `--help` and friends work on a machine with nothing configured.
        with pytest.raises(SystemExit):
            cli.main(["server"])


class TestConfiguration:
    def test_reports_a_missing_variable_without_a_traceback(
        self, capsys: pytest.CaptureFixture[str]
    ) -> None:
        assert cli.main(["server", "dev"]) == 1

        captured = capsys.readouterr()
        assert "DATABASE_URL" in captured.err
        assert "Traceback" not in captured.err

    def test_is_resolved_before_any_worker_starts(self, uvicorn_run: list[dict[str, Any]]) -> None:
        # `server run` forks workers that would each fail identically on a bad environment.
        # Failing in the parent means the operator sees the problem once.
        assert cli.main(["server", "run"]) == 1
        assert uvicorn_run == []


class TestServerRun:
    # Autouse rather than a parameter on every test: `server run` migrates before it serves, so a
    # test here that forgot to stub it would reach for a real database.
    @pytest.fixture(autouse=True)
    def stub_migrations(self, migrations: list[str]) -> None:
        pass

    def test_serves_the_app_factory_on_the_fixed_port(
        self, configured: None, uvicorn_run: list[dict[str, Any]]
    ) -> None:
        assert cli.main(["server", "run"]) == 0

        (call,) = uvicorn_run
        # The import-string form is required to run workers or reload: each child re-imports it.
        assert call["app"] == "lnt_v5.app:create_app"
        assert call["factory"] is True
        # Vite's dev proxy, the Dockerfile's EXPOSE and its HEALTHCHECK all name this port.
        assert call["port"] == 3000
        assert "reload" not in call

    def test_defaults_to_a_single_worker(
        self, configured: None, uvicorn_run: list[dict[str, Any]]
    ) -> None:
        assert cli.main(["server", "run"]) == 0
        assert uvicorn_run[0]["workers"] == 1

    def test_takes_the_worker_count_from_the_environment(
        self,
        configured: None,
        uvicorn_run: list[dict[str, Any]],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        # Terraform's user_data and the integration tests both set this.
        monkeypatch.setenv("WEB_CONCURRENCY", "4")

        assert cli.main(["server", "run"]) == 0
        assert uvicorn_run[0]["workers"] == 4

    def test_lets_a_slow_request_finish_on_shutdown(
        self, configured: None, uvicorn_run: list[dict[str, Any]]
    ) -> None:
        # A submission can carry tens of megabytes of inline profile data, and every deploy
        # replaces the instance, so a short window would cut off legitimate work routinely.
        assert cli.main(["server", "run"]) == 0
        assert uvicorn_run[0]["timeout_graceful_shutdown"] >= 120

    def test_migrates_before_serving(
        self, configured: None, migrations: list[str], uvicorn_run: list[dict[str, Any]]
    ) -> None:
        # In this process, before uvicorn starts any workers, so that they cannot race each
        # other to apply the same DDL (D14).
        assert cli.main(["server", "run"]) == 0
        assert len(migrations) == 1

    def test_refuses_to_serve_when_the_database_cannot_be_migrated(
        self,
        configured: None,
        uvicorn_run: list[dict[str, Any]],
        monkeypatch: pytest.MonkeyPatch,
        capsys: pytest.CaptureFixture[str],
    ) -> None:
        # A server whose database is not up to date would fail every request, which reads as a
        # broken deploy rather than as the configuration problem it is.
        def unreachable(engine: Engine) -> migrate.MigrationResult:
            raise OperationalError("SELECT 1", None, Exception("connection refused"))

        monkeypatch.setattr(migrate, "upgrade_to_head", unreachable)

        assert cli.main(["server", "run"]) == 1
        assert uvicorn_run == []
        assert "connection refused" in capsys.readouterr().err


class TestServerDev:
    @pytest.fixture(autouse=True)
    def stub_migrations(self, migrations: list[str]) -> None:
        pass

    def test_enables_autoreload(self, configured: None, uvicorn_run: list[dict[str, Any]]) -> None:
        assert cli.main(["server", "dev"]) == 0
        assert uvicorn_run[0]["reload"] is True

    def test_watches_only_the_server_package(
        self, configured: None, uvicorn_run: list[dict[str, Any]]
    ) -> None:
        # npm runs this from v5/, so uvicorn's default of the working directory would put
        # client/node_modules and client/dist under the watcher, restarting the API server on
        # every Vite rebuild.
        assert cli.main(["server", "dev"]) == 0

        (watched,) = (Path(directory) for directory in uvicorn_run[0]["reload_dirs"])
        assert (watched / "app.py").is_file()
        assert not (watched / "node_modules").exists()

    def test_migrates_first_too(
        self, configured: None, migrations: list[str], uvicorn_run: list[dict[str, Any]]
    ) -> None:
        # So that `npm run dev` against a fresh `npm run db:up` just works.
        assert cli.main(["server", "dev"]) == 0
        assert len(migrations) == 1


class TestMigrate:
    def test_creates_the_schema_in_an_empty_database(
        self,
        configured_empty_database: str,
        empty_engine: Engine,
        capsys: pytest.CaptureFixture[str],
    ) -> None:
        assert cli.main(["server", "migrate"]) == 0

        assert set(metadata.tables) <= set(inspect(empty_engine).get_table_names())
        assert "Migrated the database" in capsys.readouterr().out

    def test_says_so_when_there_is_nothing_to_do(
        self, configured_empty_database: str, capsys: pytest.CaptureFixture[str]
    ) -> None:
        assert cli.main(["server", "migrate"]) == 0
        capsys.readouterr()

        assert cli.main(["server", "migrate"]) == 0

        assert "already up to date" in capsys.readouterr().out

    def test_reports_an_unreachable_database_without_a_traceback(
        self, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
    ) -> None:
        # Port 1 is reserved and never listening, so this fails fast with ECONNREFUSED.
        monkeypatch.setenv("DATABASE_URL", "postgresql://lnt:lnt@127.0.0.1:1/lnt")
        get_settings.cache_clear()

        assert cli.main(["server", "migrate"]) == 1

        captured = capsys.readouterr()
        assert "cannot use the database" in captured.err
        assert "Traceback" not in captured.err


class TestCreateKey:
    def test_prints_the_token_alone_on_stdout(
        self, configured_database: Engine, capsys: pytest.CaptureFixture[str]
    ) -> None:
        # Documented in docs/deployment.md, and what makes
        #     TOKEN=$(lnt-v5 server create-key --name bot --scope submit)
        # work over an SSM session. Anything a human reads goes to stderr.
        assert cli.main(["server", "create-key", "--name", "bot", "--scope", "submit"]) == 0

        captured = capsys.readouterr()
        assert TOKEN_PATTERN.match(captured.out.strip())
        assert "shown once" in captured.err

    def test_stores_the_key(
        self, configured_database: Engine, capsys: pytest.CaptureFixture[str]
    ) -> None:
        assert cli.main(["server", "create-key", "--name", "bot", "--scope", "submit"]) == 0
        token = capsys.readouterr().out.strip()

        with configured_database.connect() as connection:
            stored = connection.execute(
                select(api_key.c.name, api_key.c.scope, api_key.c.prefix)
            ).one()

        assert stored.name == "bot"
        assert stored.scope == "submit"
        assert stored.prefix == token[:8]

    @pytest.mark.parametrize("scope", [scope.value for scope in Scope])
    def test_accepts_every_scope(self, configured_database: Engine, scope: str) -> None:
        # Spelled out from Scope rather than a literal list so a renamed member fails here, but
        # R5 fixes the set at these five.
        assert cli.main(["server", "create-key", "--name", "k", "--scope", scope]) == 0

    def test_refuses_an_uninitialized_database_rather_than_migrating_it(
        self, configured_empty_database: str, capsys: pytest.CaptureFixture[str]
    ) -> None:
        # Creating a key should not quietly reshape the database, and the operator needs to be
        # told which command will.
        assert cli.main(["server", "create-key", "--name", "k", "--scope", "admin"]) == 1

        captured = capsys.readouterr()
        assert captured.out == ""
        assert "not initialized" in captured.err
        assert "lnt-v5 server migrate" in captured.err

    def test_reports_an_unusable_name_without_a_traceback(
        self, configured_database: Engine, capsys: pytest.CaptureFixture[str]
    ) -> None:
        assert cli.main(["server", "create-key", "--name", "", "--scope", "admin"]) == 1

        captured = capsys.readouterr()
        assert captured.out == ""
        assert "Traceback" not in captured.err
        with configured_database.connect() as connection:
            assert connection.execute(select(func.count()).select_from(api_key)).scalar_one() == 0

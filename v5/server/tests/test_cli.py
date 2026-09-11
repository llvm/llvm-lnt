"""The `lnt-v5` command-line entry point.

uvicorn is stubbed throughout: these assert how the server would be started, not that it starts.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest
import uvicorn

from lnt_v5 import cli


@pytest.fixture
def configured(monkeypatch: pytest.MonkeyPatch) -> None:
    """The minimum environment every subcommand needs."""
    monkeypatch.setenv("DATABASE_URL", "postgresql://lnt:lnt@127.0.0.1:5432/lnt")


@pytest.fixture
def uvicorn_run(monkeypatch: pytest.MonkeyPatch) -> list[dict[str, Any]]:
    """Capture how the serving subcommands would start uvicorn, without starting it."""
    calls: list[dict[str, Any]] = []

    def record(app: str, **kwargs: Any) -> None:
        calls.append({"app": app, **kwargs})

    monkeypatch.setattr(uvicorn, "run", record)
    return calls


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
        self, configured: None, uvicorn_run: list[dict[str, Any]], monkeypatch: pytest.MonkeyPatch
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


class TestServerDev:
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


class TestCreateKey:
    def test_reports_that_the_key_store_does_not_exist_yet(
        self, configured: None, capsys: pytest.CaptureFixture[str]
    ) -> None:
        # Stubbed until there is an api_key table (D5). It has to fail loudly rather than exit 0
        # having done nothing: the documented contract is a token on stdout.
        assert cli.main(["server", "create-key", "--name", "dev", "--scope", "admin"]) == 1

        captured = capsys.readouterr()
        assert captured.out == ""
        assert "does not exist yet" in captured.err

    @pytest.mark.parametrize("scope", ["read", "submit", "triage", "manage", "admin"])
    def test_accepts_every_scope(self, configured: None, scope: str) -> None:
        # Spelled out rather than derived from cli.SCOPES, so that renaming or dropping one is a
        # failure here instead of a silently narrower CLI. R5 fixes the set at these five.
        assert cli.main(["server", "create-key", "--name", "k", "--scope", scope]) == 1

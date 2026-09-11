"""The `lnt-v5` command-line entry point.

Subcommands are grouped one level down: everything under `server` acts on a server instance --
running it, and administering the database behind it.
"""

from __future__ import annotations

import argparse
import sys
from collections.abc import Sequence
from pathlib import Path

import uvicorn
from pydantic import ValidationError

from .config import Settings, get_settings

APP = "lnt_v5.app:create_app"

# R5's five scopes, lowest privilege first. A flat tuple rather than an enum: all this needs is
# the accepted spellings. The hierarchy -- a key grants its own scope and every lower one -- needs
# a type whose ordering is explicit, since str-based comparison is alphabetical and gets
# `read >= manage` backwards, so that belongs with authentication, which will consume it.
SCOPES = ("read", "submit", "triage", "manage", "admin")

# This is fixed and it needs to stay synchronized with what the Dockerfile expects.
# If needed, map it elsewhere at the container boundary instead (`docker run -p 8080:3000`).
PORT = 3000

# How long uvicorn lets in-flight requests finish before dropping them. Generous because a run
# submission may carry a significant payload.
GRACEFUL_SHUTDOWN_SECONDS = 120


def _serve(settings: Settings) -> int:
    """Serve the API and the built client (`server run`).

    Binds all interfaces because the process runs in a container whose published ports are what
    actually decide reachability; in production only Nginx can reach it.
    """
    uvicorn.run(
        APP,
        factory=True,
        host="0.0.0.0",
        port=PORT,
        workers=settings.web_concurrency,
        timeout_graceful_shutdown=GRACEFUL_SHUTDOWN_SECONDS,
    )
    return 0


def _serve_dev() -> int:
    """Serve with autoreload, for development (`server dev`).

    The watched directory is named explicitly since npm runs this from `v5/`, where the
    default would put `client/node_modules` and `client/dist` under the watcher and
    restart the API server on every Vite rebuild.

    No graceful-shutdown window here -- Ctrl-C should be immediate.
    """
    uvicorn.run(
        APP,
        factory=True,
        host="0.0.0.0",  # as above
        port=PORT,
        reload=True,
        reload_dirs=[str(Path(__file__).resolve().parent)],
    )
    return 0


def _create_key(name: str, scope: str) -> int:
    """Create an API key (`server create-key`).

    R5 requires an out-of-band way to create a key, because every key-management endpoint needs
    an `admin` key that a fresh instance does not have. Not yet implemented: there is no
    `api_key` table to write to.
    """
    print(
        f"lnt-v5: cannot create key '{name}' with scope '{scope}': "
        "the API key store does not exist yet.",
        file=sys.stderr,
    )
    return 1


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="lnt-v5", description="Administer an LNT v5 instance.")
    groups = parser.add_subparsers(dest="group", required=True, metavar="GROUP")

    server = groups.add_parser("server", help="run and administer a server instance")
    commands = server.add_subparsers(dest="command", required=True, metavar="COMMAND")

    commands.add_parser("run", help="serve the API and web UI")
    commands.add_parser("dev", help="serve with autoreload, for development")

    create_key = commands.add_parser("create-key", help="create an API key")
    create_key.add_argument("--name", required=True, help="human-readable label for the key")
    create_key.add_argument(
        "--scope",
        required=True,
        choices=SCOPES,
        help="privilege level the key grants",
    )

    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)

    # Every subcommand needs the database, so configuration is resolved up front -- before
    # uvicorn forks any workers, and before create-key opens a connection.
    try:
        settings = get_settings()
    except ValidationError as exc:
        # use a single line instead of a full traceback
        problems = "; ".join(error["msg"] for error in exc.errors())
        print(f"lnt-v5: invalid configuration: {problems}", file=sys.stderr)
        return 1

    if args.command == "run":
        return _serve(settings)
    if args.command == "dev":
        return _serve_dev()
    if args.command == "create-key":
        return _create_key(args.name, args.scope)
    raise AssertionError(f"unhandled command: {args.command}")

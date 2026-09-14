"""The `lnt-v5` command-line entry point.

Subcommands are grouped one level down: everything under `server` acts on a server instance --
running it, and administering the database behind it.
"""

from __future__ import annotations

import argparse
import sys
from collections.abc import Iterator, Sequence
from contextlib import contextmanager
from pathlib import Path

import uvicorn
from pydantic import ValidationError
from sqlalchemy import Engine
from sqlalchemy.exc import DBAPIError

from . import keys, migrate
from .config import Settings, get_settings
from .db import is_undefined_table, make_engine
from .scopes import Scope

APP = "lnt_v5.app:create_app"

# This is fixed and it needs to stay synchronized with what the Dockerfile expects.
# If needed, map it elsewhere at the container boundary instead (`docker run -p 8080:3000`).
PORT = 3000

# How long uvicorn lets in-flight requests finish before dropping them. Generous because a run
# submission may carry a significant payload.
GRACEFUL_SHUTDOWN_SECONDS = 120


def _fail(message: str) -> int:
    print(f"lnt-v5: {message}", file=sys.stderr)
    return 1


def _database_problem(error: DBAPIError) -> str:
    """An operator-facing one-liner for a database error, without a stack trace.

    `error.orig` is the driver's own message; the SQLAlchemy wrapper around it adds a link to its
    documentation and a repr of the statement, neither of which helps here.
    """
    if is_undefined_table(error):
        return "the database is not initialized; run `lnt-v5 server migrate` first"
    return f"cannot use the database: {str(error.orig).strip()}"


@contextmanager
def _database(settings: Settings) -> Iterator[Engine]:
    """An engine for one short-lived command, disposed on the way out.

    Every subcommand that touches the database wants the same three things -- an engine, a
    guarantee it is disposed, and any driver failure reported as one line rather than a traceback.
    Catching `DBAPIError` rather than `OperationalError` matters for the second and third: a
    database that answers but refuses the work (no privilege to create tables, a read-only
    replica) raises `ProgrammingError`, and that is exactly the case an operator hits while
    following the manual-migration instructions in docs/deployment.md.
    """
    engine = make_engine(settings)
    try:
        yield engine
    finally:
        engine.dispose()


def _migrate(settings: Settings) -> int:
    """Bring the database up to date (`server migrate`), reporting what changed."""
    try:
        with _database(settings) as engine:
            result = migrate.upgrade_to_head(engine)
    except DBAPIError as error:
        return _fail(_database_problem(error))

    if result.applied:
        print(f"Migrated the database from {result.before or 'empty'} to {result.after}.")
    else:
        print(f"The database is already up to date at revision {result.after}.")
    return 0


def _serve(settings: Settings) -> int:
    """Serve the API and the built client (`server run`).

    Migrating first, in this process, is what keeps the workers uvicorn is about to start from
    racing each other to apply the same DDL (D14).

    Binds all interfaces because the process runs in a container whose published ports are what
    actually decide reachability; in production only Nginx can reach it.
    """
    if (status := _migrate(settings)) != 0:
        return status

    uvicorn.run(
        APP,
        factory=True,
        host="0.0.0.0",
        port=PORT,
        workers=settings.web_concurrency,
        timeout_graceful_shutdown=GRACEFUL_SHUTDOWN_SECONDS,
    )
    return 0


def _serve_dev(settings: Settings) -> int:
    """Serve with autoreload, for development (`server dev`).

    The watched directory is named explicitly since npm runs this from `v5/`, where the
    default would put `client/node_modules` and `client/dist` under the watcher and
    restart the API server on every Vite rebuild.

    No graceful-shutdown window here -- Ctrl-C should be immediate.
    """
    if (status := _migrate(settings)) != 0:
        return status

    uvicorn.run(
        APP,
        factory=True,
        host="0.0.0.0",  # as above
        port=PORT,
        reload=True,
        reload_dirs=[str(Path(__file__).resolve().parent)],
    )
    return 0


def _create_key(settings: Settings, name: str, scope: Scope) -> int:
    """Create an API key (`server create-key`).

    R5 requires an out-of-band way to create a key, because every key-management endpoint needs
    an `admin` key that a fresh instance does not have, and because revoking the last one is
    otherwise unrecoverable.

    Deliberately does not migrate: creating a key should not quietly reshape the database. An
    uninitialized one is reported as such instead.
    """
    try:
        with _database(settings) as engine, engine.begin() as connection:
            created = keys.create_key(connection, name, scope)
    except ValueError as error:
        return _fail(str(error))
    except DBAPIError as error:
        return _fail(_database_problem(error))

    # The token alone on stdout, so that it can be captured directly:
    #     TOKEN=$(lnt-v5 server create-key --name bot --scope submit)
    # Everything a human wants to read goes to stderr, where it stays out of that.
    print(created.token)
    print(
        f"Created key '{created.name}' with prefix {created.prefix} and scope '{created.scope}'. "
        "The token above is shown once and cannot be recovered.",
        file=sys.stderr,
    )
    return 0


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="lnt-v5", description="Administer an LNT v5 instance.")
    groups = parser.add_subparsers(dest="group", required=True, metavar="GROUP")

    server = groups.add_parser("server", help="run and administer a server instance")
    commands = server.add_subparsers(dest="command", required=True, metavar="COMMAND")

    commands.add_parser("run", help="serve the API and web UI")
    commands.add_parser("dev", help="serve with autoreload, for development")
    commands.add_parser("migrate", help="bring the database up to date")

    create_key = commands.add_parser("create-key", help="create an API key")
    create_key.add_argument("--name", required=True, help="human-readable label for the key")
    create_key.add_argument(
        "--scope",
        required=True,
        # The values rather than the members, so that a misspelling is answered by argparse with
        # the list of what is accepted -- an operator hits this over an SSM session.
        choices=[scope.value for scope in Scope],
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
        return _serve_dev(settings)
    if args.command == "migrate":
        return _migrate(settings)
    if args.command == "create-key":
        return _create_key(settings, args.name, Scope(args.scope))
    raise AssertionError(f"unhandled command: {args.command}")

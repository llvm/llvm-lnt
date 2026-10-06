"""Snapshots of a suite's tables at every migration version (D6, `suites/migrations.py`).

`test_suite_migrations.py` checks two things against them: the snapshot of the latest version
must match what `suites/tables.py` creates today, and every older snapshot, once migrated, must
match it too. So changing `suites/tables.py` makes a test fail until the change comes with a step
and a new snapshot. The snapshots only cover structure, so a step that changes data needs its own
test.

Each snapshot is the DDL that creates a fixed reference suite, as rendered from `suites/tables.py`
when that version was the latest. Never edit or regenerate an existing snapshot: it records the
tables that suites created at that version actually have, which is what later steps start from.
After adding a step, write the snapshot for the new version with

    uv run --frozen python tests/migration_snapshots.py

which refuses to overwrite an existing snapshot.
"""

from __future__ import annotations

import sys
from pathlib import Path

from sqlalchemy import Connection, create_mock_engine
from sqlalchemy.schema import CreateIndex, CreateSchema, CreateTable, ExecutableDDLElement

from lnt_v5.suites import migrations
from lnt_v5.suites import tables as suite_tables
from lnt_v5.suites.schema import SuiteSchema

SNAPSHOTS_DIR = Path(__file__).resolve().parent / "data" / "migration_snapshots"

# Uses every attribute type in each of the three lists, and the presentation keys, so that the
# snapshots cover everything the structure depends on. Never change it: the snapshots are rendered
# from it.
REFERENCE_SCHEMA = SNAPSHOTS_DIR / "reference.json"

# Between statements in a snapshot. None of the DDL contains it, so splitting on it is exact.
_SEPARATOR = ";\n\n"


def reference_schema() -> SuiteSchema:
    return SuiteSchema.model_validate_json(REFERENCE_SCHEMA.read_text())


def snapshot_path(version: int) -> Path:
    return SNAPSHOTS_DIR / f"{version}.sql"


def snapshot_versions() -> list[int]:
    """The versions that have a snapshot, in order."""
    return sorted(int(path.stem) for path in SNAPSHOTS_DIR.glob("*.sql"))


def render(schema: SuiteSchema) -> str:
    """The DDL `suites/tables.py` creates a suite with, as text that `replay` can execute.

    The statements `suite_tables.create` issues -- each table in dependency order, followed by its
    indexes -- except that a table's indexes come in name order: SQLAlchemy holds them in a set, so
    the order `create_all` issues them in changes from one run to the next. The metric rows
    `suite_tables.create` also inserts are data, not structure, and are left out.
    """
    dialect = create_mock_engine("postgresql+psycopg://", lambda *args, **kwargs: None).dialect

    def compiled(element: ExecutableDDLElement) -> str:
        text = str(element.compile(dialect=dialect)).strip()
        # SQLAlchemy ends most lines of a CREATE TABLE with a space, which editors strip.
        return "\n".join(line.rstrip() for line in text.splitlines())

    statements = [compiled(CreateSchema(schema.name))]
    for table in suite_tables.build(schema).metadata.sorted_tables:
        statements.append(compiled(CreateTable(table)))
        indexes = sorted(table.indexes, key=lambda index: str(index.name))
        statements.extend(compiled(CreateIndex(index)) for index in indexes)
    return _SEPARATOR.join(statements) + "\n"


def replay(connection: Connection, version: int) -> None:
    """Create the reference suite's tables as they were at `version`."""
    for statement in snapshot_path(version).read_text().split(_SEPARATOR):
        if statement.strip():
            connection.exec_driver_sql(statement)


def main() -> int:
    version = migrations.head()
    path = snapshot_path(version)
    if path.exists():
        print(
            f"{path.name} already exists. Snapshots are never rewritten: a change to "
            "suites/tables.py needs a new step in suites/migrations.py, and then a snapshot of "
            "its own.",
            file=sys.stderr,
        )
        return 1
    path.write_text(render(reference_schema()))
    print(f"Wrote {path}.")
    return 0


if __name__ == "__main__":
    sys.exit(main())

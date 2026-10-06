"""Snapshots of a suite's built-in structure at every version (D6, `suites/migrations.py`).

`test_suite_migrations.py` holds the code to them: the snapshot of the latest version must match
what `suites/tables.py` creates today, and every older one, migrated, must match it too. A change to
the built-in structure therefore fails a test until it comes with a step and a new snapshot.

Each snapshot is the DDL that creates one fixed reference suite, as this module renders it from
`suites/tables.py` at the time the version is current. Never edit or regenerate an existing one: it
records what suites created at that version actually have, which is what the steps after it must
start from. After adding a step, write the new version's snapshot with

    uv run --frozen python tests/suite_structure.py

which refuses to overwrite a snapshot that already exists.
"""

from __future__ import annotations

import sys
from pathlib import Path

from sqlalchemy import Connection, create_mock_engine
from sqlalchemy.schema import CreateIndex, CreateSchema, CreateTable, ExecutableDDLElement

from lnt_v5.suites import migrations
from lnt_v5.suites import tables as suite_tables
from lnt_v5.suites.schema import SuiteSchema

SNAPSHOTS_DIR = Path(__file__).resolve().parent / "data" / "suite_structure"

# Exercises every kind of entry the built-in structure depends on: every attribute type in each of
# the three lists, and the presentation keys. Frozen with the snapshots, which are rendered from it.
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
            f"{path.name} already exists. Snapshots are never rewritten: a change to the built-in "
            "structure needs a new step in suites/migrations.py, and then a snapshot of its own.",
            file=sys.stderr,
        )
        return 1
    path.write_text(render(reference_schema()))
    print(f"Wrote {path}.")
    return 0


if __name__ == "__main__":
    sys.exit(main())

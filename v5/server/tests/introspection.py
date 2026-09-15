"""Reading back what PostgreSQL actually stored, and what was sent to make it store it.

Shared by the global tables' tests and the per-suite ones, which owe the same check: that every name
the naming convention composes survives PostgreSQL's 63-byte identifier limit (D14). Plain helpers
rather than fixtures, so they live here instead of in `conftest.py`.
"""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from typing import Any

from sqlalchemy import (
    Engine,
    Inspector,
    MetaData,
    Select,
    Table,
    event,
    func,
    inspect,
    select,
    text,
)
from sqlalchemy.engine.interfaces import ReflectedColumn, ReflectedIndex

from lnt_v5.suites.tables import SuiteTables
from lnt_v5.tables import SCHEMA_VERSION_ID, schema_version


def composed_names(table: Table) -> set[str]:
    """Every constraint and index name the naming convention composed for a table.

    Indexes are gathered alongside constraints because `ix_...` is the longest template the
    convention has, and a plain index is not a constraint.
    """
    return {
        str(constraint.name) for constraint in table.constraints if constraint.name is not None
    } | {str(index.name) for index in table.indexes if index.name is not None}


def stored_names(inspector: Inspector, schema: str | None = None) -> dict[str, set[str]]:
    """Every constraint and index name PostgreSQL holds, per table, for one namespace.

    The `get_multi_*` reflection calls rather than their singular forms: each is one query covering
    the whole namespace, where the singular ones are one query per table per kind. Checking the
    eight per-suite tables costs five queries this way rather than forty.
    """
    names: dict[str, set[str]] = {}

    def record(table: str, name: object) -> None:
        if name is not None:
            names.setdefault(table, set()).add(str(name))

    for group in (
        inspector.get_multi_indexes(schema=schema),
        inspector.get_multi_unique_constraints(schema=schema),
        inspector.get_multi_foreign_keys(schema=schema),
        inspector.get_multi_check_constraints(schema=schema),
    ):
        for (_, table), entries in group.items():
            names.setdefault(table, set())
            for entry in entries:
                record(table, entry.get("name"))
    for (_, table), primary_key in inspector.get_multi_pk_constraint(schema=schema).items():
        names.setdefault(table, set())
        record(table, primary_key.get("name"))
    return names


def assert_names_survived(inspector: Inspector, metadata: MetaData, schema: str | None) -> None:
    """No composed name was long enough to be truncated on the way into the database (D14).

    PostgreSQL truncates an identifier over 63 bytes with a warning rather than an error, so a name
    that overflows is not the name a violation is reported under: attribution (D13) would still find
    a constraint, still read a name, and silently never match. Comparing every name against what
    PostgreSQL stored is what rules that out -- and it is the reason the names written out elsewhere
    in the codebase are safe to write out.
    """
    stored = stored_names(inspector, schema=schema)
    for table in metadata.sorted_tables:
        composed = composed_names(table)
        held = stored.get(table.name, set())
        assert composed <= held, f"{table.name}: {sorted(composed - held)} did not survive"


def sql_type_of(engine: Engine, schema: str, table: str, column: str) -> str:
    """The column type PostgreSQL reports, spelled the way D3's table spells it.

    Read from `information_schema` rather than from SQLAlchemy's reflection, which renders a
    `timestamptz` as `TIMESTAMP` with a separate `timezone` flag and so cannot be compared against
    D3 directly.
    """
    with engine.connect() as connection:
        return str(
            connection.execute(
                text(
                    "SELECT data_type FROM information_schema.columns "
                    "WHERE table_schema = :schema AND table_name = :table "
                    "AND column_name = :column"
                ),
                {"schema": schema, "table": table, "column": column},
            ).scalar_one()
        ).upper()


def columns_of(inspector: Inspector, suite: str, table: str) -> dict[str, ReflectedColumn]:
    """Every column PostgreSQL holds for a table, by name."""
    return {column["name"]: column for column in inspector.get_columns(table, schema=suite)}


def column_names(engine: Engine, suite: str, table: str) -> list[str]:
    """The names alone, in the order PostgreSQL reports them -- the order they were added."""
    return list(columns_of(inspect(engine), suite, table))


def indexes_of(inspector: Inspector, suite: str, table: str) -> dict[str, ReflectedIndex]:
    return {str(index["name"]): index for index in inspector.get_indexes(table, schema=suite)}


def schema_version_of(engine: Engine) -> int:
    """D2's counter, read at the fixed id `tables.py` gives it, not from whatever row is there."""
    with engine.connect() as connection:
        return int(
            connection.execute(
                select(schema_version.c.version).where(schema_version.c.id == SCHEMA_VERSION_ID)
            ).scalar_one()
        )


def row_count(engine: Engine, statement: Select[Any]) -> int:
    """How many rows a statement matches, on a connection of its own.

    What the cascade tests assert on: each deletes through the API, then counts what survived in
    a table the API does not expose. Shared so that "count on a fresh connection" is not spelled
    three different ways.
    """
    with engine.connect() as connection:
        return len(connection.execute(statement).all())


def counted(engine: Engine, tables: SuiteTables, name: str) -> int:
    """Every row in one of a suite's tables, named the way `SuiteTables` names it.

    The common case of `row_count` above, and by far the most asked for: a test that submitted a
    run and wants to know how many machines, tests or samples it produced. Named by attribute
    rather than by column so the caller writes what it means, and shared for the same reason
    `row_count` is.
    """
    table: Table = getattr(tables, name)
    with engine.connect() as connection:
        return int(connection.execute(select(func.count()).select_from(table)).scalar_one())


@contextmanager
def counting_statements(mentioning: str) -> Iterator[list[str]]:
    """Every statement naming `mentioning` that was sent to PostgreSQL while the block ran.

    What pins D13's cost guarantees, which no assertion about the rows that ended up stored can
    see: resolving test names one at a time, or a sample insert issued per row, produces exactly
    the same database contents as the statements the design requires and would pass every other
    test. Counting is the only way to tell them apart, so the requirement is asserted by counting.

    Listens on the `Engine` *class* rather than on an engine, because the interesting caller is the
    application, whose engine a test driving it over HTTP never holds. `mentioning` is what keeps
    that from being noisy: it selects the statements the test is about, so pool bookkeeping and
    whatever the fixtures happen to do cannot change the count.
    """
    seen: list[str] = []

    def record(
        connection: Any,
        cursor: Any,
        statement: str,
        parameters: Any,
        context: Any,
        executemany: bool,
    ) -> None:
        if mentioning in statement:
            seen.append(statement)

    event.listen(Engine, "before_cursor_execute", record)
    try:
        yield seen
    finally:
        event.remove(Engine, "before_cursor_execute", record)

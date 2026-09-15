"""Reading back what PostgreSQL actually stored.

Shared by the global tables' tests and the per-suite ones, which owe the same check: that every name
the naming convention composes survives PostgreSQL's 63-byte identifier limit (D14). Plain helpers
rather than fixtures, so they live here instead of in `conftest.py`.
"""

from __future__ import annotations

from sqlalchemy import Engine, Inspector, MetaData, Table, text


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

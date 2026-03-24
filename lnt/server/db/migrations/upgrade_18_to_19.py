"""Add an ordinal column to each test suite's Order table and drop the
PreviousOrder and NextOrder linked-list columns.

The ordinal column stores the position of each order in the total ordering,
determined by sorting order field values via convert_revision().
"""

import sqlalchemy
from sqlalchemy import Column, Integer, text

from lnt.server.db.migrations.util import introspect_table
from lnt.server.db.util import add_column
from lnt.server.ui.util import convert_revision


def _drop_columns_sqlite(engine, table_name, columns_to_drop):
    """Drop columns from a SQLite table by recreating it.

    SQLite's ALTER TABLE DROP COLUMN doesn't work when foreign key
    constraints reference the dropped column.
    """
    with engine.begin() as conn:
        # Get the current CREATE TABLE statement.
        result = conn.execute(text(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name=:name"
        ), name=table_name)
        create_sql = result.scalar()

        # Get the current column names.
        result = conn.execute(text(
            f'PRAGMA table_info("{table_name}")'
        ))
        all_columns = [row[1] for row in result]
        keep_columns = [c for c in all_columns if c not in columns_to_drop]
        quoted_keep = ', '.join(f'"{c}"' for c in keep_columns)

        # Disable foreign key checks during rebuild.
        conn.execute(text("PRAGMA foreign_keys=OFF"))

        # Rename the old table.
        tmp_name = f"{table_name}__old"
        conn.execute(text(
            f'ALTER TABLE "{table_name}" RENAME TO "{tmp_name}"'
        ))

        # Build a new CREATE TABLE statement without the dropped columns
        # and without foreign key constraints referencing them.
        # Parse column definitions and constraints from the original SQL.
        # Find the content between the outer parentheses.
        paren_start = create_sql.index('(')
        inner = create_sql[paren_start + 1:]
        # Remove trailing ")".
        inner = inner.rstrip()
        if inner.endswith(')'):
            inner = inner[:-1]

        # Split on commas, respecting parentheses.
        parts = []
        depth = 0
        current = []
        for ch in inner:
            if ch == '(':
                depth += 1
            elif ch == ')':
                depth -= 1
            elif ch == ',' and depth == 0:
                parts.append(''.join(current).strip())
                current = []
                continue
            current.append(ch)
        if current:
            parts.append(''.join(current).strip())

        # Filter out column definitions and constraints for dropped columns.
        new_parts = []
        for part in parts:
            # Skip column definitions for dropped columns.
            skip = False
            for col in columns_to_drop:
                if part.strip().startswith(f'"{col}"'):
                    skip = True
                    break
            if skip:
                continue
            # Skip FOREIGN KEY constraints that reference dropped columns.
            part_upper = part.upper()
            if 'FOREIGN KEY' in part_upper:
                references_dropped = False
                for col in columns_to_drop:
                    if f'"{col}"' in part or col in part:
                        references_dropped = True
                        break
                if references_dropped:
                    continue
            new_parts.append(part)

        new_create = 'CREATE TABLE "{}" (\n{}\n)'.format(
            table_name, ',\n'.join('\t' + p for p in new_parts)
        )
        conn.execute(text(new_create))

        # Copy data.
        conn.execute(text(
            f'INSERT INTO "{table_name}" ({quoted_keep}) SELECT {quoted_keep} FROM "{tmp_name}"'
        ))

        # Drop the old table.
        conn.execute(text(f'DROP TABLE "{tmp_name}"'))

        # Re-enable foreign keys.
        conn.execute(text("PRAGMA foreign_keys=ON"))


def _drop_columns_postgres(engine, table_name, columns_to_drop):
    """Drop columns from a PostgreSQL table using ALTER TABLE."""
    with engine.begin() as conn:
        for col in columns_to_drop:
            conn.execute(text(
                f'ALTER TABLE "{table_name}" DROP COLUMN "{col}"'
            ))


def upgrade(engine):
    is_sqlite = engine.dialect.name == 'sqlite'

    # Find all test suites so we can migrate each Order table.
    test_suite_table = introspect_table(engine, "TestSuite")
    order_fields_table = introspect_table(engine, "TestSuiteOrderFields")

    session = sqlalchemy.orm.sessionmaker(engine)()

    test_suites = session.execute(
        sqlalchemy.select([test_suite_table.c.DBKeyName])
    ).fetchall()

    for (db_key_name,) in test_suites:
        order_table_name = f'{db_key_name}_Order'

        # 1. Add ordinal column.
        ordinal_col = Column("ordinal", Integer)
        add_column(engine, order_table_name, ordinal_col)

        # 2. Load all orders with their order field values, sort them,
        #    and assign ordinals.
        order_table = introspect_table(engine, order_table_name)

        # Find the order field names for this test suite, sorted by their
        # ordinal (the field ordinal, not our new column).
        ts_id_query = sqlalchemy.select(
            [test_suite_table.c.ID]
        ).where(test_suite_table.c.DBKeyName == db_key_name)
        ts_id = session.execute(ts_id_query).scalar()

        field_rows = session.execute(
            sqlalchemy.select([order_fields_table.c.Name])
            .where(order_fields_table.c.TestSuiteID == ts_id)
            .order_by(order_fields_table.c.Ordinal)
        ).fetchall()
        field_names = [row[0] for row in field_rows]

        # Load all orders.
        orders = session.execute(
            sqlalchemy.select([order_table])
        ).fetchall()

        # Build a sort key for each order using convert_revision on each
        # order field.
        cache = {}

        def sort_key(row):
            return tuple(
                convert_revision(
                    getattr(row, fname) or '', cache=cache
                )
                for fname in field_names
            )

        sorted_orders = sorted(orders, key=sort_key)

        # Assign ordinals.
        for i, row in enumerate(sorted_orders):
            session.execute(
                order_table.update()
                .where(order_table.c.ID == row.ID)
                .values(ordinal=i)
            )

        session.commit()

        # 3. Drop PreviousOrder and NextOrder columns.
        if is_sqlite:
            _drop_columns_sqlite(
                engine, order_table_name,
                ["NextOrder", "PreviousOrder"])
        else:
            _drop_columns_postgres(
                engine, order_table_name,
                ["NextOrder", "PreviousOrder"])

        # 4. Create an index on the ordinal column (after column drop,
        #    since SQLite table rebuild would lose it).
        # Re-introspect to get the current table state.
        new_order_table = introspect_table(engine, order_table_name)
        idx_name = f"ix_{db_key_name}_Order_ordinal"
        idx = sqlalchemy.Index(idx_name, new_order_table.c.ordinal)
        idx.create(engine)

    session.close()

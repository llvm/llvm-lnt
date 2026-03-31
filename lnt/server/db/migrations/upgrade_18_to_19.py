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


def _rebuild_order_table_sqlite(engine, table_name):
    """Rebuild a SQLite Order table to drop the NextOrder and PreviousOrder
    columns and make the ordinal column NOT NULL.

    SQLite has limited ALTER TABLE support, so we rebuild the table:
    create new -> copy data -> drop old -> rename new.
    """
    with engine.begin() as conn:
        # Disable FK checks: other tables reference Order.ID.
        conn.execute(text("PRAGMA foreign_keys=OFF"))

        # Discover current columns.
        rows = conn.execute(text(
            f'PRAGMA table_info("{table_name}")'
        )).fetchall()
        # Each row: (cid, name, type, notnull, dflt_value, pk)
        columns_to_drop = {'NextOrder', 'PreviousOrder'}
        keep_cols = []
        col_defs = []
        for row in rows:
            cid, name, col_type, notnull, dflt, pk = row
            if name in columns_to_drop:
                continue
            keep_cols.append(name)
            if name == 'ordinal':
                notnull = 1  # Make ordinal NOT NULL
            nn = ' NOT NULL' if notnull else ''
            pk_str = ' PRIMARY KEY' if pk else ''
            col_defs.append(f'"{name}" {col_type}{nn}{pk_str}')

        # Preserve foreign key constraints from the original CREATE TABLE.
        # Read the original DDL and extract FOREIGN KEY clauses.
        result = conn.execute(text(
            "SELECT sql FROM sqlite_master "
            "WHERE type='table' AND name=:name"
        ), name=table_name)
        original_ddl = result.scalar()
        fk_clauses = _extract_fk_clauses(original_ddl, columns_to_drop)

        all_parts = col_defs + fk_clauses
        tmp_name = f'{table_name}__new'
        create_sql = 'CREATE TABLE "{}" (\n{}\n)'.format(
            tmp_name, ',\n'.join('  ' + p for p in all_parts)
        )
        conn.execute(text(create_sql))

        # Copy data.
        quoted = ', '.join(f'"{c}"' for c in keep_cols)
        conn.execute(text(
            f'INSERT INTO "{tmp_name}" ({quoted}) '
            f'SELECT {quoted} FROM "{table_name}"'
        ))

        # Drop old table and rename new table to original name.
        conn.execute(text(f'DROP TABLE "{table_name}"'))
        conn.execute(text(
            f'ALTER TABLE "{tmp_name}" RENAME TO "{table_name}"'
        ))

        # Re-enable FK checks.
        conn.execute(text("PRAGMA foreign_keys=ON"))


def _extract_fk_clauses(create_sql, columns_to_drop):
    """Extract FOREIGN KEY clauses from a CREATE TABLE statement,
    excluding any that reference columns in columns_to_drop."""
    # Find content between outermost parentheses.
    paren_start = create_sql.index('(')
    inner = create_sql[paren_start + 1:].rstrip().rstrip(')')

    # Split on commas respecting nested parentheses.
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

    # Keep only FOREIGN KEY constraints that don't reference dropped columns.
    fk_clauses = []
    for part in parts:
        if 'FOREIGN KEY' not in part.upper():
            continue
        references_dropped = any(
            f'"{col}"' in part or col in part
            for col in columns_to_drop
        )
        if not references_dropped:
            fk_clauses.append(part)
    return fk_clauses


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

        # 1. Add ordinal column (nullable initially so we can backfill).
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

        # 3. Drop PreviousOrder and NextOrder columns, set ordinal NOT NULL,
        #    and (on Postgres) add a deferred unique constraint.
        if is_sqlite:
            _rebuild_order_table_sqlite(engine, order_table_name)
        else:
            with engine.begin() as conn:
                for col in ["NextOrder", "PreviousOrder"]:
                    conn.execute(text(
                        f'ALTER TABLE "{order_table_name}" '
                        f'DROP COLUMN "{col}"'
                    ))
                conn.execute(text(
                    f'ALTER TABLE "{order_table_name}" '
                    f'ALTER COLUMN "ordinal" SET NOT NULL'
                ))
                conn.execute(text(
                    f'ALTER TABLE "{order_table_name}" '
                    f'ADD CONSTRAINT "{order_table_name}_ordinal_unique" '
                    f'UNIQUE ("ordinal") DEFERRABLE INITIALLY DEFERRED'
                ))

        # 4. Create an index on the ordinal column for query performance.
        new_order_table = introspect_table(engine, order_table_name)
        idx_name = f"ix_{db_key_name}_Order_ordinal"
        idx = sqlalchemy.Index(idx_name, new_order_table.c.ordinal)
        idx.create(engine)

    session.close()

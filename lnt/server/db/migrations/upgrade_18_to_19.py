"""Add an ordinal column to each test suite's Order table.

On Postgres, also drops the PreviousOrder and NextOrder linked-list columns.
On SQLite, those columns are left in place because SQLite cannot drop columns
that are referenced by foreign key constraints.

The ordinal column stores the position of each order in the total ordering,
determined by sorting order field values via convert_revision().
"""

import sqlalchemy
from sqlalchemy import Column, Integer, text

from lnt.server.db.migrations.util import introspect_table
from lnt.server.db.util import add_column
from lnt.server.ui.util import convert_revision


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

        # 3. On Postgres: drop PreviousOrder and NextOrder columns, set ordinal
        #    NOT NULL, and add a deferred unique constraint.
        #    On SQLite: skip all of this. SQLite cannot drop columns that are
        #    referenced by foreign key constraints, and doesn't support ALTER
        #    COLUMN SET NOT NULL or DEFERRABLE constraints. The orphaned columns
        #    are harmless (SQLAlchemy ignores unmapped columns), and application
        #    logic enforces ordinal uniqueness.
        if not is_sqlite:
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

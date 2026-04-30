"""Add Tag column to per-testsuite Order tables.

Adds a nullable Tag VARCHAR(64) column with an index to each
{testsuite}_Order table, allowing users to label specific orders
(e.g. "release-18.1") for filtering and comparison.
"""

import sqlalchemy
from sqlalchemy import Column, String, Index, select
from lnt.server.db.migrations.util import introspect_table
from lnt.server.db.util import add_column
from lnt.util import logger


def upgrade(engine):
    # Discover test suites dynamically
    try:
        test_suite = introspect_table(engine, 'TestSuite')
        with engine.begin() as conn:
            suites = list(conn.execute(select([test_suite])))
    except sqlalchemy.exc.NoSuchTableError:
        suites = []

    for suite in suites:
        ts_name = suite[2]  # DBKeyName
        table_name = "{}_Order".format(ts_name)
        logger.info("Adding Tag column to %s", table_name)

        # Add the column
        tag_col = Column("Tag", String(64))
        try:
            add_column(engine, table_name, tag_col)
        except (sqlalchemy.exc.OperationalError,
                sqlalchemy.exc.ProgrammingError,
                sqlalchemy.exc.IntegrityError) as e:
            logger.warning("Skipping Tag column on %s "
                           "(may already exist): %s", table_name, e)

        # Create index
        index_name = "ix_{}_tag".format(table_name.lower())
        try:
            table = introspect_table(engine, table_name)
            idx = Index(index_name, table.c.Tag)
            idx.create(engine)
        except (sqlalchemy.exc.OperationalError,
                sqlalchemy.exc.ProgrammingError,
                sqlalchemy.exc.IntegrityError) as e:
            logger.warning("Skipping Tag index on %s "
                           "(may already exist): %s", table_name, e)

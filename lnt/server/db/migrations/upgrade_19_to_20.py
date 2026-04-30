"""Create TestSuiteRegistryVersion table.

Single-row table with an integer version counter. Incremented whenever a
test suite is created or deleted so that other workers can detect the change
and reload their in-memory suite caches.
"""

import sqlalchemy
from sqlalchemy import text
from lnt.util import logger


def upgrade(engine):
    dialect = engine.dialect.name

    if dialect == 'postgresql':
        create_sql = text("""
            CREATE TABLE IF NOT EXISTS "TestSuiteRegistryVersion" (
                "ID" SERIAL PRIMARY KEY,
                "Version" INTEGER NOT NULL DEFAULT 0
            )
        """)
    else:
        create_sql = text("""
            CREATE TABLE IF NOT EXISTS "TestSuiteRegistryVersion" (
                "ID" INTEGER PRIMARY KEY,
                "Version" INTEGER NOT NULL DEFAULT 0
            )
        """)

    with engine.begin() as conn:
        try:
            conn.execute(create_sql)
        except (sqlalchemy.exc.OperationalError,
                sqlalchemy.exc.ProgrammingError,
                sqlalchemy.exc.IntegrityError) as e:
            logger.warning("Skipping TestSuiteRegistryVersion table creation "
                           "(may already exist): %s", e)
            return

    # Insert the initial row
    with engine.begin() as conn:
        count = conn.execute(
            text('SELECT COUNT(*) FROM "TestSuiteRegistryVersion"')
        ).scalar()
        if count == 0:
            conn.execute(
                text('INSERT INTO "TestSuiteRegistryVersion" ("Version") '
                     'VALUES (0)')
            )

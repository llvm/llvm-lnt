"""This migration adds:

A) UUID columns (String(36)) to per-testsuite Run, FieldChange, and
   Regression tables.  Existing rows are backfilled with uuid4 values
   in batches.  A unique index is created after the backfill.

B) A global APIKey table for v5 API authentication.
"""

import uuid

import sqlalchemy
from sqlalchemy import Column, String, Index, select, text
from lnt.server.db.migrations.util import introspect_table
from lnt.server.db.util import add_column
from lnt.util import logger

BACKFILL_BATCH_SIZE = 1000


def _add_uuid_column(engine, table_name):
    """Add a nullable UUID column to the given table."""
    uuid_col = Column("UUID", String(36))
    try:
        add_column(engine, table_name, uuid_col)
    except (sqlalchemy.exc.OperationalError,
            sqlalchemy.exc.ProgrammingError,
            sqlalchemy.exc.IntegrityError) as e:
        logger.warning("Skipping UUID column on %s (may already exist): %s",
                       table_name, e)


def _backfill_uuids(engine, table_name):
    """Backfill UUID values in batches."""
    table = introspect_table(engine, table_name)
    # Find rows without a UUID
    with engine.begin() as conn:
        count_q = select([sqlalchemy.func.count()]).select_from(table).where(
            table.c.UUID.is_(None)
        )
        total = conn.execute(count_q).scalar()

    if total == 0:
        return

    logger.info("Backfilling %d UUIDs on %s ...", total, table_name)
    filled = 0
    while filled < total:
        with engine.begin() as conn:
            rows = conn.execute(
                select([table.c.ID]).where(
                    table.c.UUID.is_(None)
                ).limit(BACKFILL_BATCH_SIZE)
            ).fetchall()
            if not rows:
                break
            for row in rows:
                conn.execute(
                    table.update().where(
                        table.c.ID == row[0]
                    ).values(UUID=str(uuid.uuid4()))
                )
            filled += len(rows)
    logger.info("Backfilled %d UUIDs on %s", filled, table_name)


def _create_uuid_index(engine, table_name, ts_name):
    """Create a unique index on the UUID column."""
    index_name = "ix_{}_uuid".format(table_name.lower())
    table = introspect_table(engine, table_name)
    idx = Index(index_name, table.c.UUID, unique=True)
    try:
        idx.create(engine)
    except (sqlalchemy.exc.OperationalError,
            sqlalchemy.exc.ProgrammingError,
            sqlalchemy.exc.IntegrityError) as e:
        logger.warning("Skipping UUID index on %s (may already exist): %s",
                       table_name, e)


def _add_uuid_to_table(engine, table_name, ts_name):
    """Add UUID column, backfill, and create unique index."""
    _add_uuid_column(engine, table_name)
    _backfill_uuids(engine, table_name)
    _create_uuid_index(engine, table_name, ts_name)


def _create_apikey_table(engine):
    """Create the global APIKey table for v5 API authentication."""
    # Detect dialect for Postgres vs SQLite differences
    dialect = engine.dialect.name

    if dialect == 'postgresql':
        create_sql = text("""
            CREATE TABLE IF NOT EXISTS "APIKey" (
                "ID" SERIAL PRIMARY KEY,
                "Name" VARCHAR(256) NOT NULL,
                "KeyPrefix" VARCHAR(8) NOT NULL,
                "KeyHash" VARCHAR(64) NOT NULL,
                "Scope" VARCHAR(32) NOT NULL,
                "CreatedAt" TIMESTAMP NOT NULL,
                "LastUsedAt" TIMESTAMP,
                "IsActive" BOOLEAN NOT NULL DEFAULT TRUE
            )
        """)
    else:
        create_sql = text("""
            CREATE TABLE IF NOT EXISTS "APIKey" (
                "ID" INTEGER PRIMARY KEY,
                "Name" VARCHAR(256) NOT NULL,
                "KeyPrefix" VARCHAR(8) NOT NULL,
                "KeyHash" VARCHAR(64) NOT NULL,
                "Scope" VARCHAR(32) NOT NULL,
                "CreatedAt" TIMESTAMP NOT NULL,
                "LastUsedAt" TIMESTAMP,
                "IsActive" BOOLEAN NOT NULL DEFAULT 1
            )
        """)

    with engine.begin() as conn:
        try:
            conn.execute(create_sql)
        except (sqlalchemy.exc.OperationalError,
                sqlalchemy.exc.ProgrammingError,
                sqlalchemy.exc.IntegrityError) as e:
            logger.warning("Skipping APIKey table creation "
                           "(may already exist): %s", e)
            return  # Don't try to create index if table creation failed

    # Create unique index on KeyHash
    try:
        apikey_table = introspect_table(engine, "APIKey")
        idx = Index("ix_apikey_keyhash", apikey_table.c.KeyHash, unique=True)
        idx.create(engine)
    except (sqlalchemy.exc.OperationalError,
            sqlalchemy.exc.ProgrammingError,
            sqlalchemy.exc.IntegrityError) as e:
        logger.warning("Skipping APIKey KeyHash index "
                       "(may already exist): %s", e)


def upgrade(engine):
    """Add UUID columns to per-testsuite tables and create APIKey table."""

    # Discover test suites dynamically
    try:
        test_suite = introspect_table(engine, 'TestSuite')
        with engine.begin() as conn:
            suites = list(conn.execute(select([test_suite])))
    except sqlalchemy.exc.NoSuchTableError:
        # TestSuite table may not exist on a brand-new database
        suites = []

    for suite in suites:
        # suite columns: ID, Name, DBKeyName, ...
        ts_name = suite[2]  # DBKeyName
        logger.info("Adding UUID columns for test suite: %s", ts_name)

        run_table = "{}_Run".format(ts_name)
        fc_table = "{}_FieldChangeV2".format(ts_name)
        reg_table = "{}_Regression".format(ts_name)

        _add_uuid_to_table(engine, run_table, ts_name)
        _add_uuid_to_table(engine, fc_table, ts_name)
        _add_uuid_to_table(engine, reg_table, ts_name)

    # Create the global APIKey table
    _create_apikey_table(engine)

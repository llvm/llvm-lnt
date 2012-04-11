"""
Define facilities for automatically upgrading databases.
"""

# NOTE: This code is written slightly to be more generic than we currently
# use. In particular, we maintain multiple migration lists based on a 'schema
# version'. This was done in case we need to add some kind of migration
# functionality for the individual test suites, which is not unreasonable.

import logging
import os
import re

import sqlalchemy.ext.declarative
import sqlalchemy.orm
from sqlalchemy import Column, String, Integer

###
# Schema for in-database version information.

Base = sqlalchemy.ext.declarative.declarative_base()

class SchemaVersion(Base):
    __tablename__ = 'SchemaVersion'

    name = Column("Name", String(256), primary_key=True, unique=True)
    version = Column("Version", Integer)

    def __init__(self, name, version):
        self.name = name
        self.version = version

    def __repr__(self):
        return '%s%r' % (self.__class__.__name__, (self.name, self.version))

###
# Migrations auto-discovery.

def _load_migrations():
    """
    Load available migration scripts from a directory.

    Migrations are organized as:

    <current dir>/migrations/
    <current dir>/migrations/upgrade_<N>_to_<N+1>.py
    ...
    """

    upgrade_script_rex = re.compile(
        r'^upgrade_(0|[1-9][0-9]*)_to_([1-9][0-9]*)\.py$')
    migrations = {}

    # Currently, we only load migrations for a '__core__' schema, and only from
    # the migrations directory. One idea if we need to eventually support
    # migrations for the per-testsuite tables is to add subdirectories keyed on
    # the testsuite.
    for schema_name in ('__core__',):
        schema_migrations_path = os.path.join(os.path.dirname(__file__),
                                              'migrations')
        schema_migrations = {}
        for item in os.listdir(schema_migrations_path):
            # Ignore non-matching files.
            m = upgrade_script_rex.match(item)
            if m is None:
                logger.warning(
                    "ignoring item %r in schema migration directory: %r",
                    item, schema_migrations_path)
                continue

            # Check the version numbers for validity.
            version,next_version = map(int, m.groups())
            if next_version != version + 1:
                logger.error(
                    "invalid script name %r in schema migration directory: %r",
                    item, schema_migrations_path)
                continue

            schema_migrations[version] = os.path.join(
                schema_migrations_path, item)

        # Ignore directories with no migrations.
        if not schema_migrations:
            logger.warning("ignoring empty migrations directory: %r",
                           schema_migrations_path)
            continue

        # Check the provided versions for sanity.
        current_version = max(schema_migrations) + 1
        for i in range(current_version):
            if i not in schema_migrations:
                logger.error("schema %r is missing migration for version: %r",
                             schema_name, i)

        # Store the current version as another item in the per-schema migration
        # dictionary.
        schema_migrations['current_version'] = current_version

        # Store the schema migrations.
        migrations[schema_name] = schema_migrations

    return migrations

###
# Auto-upgrading support.

logger = logging.getLogger(__name__)

def update_schema(session, versions, available_migrations, schema_name):
    schema_migrations = available_migrations[schema_name]

    # Get the current schema version.
    db_version = versions.get(schema_name, None)
    current_version = schema_migrations['current_version']

    # If there was no previous version, initialize the version.
    if db_version is None:
        logger.info("assigning initial version for schema %r",
                    schema_name)
        db_version = SchemaVersion(schema_name, 0)
        session.add(db_version)
        session.commit()

    # If we are up-to-date, do nothing.
    if db_version.version == current_version:
        return False

    # Otherwise, update the database.
    if db_version.version > current_version:
        logger.error("invalid schema %r version %r (greater than current)",
                     schema_name, db_version)
        return False

    logger.info("updating schema %r from version %r to current version %r",
                schema_name, db_version.version, current_version)
    while db_version.version < current_version:
        # Lookup the upgrade function for this version.
        upgrade_script = schema_migrations[db_version.version]

        globals = {}
        execfile(upgrade_script, globals)
        upgrade_method = globals['upgrade']

        # Execute the upgrade.
        #
        # FIXME: Backup the database here.
        #
        # FIXME: Execute this inside a transaction?
        logger.info("applying upgrade for version %d to %d" % (
                db_version.version, db_version.version+1))
        upgrade_method(session)

        # Update the schema version.
        db_version.version += 1
        session.add(db_version)

        # Commit the result.
        session.commit()

    return True

def update(engine):
    any_changed = False

    logger.debug("checking database versions...")

    # Load the available migrations.
    available_migrations = _load_migrations()

    # Create a session for the update.
    session = sqlalchemy.orm.sessionmaker(engine)()

    # Load all the information from the versions tables. We just do the query
    # and handle the exception if the table hasn't been defined yet (for
    # databases before versioning started).
    try:
        version_list = session.query(SchemaVersion).all()
    except sqlalchemy.exc.OperationalError,e:
        # Filter on the DB-API error message. This is a bit flimsy, but works
        # for SQLite at least.
        if 'no such table' not in e.orig.message:
            raise

        # Create the SchemaVersion table.
        Base.metadata.create_all(engine)
        session.commit()

        version_list = []
    versions = dict((v.name, v)
                    for v in version_list)

    # Update the core schema.
    any_changed |= update_schema(session, versions, available_migrations,
                                 '__core__')

    if any_changed:
        logger.info("database auto-upgraded")

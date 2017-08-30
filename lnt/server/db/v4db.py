from lnt.testing.util.commands import fatal
import glob
import yaml
import sys

try:
    import threading
except:
    import dummy_threading as threading

import sqlalchemy

import lnt.testing

import lnt.server.db.testsuitedb
import lnt.server.db.migrate

from lnt.util import logger
from lnt.server.db import testsuite
import lnt.server.db.util


class V4DB(object):
    """
    Wrapper object for LNT v0.4+ databases.
    """

    _db_updated = set()
    _engine_lock = threading.Lock()
    _engine = {}

    def _load_schema_file(self, session, schema_file):
        with open(schema_file) as schema_fd:
            data = yaml.load(schema_fd)
        suite = testsuite.TestSuite.from_json(data)
        testsuite.check_testsuite_schema_changes(session, suite)
        suite = testsuite.sync_testsuite_with_metatables(session, suite)
        session.commit()

        name = suite.name
        ts = lnt.server.db.testsuitedb.TestSuiteDB(self, name, suite,
                                                   create_tables=True)
        if name in self.testsuite:
            logger.error("Duplicate test-suite '%s' (while loading %s)" %
                         (name, schema_file))
        self.testsuite[name] = ts

    def _load_schemas(self, session):
        # Load schema files (preferred)
        schemasDir = self.config.schemasDir
        for schema_file in glob.glob('%s/*.yaml' % schemasDir):
            try:
                self._load_schema_file(session, schema_file)
            except Exception as e:
                fatal("Could not load schema '%s': %s\n" % (schema_file, e))

        # Load schemas from database (deprecated)
        ts_list = session.query(testsuite.TestSuite).all()
        for suite in ts_list:
            name = suite.name
            if name in self.testsuite:
                continue
            ts = lnt.server.db.testsuitedb.TestSuiteDB(self, name, suite,
                                                       create_tables=False)
            self.testsuite[name] = ts

    def __init__(self, path, config, baseline_revision=0):
        # If the path includes no database type, assume sqlite.
        if lnt.server.db.util.path_has_no_database_type(path):
            path = 'sqlite:///' + path

        self.path = path
        self.config = config
        self.baseline_revision = baseline_revision
        with V4DB._engine_lock:
            if path not in V4DB._engine:
                connect_args = {}
                if path.startswith("sqlite://"):
                    # Some of the background tasks keep database transactions
                    # open for a long time. Make it less likely to hit
                    # "(OperationalError) database is locked" because of that.
                    connect_args['timeout'] = 30
                engine = sqlalchemy.create_engine(path,
                                                  connect_args=connect_args)
                V4DB._engine[path] = engine
        self.engine = V4DB._engine[path]

        # Update the database to the current version, if necessary. Only check
        # this once per path.
        if path not in V4DB._db_updated:
            lnt.server.db.migrate.update(self.engine)
            V4DB._db_updated.add(path)

        self.session = sqlalchemy.orm.sessionmaker(self.engine)()

        # Add several shortcut aliases.
        self.add = self.session.add
        self.delete = self.session.delete
        self.commit = self.session.commit
        self.query = self.session.query
        self.rollback = self.session.rollback

        # For parity with the usage of TestSuiteDB, we make our primary model
        # classes available as instance variables.
        self.SampleType = testsuite.SampleType
        self.StatusKind = testsuite.StatusKind
        self.TestSuite = testsuite.TestSuite
        self.SampleField = testsuite.SampleField

        self.testsuite = dict()
        self._load_schemas(self.session)

    def close(self):
        if self.session is not None:
            self.session.close()

    @staticmethod
    def close_engine(db_path):
        """Rip down everything about this path, so we can make it
        new again. This is used for tests that need to make a fresh
        in memory database."""
        V4DB._engine[db_path].dispose()
        V4DB._engine.pop(db_path)
        V4DB._db_updated.remove(db_path)

    @staticmethod
    def close_all_engines():
        for key in V4DB._engine.keys():
            V4DB.close_engine(key)

    def settings(self):
        """All the setting needed to recreate this instnace elsewhere."""
        return {
            'path': self.path,
            'config': self.config,
            'baseline_revision': self.baseline_revision,
        }

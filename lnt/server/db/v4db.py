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
from sqlalchemy.orm import joinedload, subqueryload
import lnt.server.db.util


class V4DB(object):
    """
    Wrapper object for LNT v0.4+ databases.
    """
    _engine_lock = threading.Lock()
    _engines = []
    def _load_schema_file(self, session, schema_file):
        with open(schema_file) as schema_fd:
            data = yaml.load(schema_fd)
        suite = testsuite.TestSuite.from_json(data)
        testsuite.check_testsuite_schema_changes(session, suite)
        suite = testsuite.sync_testsuite_with_metatables(session, suite)
        session.commit()

        # Create tables if necessary
        lnt.server.db.testsuitedb.TestSuiteDB(self, suite.name, suite,
                                              create_tables=True)

    def _load_schemas(self, session):
        # Load schema files (preferred)
        schemasDir = self.config.schemasDir
        for schema_file in glob.glob('%s/*.yaml' % schemasDir):
            try:
                self._load_schema_file(session, schema_file)
            except Exception as e:
                fatal("Could not load schema '%s': %s\n" % (schema_file, e))

        # Load schemas from database.
        ts_list = session.query(testsuite.TestSuite).all()
        for suite in ts_list:
            name = suite.name
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
        connect_args = {}
        if path.startswith("sqlite://"):
            # Some of the background tasks keep database transactions
            # open for a long time. Make it less likely to hit
            # "(OperationalError) database is locked" because of that.
            connect_args['timeout'] = 30
        self.engine = sqlalchemy.create_engine(path,
                                               connect_args=connect_args)
        with V4DB._engine_lock:
            V4DB._engines.append(self.engine)

        # Update the database to the current version, if necessary. Only check
        # this once per path.
        lnt.server.db.migrate.update(self.engine)

        self.sessionmaker = sqlalchemy.orm.sessionmaker(self.engine)
        session = self.make_session()

        self.testsuite = dict()
        self._load_schemas(session)
        session.expunge_all()
        session.close()

    def close(self):
        self.engine.dispose()

    @staticmethod
    def close_all_engines():
        """Hack for async_ops. Do not use for anything else."""
        with V4DB._engine_lock:
            for engine in _engines:
                engine.dispose()
            V4DB._engines = []

    def make_session(self):
        return self.sessionmaker()

    def settings(self):
        """All the setting needed to recreate this instnace elsewhere."""
        return {
            'path': self.path,
            'config': self.config,
            'baseline_revision': self.baseline_revision,
        }

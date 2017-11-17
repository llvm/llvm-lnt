import glob
import yaml
import sys

try:
    import threading
except Exception:
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
    def _load_schema_file(self, schema_file):
        session = self.make_session(expire_on_commit=False)
        with open(schema_file) as schema_fd:
            data = yaml.load(schema_fd)
        suite = testsuite.TestSuite.from_json(data)
        testsuite.check_testsuite_schema_changes(session, suite)
        suite = testsuite.sync_testsuite_with_metatables(session, suite)
        session.commit()
        session.close()

        # Create tables if necessary
        tsdb = lnt.server.db.testsuitedb.TestSuiteDB(self, suite.name, suite)
        tsdb.create_tables(self.engine)
        return tsdb

    def _load_schemas(self):
        # Load schema files (preferred)
        schemasDir = self.config.schemasDir
        for schema_file in glob.glob('%s/*.yaml' % schemasDir):
            tsdb = self._load_schema_file(schema_file)
            self.testsuite[tsdb.name] = tsdb

        # Load schemas from database.
        session = self.make_session(expire_on_commit=False)
        ts_list = session.query(testsuite.TestSuite).all()
        session.expunge_all()
        session.close()
        for suite in ts_list:
            name = suite.name
            if name in self.testsuite:
                continue
            tsdb = lnt.server.db.testsuitedb.TestSuiteDB(self, name, suite)
            self.testsuite[name] = tsdb

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

        # Update the database to the current version, if necessary. Only check
        # this once per path.
        lnt.server.db.migrate.update(self.engine)

        self.sessionmaker = sqlalchemy.orm.sessionmaker(self.engine)

        self.testsuite = dict()
        self._load_schemas()

    def close(self):
        self.engine.dispose()

    def make_session(self, expire_on_commit=True):
        return self.sessionmaker(expire_on_commit=expire_on_commit)

    def settings(self):
        """All the setting needed to recreate this instnace elsewhere."""
        return {
            'path': self.path,
            'config': self.config,
            'baseline_revision': self.baseline_revision,
        }

from lnt.testing.util.commands import fatal
import glob
import yaml

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

    class TestSuiteAccessor(object):
        def __init__(self, v4db):
            self.v4db = v4db
            self._extra_suites = {}
            self._cache = {}

        def __iter__(self):
            for name, in self.v4db.query(testsuite.TestSuite.name):
                yield name
            for name in self._extra_suites.keys():
                yield name

        def add_suite(self, suite):
            name = suite.name
            self._extra_suites[name] = suite

        def get(self, name, default=None):
            # Check the test suite cache, to avoid gratuitous reinstantiation.
            #
            # FIXME: Invalidation?
            if name in self._cache:
                return self._cache[name]

            create_tables = False
            ts = self._extra_suites.get(name)
            if ts:
                ts.check_schema_changes(self.v4db)
                create_tables = True
            else:
                # Get the test suite object.
                ts = self.v4db.query(testsuite.TestSuite).\
                    filter(testsuite.TestSuite.name == name).first()
                if ts is None:
                    return default

            # Instantiate the per-test suite wrapper object for this test
            # suite.
            self._cache[name] = ts = lnt.server.db.testsuitedb.TestSuiteDB(
                self.v4db, name, ts, create_tables=create_tables)
            return ts

        def __getitem__(self, name):
            ts = self.get(name)
            if ts is None:
                raise IndexError(name)
            return ts

        def keys(self):
            return iter(self)

        def values(self):
            for name in self:
                yield self[name]

        def items(self):
            for name in self:
                yield name, self[name]

    def _load_schema_file(self, schema_file):
        with open(schema_file) as schema_fd:
            data = yaml.load(schema_fd)
        suite = testsuite.TestSuite.from_json(data)
        self.testsuite.add_suite(suite)
        logger.info("External TestSuite '%s' loaded from '%s'" %
                    (suite.name, schema_file))

    def _load_shemas(self):
        schemasDir = self.config.schemasDir
        for schema_file in glob.glob('%s/*.yaml' % schemasDir):
            try:
                self._load_schema_file(schema_file)
            except:
                logger.error("Could not load schema '%s'" % schema_file,
                             exc_info=True)

    def __init__(self, path, config, baseline_revision=0, echo=False):
        # If the path includes no database type, assume sqlite.
        if lnt.server.db.util.path_has_no_database_type(path):
            path = 'sqlite:///' + path

        self.path = path
        self.config = config
        self.baseline_revision = baseline_revision
        self.echo = echo
        with V4DB._engine_lock:
            if path not in V4DB._engine:
                connect_args = {}
                if path.startswith("sqlite://"):
                    # Some of the background tasks keep database transactions
                    # open for a long time. Make it less likely to hit
                    # "(OperationalError) database is locked" because of that.
                    connect_args['timeout'] = 30
                engine = sqlalchemy.create_engine(path, echo=echo,
                                                  connect_args=connect_args)
                V4DB._engine[path] = engine
        self.engine = V4DB._engine[path]

        # Update the database to the current version, if necessary. Only check
        # this once per path.
        if path not in V4DB._db_updated:
            lnt.server.db.migrate.update(self.engine)
            V4DB._db_updated.add(path)

        # Proxy object for implementing dict-like .testsuite property.
        self._testsuite_proxy = None

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

        # Resolve or create the known status kinds.
        kinds = {k.id: k for k in self.query(testsuite.StatusKind).all()}
        try:
            self.pass_status_kind = kinds[lnt.testing.PASS]
            self.fail_status_kind = kinds[lnt.testing.FAIL]
            self.xfail_status_kind = kinds[lnt.testing.XFAIL]
        except KeyError:
                fatal("status kinds not initialized!")

        sample_types = {
            st.name: st for st in self.query(testsuite.SampleType).all()
        }
        # Resolve or create the known sample types.
        try:
            self.real_sample_type = sample_types["Real"]
            self.status_sample_type = sample_types["Status"]
            self.hash_sample_type = sample_types["Hash"]
        except KeyError:
            fatal("sample types not initialized!")

        self._load_shemas()

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
        return {'path': self.path,
                'config': self.config,
                'baseline_revision': self.baseline_revision,
                'echo': self.echo}

    @property
    def testsuite(self):
        # This is the start of "magic" part of V4DB, which allows us to get
        # fully bound SA instances for databases which are effectively
        # described by the TestSuites table.

        # The magic starts by returning a object which will allow us to use
        # dictionary like access to get the per-test suite database wrapper.
        if self._testsuite_proxy is None:
            self._testsuite_proxy = V4DB.TestSuiteAccessor(self)
        return self._testsuite_proxy

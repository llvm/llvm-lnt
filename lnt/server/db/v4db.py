import sqlalchemy

import lnt.testing

import lnt.server.db.testsuitedb
import lnt.server.db.migrate

from lnt.server.db import testsuite

class V4DB(object):
    """
    Wrapper object for LNT v0.4+ databases.
    """

    class TestSuiteAccessor(object):
        def __init__(self, v4db):
            self.v4db = v4db
            self._cache = {}

        def __iter__(self):
            for name, in self.v4db.query(testsuite.TestSuite.name):
                yield name

        def get(self, name, default = None):
            # Check the test suite cache, to avoid gratuitous reinstantiation.
            #
            # FIXME: Invalidation?
            if name in self._cache:
                return self._cache[name]

            # Get the test suite object.
            ts = self.v4db.query(testsuite.TestSuite).\
                filter(testsuite.TestSuite.name == name).first()
            if ts is None:
                return default

            # Instantiate the per-test suite wrapper object for this test suite.
            self._cache[name] = ts = lnt.server.db.testsuitedb.TestSuiteDB(
                self.v4db, name, ts)
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
                yield name,self[name]

    def __init__(self, path, echo=False):
        # If the path includes no database type, assume sqlite.
        #
        # FIXME: I would like to phase this out and force clients to propagate
        # paths, but it isn't a big deal.
        if not path.startswith('mysql://') and not path.startswith('sqlite://'):
            path = 'sqlite:///' + path

        self.path = path
        self.engine = sqlalchemy.create_engine(path, echo=echo)

        # Update the database to the current version, if necessary.
        lnt.server.db.migrate.update(self.engine)

        # Proxy object for implementing dict-like .testsuite property.
        self._testsuite_proxy = None

        self.session = sqlalchemy.orm.sessionmaker(self.engine)()

        # Add several shortcut aliases.
        self.add = self.session.add
        self.commit = self.session.commit
        self.query = self.session.query
        self.rollback = self.session.rollback

        # For parity with the usage of TestSuiteDB, we make our primary model
        # classes available as instance variables.
        self.SampleType = testsuite.SampleType
        self.StatusKind = testsuite.StatusKind
        self.TestSuite = testsuite.TestSuite

        # Resolve or create the known status kinds.
        self.pass_status_kind = self.query(testsuite.StatusKind)\
            .filter_by(id = lnt.testing.PASS).first()
        self.fail_status_kind = self.query(testsuite.StatusKind)\
            .filter_by(id = lnt.testing.FAIL).first()
        self.xfail_status_kind = self.query(testsuite.StatusKind)\
            .filter_by(id = lnt.testing.XFAIL).first()
        assert (self.pass_status_kind and self.fail_status_kind and
                self.xfail_status_kind), \
                "status kinds not initialized!"

        # Resolve or create the known sample types.
        self.real_sample_type = self.query(testsuite.SampleType)\
            .filter_by(name = "Real").first()
        self.status_sample_type = self.query(testsuite.SampleType)\
            .filter_by(name = "Status").first()
        assert (self.real_sample_type and self.status_sample_type), \
            "sample types not initialized!"

    @property
    def testsuite(self):
        # This is the start of "magic" part of V4DB, which allows us to get
        # fully bound SA instances for databases which are effectively described
        # by the TestSuites table.

        # The magic starts by returning a object which will allow us to use
        # dictionary like access to get the per-test suite database wrapper.
        if self._testsuite_proxy is None:
            self._testsuite_proxy = V4DB.TestSuiteAccessor(self)
        return self._testsuite_proxy

    # FIXME: The getNum...() methods below should be phased out once we can
    # eliminate the v0.3 style databases.
    def getNumMachines(self):
        return sum([ts.query(ts.Machine).count()
                    for ts in self.testsuite.values()])
    def getNumRuns(self):
        return sum([ts.query(ts.Run).count()
                    for ts in self.testsuite.values()])
    def getNumSamples(self):
        return sum([ts.query(ts.Sample).count()
                    for ts in self.testsuite.values()])
    def getNumTests(self):
        return sum([ts.query(ts.Test).count()
                    for ts in self.testsuite.values()])

    def importDataFromDict(self, data, config=None):
        # Select the database to import into.
        #
        # FIXME: Promote this to a top-level field in the data.
        db_name = data['Run']['Info'].get('tag')
        if db_name is None:
            raise ValueError,"unknown database target (no tag field)"

        db = self.testsuite.get(db_name)
        if db is None:
            raise ValueError,"test suite %r not present in this database!" % (
                db_name)

        return db.importDataFromDict(data, config)

    def get_db_summary(self):
        return V4DBSummary(self)

class V4DBSummary(object):
    class SuiteSummary(object):
        def __init__(self, name, path):
            self.name = name
            self.path = path

    def __init__(self, db):
        self.db = db
        # Load all the test suite names now so that we don't attempt to reuse a
        # cursor later.
        #
        # FIXME: Really, we just need to eliminate this object.
        self.testsuites = list(self.db.testsuite)

    @property
    def suites(self):
        for name in self.testsuites:
            yield V4DBSummary.SuiteSummary(name, ("v4", name))

    def is_up_to_date(self, db):
        return True

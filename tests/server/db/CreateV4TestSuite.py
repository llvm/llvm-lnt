# This test just checks that we can construct and manipulate the test suite
# model itself. The heavy lifting of constructing a test suite's databases,
# etc. is checked in CreateV4TestSuiteInstance.
#
# RUN: rm -f %t.db
# RUN: python %s %t.db

from lnt.server.config import Config
from lnt.server.db import testsuite
from lnt.server.db import v4db

# Create an in memory database.
db = v4db.V4DB("sqlite:///:memory:", Config.dummy_instance())
session = db.make_session()

# We expect exactly the NTS test suite.
test_suites = list(session.query(testsuite.TestSuite))
assert len(test_suites) == 1

# Check the NTS test suite.
ts = session.query(testsuite.TestSuite).filter_by(name="nts").first()
assert ts.name == "nts"
assert ts.db_key_name == "NT"
assert len(ts.machine_fields) == 2
assert len(ts.order_fields) == 1
assert len(ts.run_fields) == 0

assert ts.machine_fields[0].name == "hardware"
assert ts.machine_fields[1].name == "os"

assert ts.order_fields[0].name == "llvm_project_revision"

assert ts.machine_fields[0].test_suite is ts
assert ts.order_fields[0].test_suite is ts

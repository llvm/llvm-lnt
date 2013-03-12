# This test just checks that we can construct and manipulate the test suite
# model itself. The heavy lifting of constructing a test suite's databases,
# etc. is checked in CreateV4TestSuiteInstance.
#
# RUN: rm -f %t.db
# RUN: python %s %t.db

import sys
from lnt.server.config import Config
from lnt.server.db import testsuite
from lnt.server.db import v4db

# Create an in memory database.
db = v4db.V4DB("sqlite:///:memory:", Config.dummyInstance(), echo=True)

# We expect exactly two test suites, one for NTS and one for Compile.
test_suites = list(db.query(testsuite.TestSuite))
assert len(test_suites) == 2

# Check the NTS test suite.
ts = db.query(testsuite.TestSuite).filter_by(name="nts").first()
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

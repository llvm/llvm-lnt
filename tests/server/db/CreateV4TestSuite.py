# This test just checks that we can construct and manipulate the test suite
# model itself. The heavy lifting of constructing a test suite's databases,
# etc. is checked in CreateV4TestSuiteInstance.
#
# RUN: rm -rf %t.instance
# RUN: %{utils}/with_postgres.sh %t.pg.log \
# RUN:     %{utils}/with_temporary_instance.py %t.instance \
# RUN:         -- python %s %t.instance

import sys

import lnt.server.instance
from lnt.server.db import testsuite

# Load the database from the test instance.
instance_path = sys.argv[1]
db = lnt.server.instance.Instance.frompath(instance_path).get_database('default')
session = db.make_session()

# We expect the NTS test suite to be present.
ts = session.query(testsuite.TestSuite).filter_by(name="nts").first()
assert ts is not None
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

# Check the import process into a v4 test suite DB.
#
# We first construct a temporary LNT instance.
# RUN: rm -rf %t.install
# RUN: lnt create %t.install

# Import the first test set.
# RUN: lnt import %t.install %{shared_inputs}/sample-a-small.plist \
# RUN:     --show-sample-count > %t1.log
# RUN: FileCheck -check-prefix=IMPORT-A-1 %s < %t1.log
#
# IMPORT-A-1: Added Machines: 1
# IMPORT-A-1: Added Runs : 1
# IMPORT-A-1: Added Tests : 1
# IMPORT-A-1: Added Samples : 2
#
# IMPORT-A-1: PASS : 5

# Import the second test set.
# RUN: lnt import %t.install %{shared_inputs}/sample-b-small.plist \
# RUN:     --show-sample-count --show-sql > %t2.log
# RUN: FileCheck -check-prefix=IMPORT-B %s < %t2.log
#
# IMPORT-B: Added Runs : 1
# IMPORT-B: Added Samples : 1

# Check appending to an existing order
# RUN: lnt import %t.install %{shared_inputs}/sample-a-small.plist \
# RUN:     --show-sample-count --merge=append >& %t_append.log
# RUN: FileCheck -check-prefix=IMPORT-A-APPEND %s < %t_append.log
#
# IMPORT-A-APPEND-NOT: Added Machines
# IMPORT-A-APPEND: Added Runs : 1
# IMPORT-A-APPEND-NOT: Added Tests
# IMPORT-A-APPEND: Added Samples : 2
#
# IMPORT-A-APPEND: PASS : 5

# Check that reimporting replaces the existing run.
# RUN: lnt import %t.install %{shared_inputs}/sample-a-small.plist \
# RUN:     --show-sample-count --merge=replace >& %t_replace.log
# RUN: FileCheck -check-prefix=IMPORT-A-REPLACE %s < %t_replace.log
#
# IMPORT-A-REPLACE-NOT: Added Machines
# IMPORT-A-REPLACE: Added Runs : -1
# IMPORT-A-REPLACE-NOT: Added Tests
# IMPORT-A-REPLACE: Added Samples : -2
#
# IMPORT-A-REPLACE: PASS : 5

# Check that reimporting the first test set properly reports as a duplicate.
# RUN: not lnt import %t.install %{shared_inputs}/sample-a-small.plist \
# RUN:     --show-sample-count --merge=reject >& %t_reject.log
# RUN: FileCheck -check-prefix=IMPORT-A-REJECT %s < %t_reject.log
#
# IMPORT-A-REJECT: Duplicate submission for '1'

# Dump a copy of the database, so it will show up in logs.
# RUN: sqlite3 %t.install/data/lnt.db .dump

# Run consistency checks on the final database, to validate the import.
# RUN: python %s %t.install/data/lnt.db

import datetime, sys

import lnt.testing
from lnt.server.config import Config
from lnt.server.db import testsuite
from lnt.server.db import v4db

# Load the test database.
db = v4db.V4DB("sqlite:///%s" % sys.argv[1], Config.dummy_instance())
session = db.make_session()

# Get the status kinds, and validate the IDs align with the testing IDs.
pass_kind = session.query(testsuite.StatusKind) \
    .filter_by(id = lnt.testing.PASS).one()
assert pass_kind.name == "PASS"
fail_kind = session.query(testsuite.StatusKind) \
    .filter_by(id = lnt.testing.FAIL).one()
assert fail_kind.name == "FAIL"
xfail_kind = session.query(testsuite.StatusKind) \
    .filter_by(id = lnt.testing.XFAIL).one()
assert xfail_kind.name == "XFAIL"

# Load the imported test suite.
ts = db.testsuite['nts']

# Validate the machine.
machines = list(session.query(ts.Machine))
assert len(machines) == 1
machine = machines[0]
assert machine.name == 'LNT SAMPLE MACHINE'
assert machine.hardware == "x86_64"
assert machine.os == "SAMPLE OS"
parameters = machine.parameters
assert len(parameters) == 1
assert parameters['extrakey'] == u'extravalue'

# Validate the tests.
tests = list(session.query(ts.Test))
assert len(tests) == 1
test = tests[0]
assert tests[0].name == 'sampletest'

# Validate the orders.
orders = list(session.query(ts.Order).order_by(ts.Order.llvm_project_revision))
assert len(orders) == 2
order_a,order_b = orders
print order_a
print order_b
assert order_a.previous_order_id is None
assert order_a.next_order_id is order_b.id
assert order_a.llvm_project_revision == '1'
assert order_b.previous_order_id is order_a.id
assert order_b.next_order_id is None
assert order_b.llvm_project_revision == '2'

# Validate the runs.
runs = list(session.query(ts.Run).order_by(ts.Run.order_id))
assert len(runs) == 2
run_a,run_b = runs
assert run_a.machine is machine
assert run_b.machine is machine
assert run_a.order is order_a
assert run_b.order is order_b
assert run_a.imported_from.endswith("sample-a-small.plist")
assert run_b.imported_from.endswith("sample-b-small.plist")
assert run_a.start_time == datetime.datetime(2009, 11, 17, 2, 12, 25)
assert run_a.end_time == datetime.datetime(2009, 11, 17, 3, 44, 48)
assert sorted(run_a.parameters.items()) == [('inferred_run_order', '1')]
assert sorted(run_b.parameters.items()) == [('inferred_run_order', '2')]

# Validate the samples.
samples = list(session.query(ts.Sample)\
    .join(ts.Run) \
    .order_by(ts.Run.order_id, ts.Sample.id))
assert len(samples) == 3
sample_a_0,sample_a_1,sample_b = samples
assert sample_a_0.run is run_a
assert sample_a_1.run is run_a
assert sample_b.run is run_b
assert sample_a_0.test is test
assert sample_a_1.test is test
assert sample_b.test is test
print sample_a_0
print sample_a_1
print sample_b
assert sample_a_0.compile_time == 0.019
assert sample_a_0.compile_status == lnt.testing.PASS
assert sample_a_0.execution_time == 0.3
assert sample_a_0.execution_status == lnt.testing.PASS
assert sample_a_1.compile_time == 0.0189
assert sample_a_1.compile_status is None
assert sample_a_1.execution_time == 0.29
assert sample_a_1.execution_status is None
assert sample_b.compile_time == 0.022
assert sample_b.compile_status == lnt.testing.PASS
assert sample_b.execution_time == 0.32
assert sample_b.execution_status == lnt.testing.PASS

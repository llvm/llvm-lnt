# Check the model bindings for test suite instances.
#
# RUN: rm -f %t.db
# RUN: python %s %t.db

import datetime

from lnt.server.config import Config
from lnt.server.db import testsuite
from lnt.server.db import v4db
from lnt.server.db.fieldchange import RegressionState

# Create an in memory database.
db = v4db.V4DB("sqlite:///:memory:", Config.dummy_instance())
session = db.make_session()

# Get the test suite wrapper.
ts_db = db.testsuite['nts']

# Check that we can construct and access all of the primary fields for the test
# suite database objects.

# Create the objects.
start_time = datetime.datetime.utcnow()
end_time = datetime.datetime.utcnow()

machine = ts_db.Machine("test-machine")
machine.os = "test-os"
order = ts_db.Order()
order.llvm_project_revision = "1234"

order2 = ts_db.Order()
order2.llvm_project_revision = "1235"

order3 = ts_db.Order()
order3.llvm_project_revision = "1236"


run = ts_db.Run(None, machine, order, start_time, end_time)
test = ts_db.Test("test-a")

sample = ts_db.Sample(run, test, compile_time=1.0, score=4.2, code_size=100)
sample.mem_bytes = 58093568

# Add and commit.
session.add(machine)
session.add(order)
session.add(order2)
session.add(order3)


session.add(run)
session.add(test)
session.add(sample)
field_change = ts_db.FieldChange(order, order2, machine, test,
                                 list(sample.get_primary_fields())[0].id)

session.add(field_change)

field_change2 = ts_db.FieldChange(order2, order3, machine, test,
                                  list(sample.get_primary_fields())[1].id)
session.add(field_change2)

TEST_TITLE = "Some regression title"

regression = ts_db.Regression(TEST_TITLE, "PR1234", RegressionState.DETECTED)
session.add(regression)

regression_indicator1 = ts_db.RegressionIndicator(regression, field_change)
regression_indicator2 = ts_db.RegressionIndicator(regression, field_change2)

session.add(regression_indicator1)
session.add(regression_indicator2)

session.commit()

del machine, order, run, test, sample

# Fetch the added objects.
machines = session.query(ts_db.Machine).all()
assert len(machines) == 1
machine = machines[0]

orders = session.query(ts_db.Order).all()
assert len(orders) == 3
order = orders[0]

runs = session.query(ts_db.Run).all()
assert len(runs) == 1
run = runs[0]

tests = session.query(ts_db.Test).all()
assert len(tests) == 1
test = tests[0]

samples = session.query(ts_db.Sample).all()
assert len(samples) == 1
sample = samples[0]

assert sample.code_size == 100

regression_indicators = session.query(ts_db.RegressionIndicator).all()
assert len(regression_indicators) == 2
ri = regression_indicators[0]

assert ri.regression.title == TEST_TITLE

# Audit the various fields.
assert machine.name == "test-machine"
assert machine.os == "test-os"

assert order.next_order_id is None
assert order.previous_order_id is None
assert order.llvm_project_revision == "1234"

assert run.machine is machine
assert run.order is order
assert run.start_time == start_time
assert run.end_time == end_time

assert test.name == "test-a"

assert sample.run is run
assert sample.test is test
assert sample.compile_time == 1.0
assert sample.score == 4.2
assert sample.mem_bytes == 58093568

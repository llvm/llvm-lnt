# Check that ABExperiment, ABRun, and ABSample tables are created and usable.
#
# RUN: rm -f %t.db
# RUN: python %s %t.db

import datetime

from lnt.server.config import Config
from lnt.server.db import v4db

# Create an in-memory database; this triggers TestSuiteDB.__init__() which
# creates all tables including the new AB tables.
db = v4db.V4DB("sqlite:///:memory:", Config.dummy_instance())
session = db.make_session()

# Get the test suite wrapper.
ts_db = db.testsuite['nts']

# Verify the new classes are accessible on the TestSuiteDB instance.
assert hasattr(ts_db, 'ABRun'), "ts_db.ABRun not found"
assert hasattr(ts_db, 'ABSample'), "ts_db.ABSample not found"
assert hasattr(ts_db, 'ABExperiment'), "ts_db.ABExperiment not found"

# Verify table names follow the db_key_name prefix.
assert ts_db.ABRun.__tablename__ == 'NT_ABRun'
assert ts_db.ABSample.__tablename__ == 'NT_ABSample'
assert ts_db.ABExperiment.__tablename__ == 'NT_ABExperiment'

# Create a Machine and two ABRuns for the experiment.
start_time = datetime.datetime(2024, 1, 1, 0, 0, 0)
end_time = datetime.datetime(2024, 1, 1, 0, 5, 0)

machine = ts_db.Machine("test-machine")
machine.os = "test-os"
session.add(machine)
session.flush()

control_run = ts_db.ABRun()
control_run.machine_id = machine.id
control_run.start_time = start_time
control_run.end_time = end_time
session.add(control_run)

variant_run = ts_db.ABRun()
variant_run.machine_id = machine.id
variant_run.start_time = start_time
variant_run.end_time = end_time
session.add(variant_run)
session.flush()

# Create an ABExperiment linking the two runs.
exp = ts_db.ABExperiment()
exp.name = "test-experiment"
exp.created_time = datetime.datetime.utcnow()
exp.control_run_id = control_run.id
exp.variant_run_id = variant_run.id
exp.pinned = False
session.add(exp)

# Create a Test and ABSamples.
test = ts_db.Test("benchmark-a")
session.add(test)
session.flush()

control_sample = ts_db.ABSample()
control_sample.run_id = control_run.id
control_sample.test_id = test.id
control_sample.compile_time = 1.0
session.add(control_sample)

variant_sample = ts_db.ABSample()
variant_sample.run_id = variant_run.id
variant_sample.test_id = test.id
variant_sample.compile_time = 1.05
session.add(variant_sample)

session.commit()

# --- Verify round-trip ---

exps = session.query(ts_db.ABExperiment).all()
assert len(exps) == 1, "expected 1 ABExperiment, got %d" % len(exps)
e = exps[0]
assert e.name == "test-experiment"
assert e.control_run_id == control_run.id
assert e.variant_run_id == variant_run.id
assert e.pinned is False

ab_runs = session.query(ts_db.ABRun).all()
assert len(ab_runs) == 2, "expected 2 ABRuns, got %d" % len(ab_runs)

ab_samples = session.query(ts_db.ABSample).all()
assert len(ab_samples) == 2, "expected 2 ABSamples, got %d" % len(ab_samples)

# Verify dynamic metric columns were created.
assert ab_samples[0].compile_time == 1.0
assert ab_samples[1].compile_time == 1.05

# Verify ABRun has no order_id (isolation guarantee).
assert not hasattr(ts_db.ABRun, 'order_id'), \
    "ABRun must not have order_idm, it must not link to the Order table"

# Verify that item.column still points to the Sample table (not ABSample).
for field in ts_db.sample_fields:
    assert field.column.table.name == ('NT_Sample'), \
        "item.column for field %r was clobbered (points to %s)" % (
            field.name, field.column.table.name)

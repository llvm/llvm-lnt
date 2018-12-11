from sqlalchemy import desc, asc
import datetime
import re
from collections import namedtuple
from lnt.server.reporting.analysis import RunInfo
from lnt.server.ui.util import guess_test_short_name as shortname


class RegressionState:
    # A new regression, not approved by the user yet.
    DETECTED = 0
    # Approved, but waiting for cooldown.
    STAGED = 1
    # Needs to be investigated.
    ACTIVE = 10

    # We won't fix this.
    NTBF = 20
    # This is not a real regression.
    IGNORED = 21
    # Manually marked as fixed.
    FIXED = 22
    # System detected it is fixed.
    DETECTED_FIXED = 23
    names = {
        DETECTED: u'Detected',
        STAGED: u'Staged',
        ACTIVE: u'Active',
        NTBF: u'Not to be Fixed',
        IGNORED: u'Ignored',
        DETECTED_FIXED: u'Verify',
        FIXED: u'Fixed',
    }


ChangeRuns = namedtuple("ChangeRuns", ["before", "after"])
ChangeData = namedtuple("ChangeData", ["ri", "cr", "run", "latest_cr"])


def new_regression(session, ts, field_changes):
    """Make a new regression and add to DB."""
    today = datetime.date.today()
    MSG = "Regression of 0 benchmarks"
    title = MSG
    regression = ts.Regression(title, "", RegressionState.DETECTED)
    session.add(regression)
    new_ris = []
    for fc_id in field_changes:
        if type(fc_id) == int:
            fc = get_fieldchange(session, ts, fc_id)
        else:
            fc = fc_id
        ri1 = ts.RegressionIndicator(regression, fc)
        new_ris.append(ri1)
    session.add_all(new_ris)
    rebuild_title(session, ts, regression)
    session.commit()
    return regression, new_ris


def rebuild_title(session, ts, regression):
    """Update the title of a regression."""
    if re.match(r"Regression of \d+ benchmarks.*", regression.title):
        old_changes = session.query(ts.RegressionIndicator) \
            .filter(ts.RegressionIndicator.regression_id == regression.id) \
            .all()
        new_size = len(old_changes)
        benchmarks = set()
        for ri in old_changes:
            fc = ri.field_change
            benchmarks.add(shortname(fc.test.name))
        FMT = "Regression of {} benchmarks: {}"
        title = FMT.format(new_size, ', '.join(benchmarks))
        # Crop long titles.
        title = (title[:120] + '...') if len(title) > 120 else title
        regression.title = title
    return regression


def get_all_orders_for_machine(session, ts, machine):
    """Get all the orders for this sa machine."""
    return session.query(ts.Order) \
        .join(ts.Run) \
        .filter(ts.Run.machine_id == machine) \
        .order_by(asc(ts.Order.llvm_project_revision)) \
        .all()


def get_ris(session, ts, regression_id):
    return session.query(ts.RegressionIndicator) \
        .filter(ts.RegressionIndicator.regression_id == regression_id) \
        .all()


def get_runs_for_order_and_machine(session, ts, order_id, machine_id):
    """Collect all the runs for a particular order/machine combo."""
    runs = session.query(ts.Run) \
        .filter(ts.Run.machine_id == machine_id) \
        .filter(ts.Run.order_id == order_id) \
        .all()
    return runs


def get_runs_of_fieldchange(session, ts, fc):
    before_runs = get_runs_for_order_and_machine(session, ts,
                                                 fc.start_order_id,
                                                 fc.machine_id)
    after_runs = get_runs_for_order_and_machine(session, ts, fc.end_order_id,
                                                fc.machine_id)
    return ChangeRuns(before_runs, after_runs)


def get_current_runs_of_fieldchange(session, ts, fc):
    before_runs = get_runs_for_order_and_machine(session, ts,
                                                 fc.start_order_id,
                                                 fc.machine_id)
    newest_order = get_all_orders_for_machine(session, ts, fc.machine_id)[-1]

    after_runs = get_runs_for_order_and_machine(session, ts, newest_order.id,
                                                fc.machine_id)
    return ChangeRuns(before_runs, after_runs)


def get_first_runs_of_fieldchange(session, ts, fc):
    run = session.query(ts.Run) \
        .filter(ts.Run.machine_id == fc.machine_id) \
        .filter(ts.Run.order_id == fc.end_order_id) \
        .first()
    return run


def get_cr_for_field_change(session, ts, field_change, current=False):
    """Given a filed_change, calculate a comparison result for that change.
    And the last run."""
    if current:
        runs = get_current_runs_of_fieldchange(session, ts, field_change)
    else:
        runs = get_runs_of_fieldchange(session, ts, field_change)
    runs_all = list(runs.before)
    runs_all.extend(runs.after)
    ri = RunInfo(session, ts, [r.id for r in runs_all],
                 only_tests=[field_change.test_id])
    cr = ri.get_comparison_result(runs.after, runs.before,
                                  field_change.test.id, field_change.field,
                                  ts.Sample.get_hash_of_binary_field())
    return cr, runs.after[0], runs_all


def get_fieldchange(session, ts, fc_id):
    """Get a fieldchange given an ID."""
    return session.query(ts.FieldChange) \
        .filter(ts.FieldChange.id == fc_id).one()

import re
import sqlalchemy.sql
import lnt.server.reporting.analysis
from lnt.testing.util.commands import warning
from lnt.testing.util.commands import note
from lnt.server.ui.regression_views import new_regression, RegressionState
# How many runs backwards to use in the previous run set.
# More runs are slower (more DB access), but may provide
# more accurate results.
FIELD_CHANGE_LOOKBACK = 10


def regenerate_fieldchanges_for_run(ts, run_id):
    """Regenerate the set of FieldChange objects for the given run.
    """
    # Allow for potentially a few different runs, previous_runs, next_runs
    # all with the same order_id which we will aggregate together to make
    # our comparison result.
    run = ts.getRun(run_id)
    runs = ts.query(ts.Run). \
        filter(ts.Run.order_id == run.order_id). \
        filter(ts.Run.machine_id == run.machine_id). \
        all()
    regressions = ts.query(ts.Regression).all()[::-1]
    previous_runs = ts.get_previous_runs_on_machine(run, FIELD_CHANGE_LOOKBACK)
    next_runs = ts.get_next_runs_on_machine(run, FIELD_CHANGE_LOOKBACK)

    # Find our start/end order.
    if previous_runs != []:
        start_order = previous_runs[0].order
    else:
        start_order = run.order
    if next_runs != []:
        end_order = next_runs[-1].order
    else:
        end_order = run.order

    # Load our run data for the creation of the new fieldchanges.
    runs_to_load = [r.id for r in (runs + previous_runs)]

    # When the same rev is submitted many times, the database accesses here
    # can be huge, and it is almost always an error to have the same rev
    # be used in so many runs.
    run_size = len(runs_to_load)
    if run_size > 50:
        warning("Generating field changes for {} runs."
                "That will be very slow.".format(run_size))
    runinfo = lnt.server.reporting.analysis.RunInfo(ts, runs_to_load)

    # Only store fieldchanges for "metric" samples like execution time;
    # not for fields with other data, e.g. hash of a binary
    for field in list(ts.Sample.get_metric_fields()):
        for test_id in runinfo.test_ids:
            f = None
            result = runinfo.get_comparison_result(runs, previous_runs,
                                                   test_id, field)
            # Try and find a matching FC and update, else create one.
            try:
                f = ts.query(ts.FieldChange) \
                    .filter(ts.FieldChange.start_order == start_order) \
                    .filter(ts.FieldChange.end_order == end_order) \
                    .filter(ts.FieldChange.test_id == test_id) \
                    .filter(ts.FieldChange.machine == run.machine) \
                    .filter(ts.FieldChange.field == field) \
                    .one()
            except sqlalchemy.orm.exc.NoResultFound:
                f = None

            if not result.is_result_performance_change() and f:
                # With more data, its not a regression. Kill it!
                note("Removing field change: {}".format(f.id))
                ts.delete(f)
                continue

            if result.is_result_performance_change() and not f:
                test = ts.query(ts.Test).filter(ts.Test.id == test_id).one()
                f = ts.FieldChange(start_order=start_order,
                                   end_order=run.order,
                                   machine=run.machine,
                                   test=test,
                                   field=field)
                ts.add(f)
                ts.commit()
                found, new_reg = identify_related_changes(ts, regressions, f)
                if found:
                    regressions.append(new_reg)
                note("Found field change: {}".format(run.machine))

            # Always update FCs with new values.
            if f:
                f.old_value = result.previous
                f.new_value = result.current
                f.run = run
    ts.commit()


def is_overlaping(fc1, fc2):
    """"Returns true if these two orders intersect. """
    r1_min = fc1.start_order
    r1_max = fc1.end_order
    r2_min = fc2.start_order
    r2_max = fc2.end_order
    return (r1_min == r2_min and r1_max == r2_max) or \
           (r1_min < r2_max and r2_min < r1_max)


def shortname(benchmark):
    """Given a benchmarks full name, make a short version"""
    return benchmark.split("/")[-1]


def rebuild_title(ts, regression):
    """Update the title of a regresson."""
    if re.match("Regression of \d+ benchmarks.*", regression.title):
        old_changes = ts.query(ts.RegressionIndicator) \
            .filter(ts.RegressionIndicator.regression_id == regression.id) \
            .all()
        new_size = len(old_changes)
        benchmarks = set()
        for ri in old_changes:
            fc = ri.field_change
            benchmarks.add(shortname(fc.test.name))
        print benchmarks
        FMT = "Regression of {} benchmarks: {}"
        title = FMT.format(new_size, ', '.join(benchmarks))
        # Crop long titles.
        title = (title[:120] + '...') if len(title) > 120 else title
        regression.title = title
        print title
    return regression


def identify_related_changes(ts, regressions, fc):
    """Can we find a home for this change in some existing regression? """
    for regression in regressions:
        regression_indicators = ts.query(ts.RegressionIndicator) \
            .filter(ts.RegressionIndicator.regression_id == regression.id) \
            .all()
        for change in regression_indicators:
            regression_change = change.field_change
            if is_overlaping(regression_change, fc):
                confidence = 0
                relation = ["Revision"]
                if regression_change.machine == fc.machine:
                    confidence += 1
                    relation.append("Machine")
                if regression_change.test == fc.test:
                    confidence += 1
                    relation.append("Test")
                if regression_change.field == fc.field:
                    confidence += 1
                    relation.append("Field")

                if confidence >= 2:
                    # Matching
                    note("Found a match:" + str(regression)  + " On " +
                         ', '.join(relation))
                    ri = ts.RegressionIndicator(regression, fc)
                    ts.add(ri)
                    # Update the default title if needed.
                    rebuild_title(ts, regression)
                    return (True, regression)
    note("Could not find a partner, creating new Regression for change")
    new_reg = new_regression(ts, [fc.id])
    return (False, new_reg)

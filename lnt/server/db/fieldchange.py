import re
import sqlalchemy.sql
from sqlalchemy.orm.exc import ObjectDeletedError
import lnt.server.reporting.analysis
from lnt.testing.util.commands import warning
from lnt.testing.util.commands import note, timed
from lnt.server.db.regression import new_regression, RegressionState
from lnt.server.db.regression import get_ris
from lnt.server.db.regression import rebuild_title

from lnt.server.db import rules_manager as rules
# How many runs backwards to use in the previous run set.
# More runs are slower (more DB access), but may provide
# more accurate results.
FIELD_CHANGE_LOOKBACK = 10


def post_submit_tasks(ts, run_id):
    regenerate_fieldchanges_for_run(ts, run_id)


def delete_fieldchange(ts, change):
    """Delete this field change.  Since it might be attahed to a regression
    via regression indicators, fix those up too.  If this orphans a regression
    delete it as well."""
    # Find the indicators.
    indicators = ts.query(ts.RegressionIndicator). \
        filter(ts.RegressionIndicator.field_change_id == change.id). \
        all()
    # And all the related regressions.
    regression_ids = [r.regression_id for r in indicators]

    # Remove the idicators that point to this change.
    for ind in indicators:
        ts.delete(ind)
    
    # Now we can remove the change, itself.
    ts.delete(change)
    
    # We might have just created a regression with no changes.
    # If so, delete it as well.
    for r in regression_ids:
        remaining = ts.query(ts.RegressionIndicator). \
            filter(ts.RegressionIndicator.regression_id == r). \
            all()
        if len(remaining) == 0:
            r = ts.query(ts.Regression).get(r)
            note("Deleting regression because it has not changes:" + repr(r))
            ts.delete(r)
    ts.commit()


@timed
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
            result = runinfo.get_comparison_result(
                runs, previous_runs, test_id, field,
                ts.Sample.get_hash_of_binary_field())
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
                delete_fieldchange(ts, f)
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
                try:
                    found, new_reg = identify_related_changes(ts, regressions, f)
                except ObjectDeletedError:
                    # This can happen from time to time.
                    # So, lets retry once.
                    regressions = ts.query(ts.Regression).all()[::-1]
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
    rules.post_submission_hooks(ts, regressions)


def is_overlaping(fc1, fc2):
    """"Returns true if these two orders intersect. """
    try:
        r1_min = fc1.start_order
        r1_max = fc1.end_order
        r2_min = fc2.start_order
        r2_max = fc2.end_order
    except AttributeError:
        # If we are on first run, some of these could be None.
        return False
    return (r1_min == r2_min and r1_max == r2_max) or \
           (r1_min < r2_max and r2_min < r1_max)

@timed
def identify_related_changes(ts, regressions, fc):
    """Can we find a home for this change in some existing regression? """
    for regression in regressions:
        regression_indicators = get_ris(ts, regression)
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

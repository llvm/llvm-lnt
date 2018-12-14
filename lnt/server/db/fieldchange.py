import difflib
import sqlalchemy.sql
from sqlalchemy.orm import joinedload
from sqlalchemy.orm.session import Session
from sqlalchemy.orm.exc import ObjectDeletedError
from typing import Tuple, List

import lnt.server.reporting.analysis
from lnt.testing.util.commands import timed
from lnt.util import logger
from lnt.server.db.regression import new_regression, RegressionState
from lnt.server.db.regression import rebuild_title
from sqlalchemy import or_
from lnt.server.db import rules_manager as rules
from lnt.server.db.testsuitedb import TestSuiteDB
# How many runs backwards to use in the previous run set.
# More runs are slower (more DB access), but may provide
# more accurate results.

FIELD_CHANGE_LOOKBACK = 10


def post_submit_tasks(session, ts, run_id):
    """Run the field change related post submission tasks.

    """
    regenerate_fieldchanges_for_run(session, ts, run_id)


def delete_fieldchange(session, ts, change):
    # type: (Session, TestSuiteDB, TestSuiteDB.FieldChange) -> List[int]
    """Delete this field change.  Since it might be attahed to a regression
    via regression indicators, fix those up too.  If this orphans a regression
    delete it as well."""
    # Find the indicators.
    indicators = session.query(ts.RegressionIndicator). \
        filter(ts.RegressionIndicator.field_change_id == change.id). \
        all()
    # And all the related regressions.
    regression_ids = [r.regression_id for r in indicators]

    # Remove the idicators that point to this change.
    for ind in indicators:
        session.delete(ind)

    # Now we can remove the change, itself.
    session.delete(change)

    # We might have just created a regression with no changes.
    # If so, delete it as well.
    deleted_ids = []
    for r in regression_ids:
        remaining = session.query(ts.RegressionIndicator). \
            filter(ts.RegressionIndicator.regression_id == r). \
            all()
        if len(remaining) == 0:
            r = session.query(ts.Regression).get(r)
            logger.info("Deleting regression because it has not changes:" +
                        repr(r))
            session.delete(r)
            deleted_ids.append(r)
    session.commit()
    return deleted_ids


@timed
def regenerate_fieldchanges_for_run(session, ts, run_id):
    # type: (Session, TestSuiteDB, int) -> None
    """Regenerate the set of FieldChange objects for the given run.
    """
    # Allow for potentially a few different runs, previous_runs, next_runs
    # all with the same order_id which we will aggregate together to make
    # our comparison result.
    logger.info("Regenerate fieldchanges for %s run %s" % (ts, run_id))
    run = ts.getRun(session, run_id)
    runs = session.query(ts.Run). \
        filter(ts.Run.order_id == run.order_id). \
        filter(ts.Run.machine_id == run.machine_id). \
        all()

    previous_runs = ts.get_previous_runs_on_machine(session, run,
                                                    FIELD_CHANGE_LOOKBACK)
    next_runs = ts.get_next_runs_on_machine(session, run,
                                            FIELD_CHANGE_LOOKBACK)

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
        logger.warning("Generating field changes for {} runs."
                       "That will be very slow.".format(run_size))
    runinfo = lnt.server.reporting.analysis.RunInfo(session, ts, runs_to_load)

    # Only store fieldchanges for "metric" samples like execution time;
    # not for fields with other data, e.g. hash of a binary
    field_ids = [x.id for x in ts.Sample.get_metric_fields()]

    # We need to make sure if a field change already exists we use it.
    # Since querying on every possible test*field is expensive, get the
    # interesting locations ahead of time, and keep them in memory to
    # check if we should actually query.
    changes_of_interest = set(session.query(ts.FieldChange.start_order_id,
                                            ts.FieldChange.end_order_id,
                                            ts.FieldChange.test_id,
                                            ts.FieldChange.machine_id,
                                            ts.FieldChange.field_id)
                              .filter(ts.FieldChange.start_order == start_order)
                              .filter(ts.FieldChange.end_order == end_order)
                              .filter(ts.FieldChange.test_id.in_(runinfo.test_ids))
                              .filter(ts.FieldChange.machine == run.machine)
                              .filter(ts.FieldChange.field_id.in_(field_ids))
                              .all())

    active_indicators = session.query(ts.RegressionIndicator) \
        .join(ts.Regression) \
        .filter(or_(ts.Regression.state == RegressionState.DETECTED,
                    ts.Regression.state == RegressionState.DETECTED_FIXED)) \
        .options(joinedload(ts.RegressionIndicator.field_change)) \
        .options(joinedload("field_change.start_order")) \
        .options(joinedload("field_change.end_order")) \
        .options(joinedload("field_change.test")) \
        .all()

    for field in list(ts.Sample.get_metric_fields()):
        for test_id in runinfo.test_ids:
            f = None
            result = runinfo.get_comparison_result(
                runs, previous_runs, test_id, field,
                ts.Sample.get_hash_of_binary_field())
            # Try and find a matching FC and update, else create one.
            target = (start_order.id, run.order.id, run.machine.id, test_id, field.id)
            should_search = target in changes_of_interest

            if should_search:
                f = session.query(ts.FieldChange) \
                    .filter(ts.FieldChange.start_order == start_order) \
                    .filter(ts.FieldChange.end_order == end_order) \
                    .filter(ts.FieldChange.test_id == test_id) \
                    .filter(ts.FieldChange.machine == run.machine) \
                    .filter(ts.FieldChange.field_id == field.id) \
                    .one_or_none()
                if not f:
                    logger.warning("Fell back to field lookup. Should not happen.")
            if not result.is_result_performance_change() and f:
                # With more data, its not a regression. Kill it!
                logger.info("Removing field change: {}".format(f.id))
                deleted = delete_fieldchange(session, ts, f)
                continue

            if result.is_result_performance_change() and not f:
                test = session.query(ts.Test) \
                    .filter(ts.Test.id == test_id) \
                    .one()
                f = ts.FieldChange(start_order=start_order,
                                   end_order=run.order,
                                   machine=run.machine,
                                   test=test,
                                   field_id=field.id)
                session.add(f)
                try:
                    found, new_reg = identify_related_changes(session, ts,
                                                              f, active_indicators)
                except ObjectDeletedError:
                    # This can happen from time to time.
                    # So, lets retry once.
                    found, new_reg = identify_related_changes(session, ts,
                                                              f, active_indicators)

                if found:
                    logger.info("Found field change: {}".format(
                                run.machine))

            # Always update FCs with new values.
            if f:
                f.old_value = result.previous
                f.new_value = result.current
                f.run = run

    session.commit()

    rules.post_submission_hooks(session, ts, run_id)


def is_overlaping(fc1, fc2):
    # type: (TestSuiteDB.FieldChange, TestSuiteDB.FieldChange) -> bool

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


def percent_similar(a, b):
    # type: (str, str) -> float
    """
    Percent similar: are these strings similar to each other?
    :param a: first string
    :param b: second string
    """
    s = difflib.SequenceMatcher(lambda x: x.isdigit(), a, b)
    return s.ratio()


@timed
def identify_related_changes(session, ts, fc, active_indicators):
    # type: (Session, TestSuiteDB, TestSuiteDB.FieldChange, List) -> Tuple[bool, List]
    """Can we find a home for this change in some existing regression? If a
    match is found add a regression indicator adding this change to that
    regression, otherwise create a new regression for this change.

    Regression matching looks for regressions that happen in overlapping order
    ranges. Then looks for changes that are similar.

    """
    for change in active_indicators:
        regression_change = change.field_change

        if is_overlaping(regression_change, fc):
            confidence = 0.0

            confidence += percent_similar(regression_change.machine.name,
                                          fc.machine.name)
            confidence += percent_similar(regression_change.test.name,
                                          fc.test.name)

            if regression_change.field_id == fc.field_id:
                confidence += 1.0

            if confidence >= 2.0:
                # Matching
                MSG = "Found a match: {} with score {}."
                regression = session.query(ts.Regression) \
                    .get(change.regression_id)
                logger.info(MSG.format(str(regression),
                                       confidence))
                ri = ts.RegressionIndicator(regression, fc)
                session.add(ri)
                active_indicators.append(ri)
                # Update the default title if needed.
                rebuild_title(session, ts, regression)
                session.commit()
                return True, regression
    logger.info("Could not find a partner, creating new Regression for change")
    new_reg, new_indicators = new_regression(session, ts, [fc.id])
    active_indicators.extend(new_indicators)
    return False, new_reg

"""Check if a regression is fixed, and move to differnt sate.
Detcted + fixed -> Ignored
Staged or Active + fixed -> Verify
"""
from sqlalchemy.orm.session import Session
from typing import Dict  # noqa: flake8 does not detect use in comments

from lnt.server.db.regression import RegressionState
from lnt.server.db.regression import get_cr_for_field_change, get_ris
from lnt.server.db.testsuitedb import TestSuiteDB
from lnt.testing.util.commands import timed
from lnt.util import logger
from lnt.server.reporting.analysis import MIN_PERCENTAGE_CHANGE


def _fixed_rind(session, ts, rind):
    """Is this regression indicator fixed?"""
    fc = rind.field_change
    if fc is None:
        return False
    current_cr, _, _ = get_cr_for_field_change(session, ts, fc, current=True)
    if current_cr.pct_delta < MIN_PERCENTAGE_CHANGE:
        return True
    else:
        return False


def is_fixed(session, ts, regression):
    """Comparing the current value to the regression, is this regression now
    fixed?
    """
    r_inds = get_ris(session, ts, regression.id)
    fixes = (_fixed_rind(session, ts, x) for x in r_inds)
    return all(fixes)


def impacts(session, ts, run_id, regression):
    # type: (Session, TestSuiteDB, int, TestSuiteDB.Regression) -> bool
    """Does this run have a chance of impacting this regression?

    This is just to prevent doing a full comparison, so we don't have
    to be toally accurate. For now, compare machines."""
    machine_id = session.query(ts.Run.machine_id).filter(ts.Run.id == run_id).scalar()

    regression_machines = [x[0] for x in session.query(ts.FieldChange.machine_id)
                           .join(ts.RegressionIndicator)
                           .filter(ts.RegressionIndicator.regression_id == regression.id)
                           .all()]

    regression_machines_set = set(regression_machines)
    return machine_id in regression_machines_set


def age_out_oldest_regressions(session, ts, num_to_keep=50):
    # type: (Session, TestSuiteDB, int) -> int
    """Find the oldest regressions that are still in the detected state,
    and age them out.  This is needed when regressions are not manually
    acknowledged, regression analysis can grow unbounded.

    :param session: db session
    :param ts: testsuite
    :param num_to_keep: the number of newest regressions to keep in the detected state.
    :returns: the number of regressions changed.
    """

    regression_orders = session.query(ts.Regression.id, ts.FieldChange.end_order_id) \
        .filter(ts.Regression.state == RegressionState.DETECTED) \
        .join(ts.RegressionIndicator, ts.Regression.id == ts.RegressionIndicator.regression_id) \
        .join(ts.FieldChange) \
        .all()

    regression_newest_change = {}  # type: Dict[int, int]
    for regression_id, order_id in regression_orders:
        current = regression_newest_change.get(regression_id)
        if current is None or current < order_id:
            regression_newest_change[regression_id] = order_id
    # Order regressions by FC end order.
    ordered = sorted(regression_newest_change.items(), key=lambda x: x[1])
    to_move = ordered[0:(-1 * num_to_keep)]

    for r, _ in to_move:
        regress = session.query(ts.Regression).filter_by(id=r).one()
        logger.info("Ageing out regression {} to keep regression count under {}."
                    .format(regress, num_to_keep))
        regress.state = RegressionState.IGNORED
    return len(to_move)


@timed
def regression_evolution(session, ts, run_id):
    """Analyse regressions. If they have changes, process them.
    Look at each regression in state detect.  Move to ignore if it is fixed.
    Look at each regression in state stage. Move to verify if fixed.
    Look at regressions in detect, do they match our policy? If no, move to
    NTBF.
    """
    logger.info("Running regression evolution")

    # Clear the cache before we start.
    ts.machine_to_latest_order_cache = {}
    changed = 0
    evolve_states = [RegressionState.DETECTED, RegressionState.STAGED,
                     RegressionState.ACTIVE]
    regressions = session.query(ts.Regression) \
        .filter(ts.Regression.state.in_(evolve_states)) \
        .all()

    detects = [r for r in regressions if r.state == RegressionState.DETECTED]
    staged = [r for r in regressions if r.state == RegressionState.STAGED]
    active = [r for r in regressions if r.state == RegressionState.ACTIVE]

    # Remove the oldest detected regressions if needed.
    num_regression_to_keep = 50
    if len(detects) > num_regression_to_keep:
        changed += age_out_oldest_regressions(session, ts, num_regression_to_keep)

    for regression in detects:
        if impacts(session, ts, run_id, regression) and is_fixed(session, ts, regression):
            logger.info("Detected fixed regression" + str(regression))
            regression.state = RegressionState.IGNORED
            regression.title = regression.title + " [Detected Fixed]"
            changed += 1

    for regression in staged:
        if impacts(session, ts, run_id, regression) and is_fixed(session, ts, regression):
            logger.info("Staged fixed regression" + str(regression))
            regression.state = RegressionState.DETECTED_FIXED
            regression.title = regression.title + " [Detected Fixed]"
            changed += 1

    for regression in active:
        if impacts(session, ts, run_id, regression) and is_fixed(session, ts, regression):
            logger.info("Active fixed regression" + str(regression))
            regression.state = RegressionState.DETECTED_FIXED
            regression.title = regression.title + " [Detected Fixed]"
            changed += 1

    session.commit()
    logger.info("Changed the state of {} regressions".format(changed))


post_submission_hook = regression_evolution

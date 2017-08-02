"""Check if a regression is fixed, and move to differnt sate.
Detcted + fixed -> Ignored
Staged or Active + fixed -> Verify
"""
from lnt.server.db.regression import RegressionState
from lnt.server.db.regression import get_cr_for_field_change, get_ris
from lnt.util import logger
from lnt.testing.util.commands import timed


def _fixed_rind(ts, rind):
    """Is this regression indicator fixed?"""
    fc = rind.field_change
    if fc is None:
        return False
    current_cr, _, _ = get_cr_for_field_change(ts, fc, current=True)
    if current_cr.pct_delta < 0.01:
        return True
    else:
        return False


def is_fixed(ts, regression):
    """Comparing the current value to the regression, is this regression now
    fixed?
    """
    r_inds = get_ris(ts, regression.id)
    fixes = [_fixed_rind(ts, x) for x in r_inds]
    return all(fixes)


@timed
def regression_evolution(ts, run_id):
    """Analyse regressions. If they have changes, process them.
    Look at each regression in state detect.  Move to ignore if it is fixed.
    Look at each regression in state stage. Move to verify if fixed.
    Look at regressions in detect, do they match our policy? If no, move to
    NTBF.
    """
    logger.info("Running regression evolution")
    changed = 0
    evolve_states = [RegressionState.DETECTED, RegressionState.STAGED,
                     RegressionState.ACTIVE]
    regressions = ts.query(ts.Regression) \
        .filter(ts.Regression.state.in_(evolve_states)) \
        .all()

    detects = [r for r in regressions if r.state == RegressionState.DETECTED]
    staged = [r for r in regressions if r.state == RegressionState.STAGED]
    active = [r for r in regressions if r.state == RegressionState.ACTIVE]

    for regression in detects:
        if is_fixed(ts, regression):
            logger.info("Detected fixed regression" + str(regression))
            regression.state = RegressionState.IGNORED
            regression.title = regression.title + " [Detected Fixed]"
            changed += 1

    for regression in staged:
        if is_fixed(ts, regression):
            logger.info("Staged fixed regression" + str(regression))
            regression.state = RegressionState.DETECTED_FIXED
            regression.title = regression.title + " [Detected Fixed]"
            changed += 1

    for regression in active:
        if is_fixed(ts, regression):
            logger.info("Active fixed regression" + str(regression))
            regression.state = RegressionState.DETECTED_FIXED
            regression.title = regression.title + " [Detected Fixed]"
            changed += 1
    ts.commit()
    logger.info("Changed the state of {} regressions".format(changed))

post_submission_hook = regression_evolution

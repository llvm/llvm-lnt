"""Check if a regression is fixed, and move to differnt sate.
Detcted + fixed -> Ignored
Staged or Active + fixed -> Verify
"""
from lnt.server.ui.regression_views import RegressionState
from lnt.server.ui.regression_views import get_cr_for_field_change, get_ris
from lnt.testing.util.commands import note

def _fixed_rind(ts, rind):
    """Is this regression indicator fixed?"""
    fc = rind.field_change
    if fc is None:
        return False
    current_cr, _ = get_cr_for_field_change(ts, fc, current=True)
    if current_cr.pct_delta < 0.01:
        return True
    else:
        return False

def is_fixed(ts, regression):
    """Comparing the current value to the regression, is this regression now
    fixed?
    """
    r_inds = get_ris(ts, regression)
    changes = [r.field_change for r in r_inds]
    fixes = [_fixed_rind(ts, x) for x in changes]
    return all(fixes)



def regression_evolution(ts, regressions):
    """Analyse regressions. If they have changes, process them.
    Look at each regression in state detect.  Move to ignore if it is fixed.
    Look at each regression in state stage. Move to verify if fixed.
    Look at regressions in detect, do they match our policy? If no, move to NTBF.

    """
    note("Running regression evolution")
    detects = [r for r in regressions if r.state == RegressionState.DETECTED]
    
    for regression in detects:
        if is_fixed(ts, regression):
            note("Detected fixed regression" + str(regression))
            regression.state = RegressionState.IGNORED
            regression.title = regression.title + " [Detected Fixed]"
    ts.commit()

    staged = [r for r in regressions if r.state == RegressionState.STAGED]
    
    for regression in staged:
        if is_fixed(ts, regression):
            note("Staged fixed regression" + str(regression))
            regression.state = RegressionState.DETECTED_FIXED
            regression.title = regression.title + " [Detected Fixed]"
    ts.commit()
    
    active = [r for r in regressions if r.state == RegressionState.ACTIVE]
    
    for regression in active:
        if is_fixed(ts, regression):
            note("Active fixed regression" + str(regression))
            regression.state = RegressionState.DETECTED_FIXED
            regression.title = regression.title + " [Detected Fixed]"
    ts.commit()
    
post_submission_hook = regression_evolution

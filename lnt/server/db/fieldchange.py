
import sqlalchemy.sql

import lnt.server.reporting.analysis
from lnt.testing.util.commands import warning

def regenerate_fieldchanges_for_run(ts, run):
    """Regenerate the set of FieldChange objects for the given run.
    """
    
    # Allow for potentially a few different runs, previous_runs, next_runs
    # all with the same order_id which we will aggregate together to make
    # our comparison result.
    runs = ts.query(ts.Run).filter(ts.Run.order_id == run.order_id).all()
    previous_runs = ts.get_previous_runs_on_machine(run, 1)
    next_runs = ts.get_next_runs_on_machine(run, 1)
    
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
    runs_to_load = [r.id for r in (runs + previous_runs + next_runs)]

    # When the same rev is submitted many times, the database accesses here
    # can be huge, and it is almost always an error to have the same rev
    # be used in so many runs.
    run_size = len(runs_to_load)
    if run_size > 50:
        warning("Generating field changes for {} runs."
                "That will be very slow.".format(run_size))

    runinfo = lnt.server.reporting.analysis.RunInfo(ts, runs_to_load)
        
    for field in list(ts.sample_fields):
        for test_id in runinfo.test_ids:
            result = runinfo.get_comparison_result(runs, previous_runs,
                                                   test_id, field)
            if result.is_result_interesting():
                f = ts.FieldChange(start_order=start_order,
                                   end_order=run.order,
                                   test=None,
                                   machine=run.machine,
                                   field=field)
                f.test_id = test_id
                ts.add(f)
            
            result = runinfo.get_comparison_result(runs, next_runs,
                                                   test_id, field)
            if result.is_result_interesting():
                f = ts.FieldChange(start_order=run.order,
                                   end_order=end_order,
                                   test=None,
                                   machine=run.machine,
                                   field=field)
                f.test_id = test_id
                ts.add(f)


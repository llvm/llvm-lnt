"""Asynchrounus operations for LNT.

For big tasks it is nice to be able to run in the backgorund.  This module
contains wrappers to run particular LNT tasks in subprocesess. 

Because multiprocessing cannot directly use the LNT test-suite objects in
subprocesses (because they are not serializable because they don't have a fix
package in the system, but are generated on program load) we recreate the test
suite that we need inside each subprocess before we execute the work job.
"""
import logging
from flask import current_app
import sys
import lnt.server.db.fieldchange as fieldchange
import lnt.server.db.v4db
import traceback
import multiprocessing
from multiprocessing import Pool

NUM_WORKERS = 2  # The number of subprocesses to spawn per LNT process.
WORKERS = None  # The worker pool.


def launch_workers():
    """Make sure we have a worker pool ready to queue."""
    global WORKERS
    if not WORKERS:
        logger = multiprocessing.log_to_stderr()
        logger.setLevel(logging.INFO)
        WORKERS = Pool(NUM_WORKERS)


def async_fieldchange_calc(ts, run):
    """Run regenerate field changes in the background."""
    func_args = {'run_id': run.id}
    #  Make sure this run is in the database!
    ts.commit()
    async_run_job(fieldchange.regenerate_fieldchanges_for_run,
                  ts,
                  func_args)


def async_run_job(job, ts, func_args):
    """Send a job to the async wrapper in the subprocess."""
    # If the run is not in the database, we can't do anything more.
    print "Queuing background job to process fieldchanges"
    args = {'tsname': ts.name,
            'db': ts.v4db.settings()}
    launch_workers()
    job = WORKERS.apply_async(async_wrapper, [job, args, func_args])


def async_wrapper(job, ts_args, func_args):
    """Setup test-suite in this subprocess and run something."""
    try:
        print >> sys.stderr, "Running async wrapper"
        logging.info(str(job))
        _v4db = lnt.server.db.v4db.V4DB(**ts_args['db'])
        ts = _v4db.testsuite[ts_args['tsname']]
        logging.info("Calculating field changes for ")
        job(ts, **func_args)
        logging.info("Done calculating field changes")
    except:
        # Put all exception text into an exception and raise that for our
        # parent process.
        raise Exception("".join(traceback.format_exception(*sys.exc_info())))

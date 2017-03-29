"""Asynchrounus operations for LNT.

For big tasks it is nice to be able to run in the backgorund.  This module
contains wrappers to run particular LNT tasks in subprocesess. 

Because multiprocessing cannot directly use the LNT test-suite objects in
subprocesses (because they are not serializable because they don't have a fix
package in the system, but are generated on program load) we recreate the test
suite that we need inside each subprocess before we execute the work job.
"""
import atexit
import os
import time
import logging
from flask import current_app, g
import sys
import lnt.server.db.fieldchange as fieldchange
import lnt.server.db.v4db
import traceback
import signal
from time import sleep
import contextlib
import multiprocessing
from multiprocessing import Pool, TimeoutError, Manager, Process
from threading import Lock
from lnt.testing.util.commands import note, warning, timed, error
NUM_WORKERS = 4  # The number of subprocesses to spawn per LNT process.
WORKERS = None  # The worker pool.

JOBS = []


def launch_workers():
    """Make sure we have a worker pool ready to queue."""
    global WORKERS
    if not WORKERS:
        note("Starting workers")
        manager = Manager()
        try:
            current_app.config['mem_logger'].buffer = \
                manager.list(current_app.config['mem_logger'].buffer)
        except RuntimeError:
            #  It might be the case that we are not running in the app.
            #  In this case, don't bother memory logging, stdout should
            #  sufficient for console mode.
            pass


def sigHandler(signo, frame):
    sys.exit(0)


def cleanup():
    note("Running process cleanup.")
    for p in JOBS:
        note("Waiting for %s %s" % (p.name, p.pid))
        if p.is_alive:
            p.join()


atexit.register(cleanup)
signal.signal(signal.SIGTERM, sigHandler)


def async_fieldchange_calc(db_name, ts, run):
    """Run regenerate field changes in the background."""
    func_args = {'run_id': run.id}
    #  Make sure this run is in the database!
    async_run_job(fieldchange.post_submit_tasks,
                  db_name, ts,
                  func_args)


def check_workers(is_logged):
    global JOBS
    JOBS = [x for x in JOBS if x.is_alive()]
    still_running = len(JOBS)
    msg = "{} Job(s) in the queue.".format(still_running)
    if is_logged:
        if still_running > 5:
            # This could be run outside of the application context, so use
            # full logger name.
            logging.getLogger("lnt.server.ui.app").warning(msg)
        elif still_running > 0:
            logging.getLogger("lnt.server.ui.app").info(msg)
        else:
            logging.getLogger("lnt.server.ui.app").info("Job queue empty.")
    return len(JOBS)


def async_run_job(job, db_name, ts, func_args):
    """Send a job to the async wrapper in the subprocess."""
    # If the run is not in the database, we can't do anything more.
    note("Queuing background job to process fieldchanges " + str(os.getpid()))
    launch_workers()
    check_workers(True)

    args = {'tsname': ts.name,
            'db': db_name}
    job = Process(target=async_wrapper,
                  args=[job, args, func_args])

    # Set this to make sure when parent dies, children are killed.
    job.daemon = True

    job.start()
    JOBS.append(job)

# Flag to track if we have disposed of the parents database connections in
# this subprocess.
clean_db = False

def async_wrapper(job, ts_args, func_args):
    """Setup test-suite in this subprocess and run something.
    
    Because of multipocessing, capture excptions and log messages,
    and return them.
    """
    global clean_db
    try:
        start_time = time.time()
        
        if not clean_db:
            lnt.server.db.v4db.V4DB.close_all_engines()
            clean_db = True
        sleep(3)
        note("Running async wrapper: {} ".format(job.__name__)+ str(os.getpid()))

        _v4db = current_app.old_config.get_database(ts_args['db'])
        #with contextlib.closing(_v4db) as db:
        ts = _v4db.testsuite[ts_args['tsname']]
        nothing = job(ts, **func_args)
        assert nothing is None
        end_time = time.time()
        delta = end_time-start_time
        msg = "Finished: {name} in {time:.2f}s ".format(name=job.__name__,
                                                time=delta)
        if delta < 100:
            note(msg)
        else:
            warning(msg)
    except:
        # Put all exception text into an exception and raise that for our
        # parent process.
        error("Subprocess failed with:" + "".join(traceback.format_exception(*sys.exc_info())))
        sys.exit(1)
    sys.exit(0)


def make_callback():
    app = current_app
    def async_job_finished(arg):
        if isinstance(arg, Exception):
            logging.getLogger("lnt.server.ui.app").error(str(arg))
            raise arg
        if isinstance(arg, list):
            for log_entry in arg:
                logging.getLogger("lnt.server.ui.app").handle(log_entry)
        check_workers()
    return async_job_finished

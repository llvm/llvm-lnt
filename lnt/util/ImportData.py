from lnt.util import NTEmailReport
from lnt.util import async_ops
from lnt.util import logger
import collections
import datetime
import lnt.formats
import lnt.server.reporting.analysis
import lnt.testing
import os
import re
import tempfile
import time

def import_and_report(config, db_name, db, file, format, ts_name,
                      commit=False, show_sample_count=False,
                      disable_email=False, disable_report=False):
    """
    import_and_report(config, db_name, db, file, format, ts_name,
                      [commit], [show_sample_count],
                      [disable_email]) -> ... object ...

    Import a test data file into an LNT server and generate a test report. On
    success, run is the newly imported run. Note that success is uneffected by
    the value of commit, this merely changes whether the run (on success) is
    committed to the database.

    The result object is a dictionary containing information on the imported run
    and its comparison to the previous run.
    """
    result = {
        'success': False,
        'error': None,
        'import_file': file,
    }

    ts = db.testsuite.get(ts_name)
    if ts is None:
        result['error'] = "Unknown test suite '%s'!" % ts_name
        return result
    numMachines = ts.getNumMachines()
    numRuns = ts.getNumRuns()
    numTests = ts.getNumTests()

    # If the database gets fragmented, count(*) in SQLite can get really slow!?!
    if show_sample_count:
        numSamples = ts.getNumSamples()

    startTime = time.time()
    try:
        data = lnt.formats.read_any(file, format)
    except KeyboardInterrupt:
        raise
    except:
        import traceback
        result['error'] = "could not parse input format"
        result['message'] = traceback.format_exc()
        return result

    result['load_time'] = time.time() - startTime

    # Auto-upgrade the data, if necessary.
    data = lnt.testing.upgrade_report(data, ts_name)

    # Find the database config, if we have a configuration object.
    if config:
        db_config = config.databases[db_name]
    else:
        db_config = None

    # Find the email address for this machine's results.
    toAddress = email_config = None
    if db_config and not disable_email:
        email_config = db_config.email_config
        if email_config.enabled:
            # Find the machine name.
            machineName = str(data.get('Machine',{}).get('Name'))
            toAddress = email_config.get_to_address(machineName)
            if toAddress is None:
                result['error'] = ("unable to match machine name "
                                   "for test results email address!")
                return result

    importStartTime = time.time()
    try:
        data_schema = data.get('schema')
        if data_schema is not None and data_schema != ts_name:
            result['error'] = ("Importing '%s' data into test suite '%s'" %
                               (data_schema, ts_name))
            return result

        success, run = ts.importDataFromDict(data, commit, config=db_config)
    except KeyboardInterrupt:
        raise
    except Exception as e:
        import traceback
        result['error'] = "import failure: %s" % e.message
        result['message'] = traceback.format_exc()
        return result

    # If the import succeeded, save the import path.
    run.imported_from = file

    result['import_time'] = time.time() - importStartTime
    if not success:
        # Record the original run this is a duplicate of.
        result['original_run'] = run.id

    reportStartTime = time.time()
    result['report_to_address'] = toAddress
    if config:
        report_url = "%s/db_%s/" % (config.zorgURL, db_name)
    else:
        report_url = "localhost"

    if not disable_report:
        #  This has the side effect of building the run report for
        #  this result.
        NTEmailReport.emailReport(result, db, run, report_url, email_config,
                                  toAddress, success)

    result['added_machines'] = ts.getNumMachines() - numMachines
    result['added_runs'] = ts.getNumRuns() - numRuns
    result['added_tests'] = ts.getNumTests() - numTests
    if show_sample_count:
        result['added_samples'] = ts.getNumSamples() - numSamples

    result['committed'] = commit
    result['run_id'] = run.id
    if commit:
        ts.commit()
        if db_config:
            #  If we are not in a dummy instance, also run background jobs.
            #  We have to have a commit before we run, so subprocesses can
            #  see the submitted data.
            async_ops.async_fieldchange_calc(db_name, ts, run, config)

    else:
        ts.rollback()
    # Add a handy relative link to the submitted run.

    result['result_url'] = "db_{}/v4/{}/{}".format(db_name, ts_name, run.id)
    result['report_time'] = time.time() - importStartTime
    result['total_time'] = time.time() - startTime
    logger.info("Successfully created {}".format(result['result_url']))
    # If this database has a shadow import configured, import the run into that
    # database as well.
    if config and config.databases[db_name].shadow_import:
        # Load the shadow database to import into.
        db_config = config.databases[db_name]
        shadow_name = db_config.shadow_import
        with closing(config.get_database(shadow_name)) as shadow_db:
            if shadow_db is None:
                raise ValueError, ("invalid configuration, shadow import "
                                   "database %r does not exist") % shadow_name

            # Perform the shadow import.
            shadow_result = import_and_report(config, shadow_name,
                                              shadow_db, file, format, ts_name,
                                              commit, show_sample_count,
                                              disable_email, disable_report)

            # Append the shadow result to the result.
            result['shadow_result'] = shadow_result

    result['success'] = True
    return result

def print_report_result(result, out, err, verbose = True):
    """
    print_report_result(result, out, [err], [verbose]) -> None

    Print a human readable form of an import result object to the given output
    stream. Test results are printed in 'lit' format.
    """

    # Print the generic import information.
    print >>out, "Importing %r" % os.path.basename(result['import_file'])
    if result['success']:
        print >>out, "Import succeeded."
        print >>out
    else:
        out.flush()
        print >>err, "Import Failed:"
        print >>err, "--\n%s--\n" % result['error']
        if result['message']:
            print >>err, "%s\n" % result['message']
        err.flush()
        return
        
    # Print the test results.
    test_results = result.get('test_results')
    if not test_results:
        return

    # List the parameter sets, if interesting.
    show_pset = len(test_results) > 1
    if show_pset:
        print >>out, "Parameter Sets"
        print >>out, "--------------"
        for i,info in enumerate(test_results):
            print >>out, "P%d: %s" % (i, info['pset'])
        print >>out

    total_num_tests = sum([len(item['results'])
                           for item in test_results])
    print >>out, "--- Tested: %d tests --" % total_num_tests
    test_index = 0
    result_kinds = collections.Counter()
    for i,item in enumerate(test_results):
        pset = item['pset']
        pset_results = item['results']

        for name,test_status,perf_status in pset_results:
            test_index += 1
            # FIXME: Show extended information for performance changes, previous
            # samples, standard deviation, all that.
            #
            # FIXME: Think longer about mapping to test codes.
            result_info = None
            
            if test_status == lnt.server.reporting.analysis.REGRESSED:
                result_string = 'FAIL'
            elif test_status == lnt.server.reporting.analysis.UNCHANGED_FAIL:
                result_string = 'FAIL'
            elif test_status == lnt.server.reporting.analysis.IMPROVED:
                result_string = 'IMPROVED'
                result_info = "Test started passing."
            elif perf_status == None:
                # Missing perf status means test was just added or removed.
                result_string = 'PASS'
            elif perf_status == lnt.server.reporting.analysis.REGRESSED:
                result_string = 'REGRESSED'
                result_info = 'Performance regressed.'
            elif perf_status == lnt.server.reporting.analysis.IMPROVED:
                result_string = 'IMPROVED'
                result_info = 'Performance improved.'
            else:
                result_string = 'PASS'
            result_kinds[result_string] += 1
            # Ignore passes unless in verbose mode.
            if not verbose and result_string == 'PASS':
                continue

            if show_pset:
                name = 'P%d :: %s' % (i, name)
            print >>out, "%s: %s (%d of %d)" % (result_string, name, test_index,
                                                total_num_tests)

            if result_info:
                print >>out, "%s TEST '%s' %s" % ('*'*20, name, '*'*20)
                print >>out, result_info
                print >>out, "*" * 20

    if 'original_run' in result:
        print >>out, ("This submission is a duplicate of run %d, "
                      "already in the database.") % result['original_run']
        print >>out

    if not result['committed']:
        print >>out, "NOTE: This run was not committed!"
        print >>out

    if result['report_to_address']:
        print >>out, "Report emailed to: %r" % result['report_to_address']
        print >>out

    # Print the processing times.
    print >>out, "Processing Times"
    print >>out, "----------------"
    print >>out, "Load   : %.2fs" % result['load_time']
    print >>out, "Import : %.2fs" % result['import_time']
    print >>out, "Report : %.2fs" % result['report_time']
    print >>out, "Total  : %.2fs" % result['total_time']
    print >>out

    # Print the added database items.
    total_added = (result['added_machines'] + result['added_runs'] +
                   result['added_tests'] + result.get('added_samples', 0))
    if total_added:
        print >>out, "Imported Data"
        print >>out, "-------------"
        if result['added_machines']:
            print >>out, "Added Machines: %d" % result['added_machines']
        if result['added_runs']:
            print >>out, "Added Runs    : %d" % result['added_runs']
        if result['added_tests']:
            print >>out, "Added Tests   : %d" % result['added_tests']
        if result.get('added_samples', 0):
            print >>out, "Added Samples : %d" % result['added_samples']
        print >>out
    print >>out, "Results"
    print >>out, "----------------"
    for kind, count in result_kinds.items():
        print >>out, kind, ":", count


def import_from_string(config, db_name, db, ts_name, data, commit=True):
    # Stash a copy of the raw submission.
    #
    # To keep the temporary directory organized, we keep files in
    # subdirectories organized by (database, year-month).
    utcnow = datetime.datetime.utcnow()
    tmpdir = os.path.join(config.tempDir, db_name,
                          "%04d-%02d" % (utcnow.year, utcnow.month))
    try:
        os.makedirs(tmpdir)
    except OSError,e:
        pass

    # Save the file under a name prefixed with the date, to make it easier
    # to use these files in cases we might need them for debugging or data
    # recovery.
    prefix = utcnow.strftime("data-%Y-%m-%d_%H-%M-%S")
    fd,path = tempfile.mkstemp(prefix=prefix, suffix='.json',
                               dir=str(tmpdir))
    os.write(fd, data)
    os.close(fd)

    # Import the data.
    #
    # FIXME: Gracefully handle formats failures and DOS attempts. We
    # should at least reject overly large inputs.

    result = lnt.util.ImportData.import_and_report(config, db_name, db,
            path, '<auto>', ts_name, commit)
    return result

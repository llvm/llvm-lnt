"""Submission of the report of `lnt runtest test-suite` to an LNT server.

The report is posted to the server's `submitRun` endpoint, and the server's
answer is printed with the test results in 'lit' format, as this command has
always printed it.
"""
import collections
import json
import os
import ssl
import sys
import traceback
import urllib.error
import urllib.parse
import urllib.request

import certifi

# How the server compares a test with the previous run, in its answer.
REGRESSED = 'REGRESSED'
IMPROVED = 'IMPROVED'
UNCHANGED_FAIL = 'UNCHANGED_FAIL'


def submit(url, report_path, select_machine, merge, verbose):
    """Submit the report at report_path to the submitRun URL of an LNT server,
    and print the server's answer. A failure is printed, not raised."""
    result = _post(url, report_path, select_machine, merge)
    if result:
        _print_result(result, verbose)
        if result.get('result_url') is not None:
            print("Results available at:", result['result_url'])


def _post(url, report_path, select_machine, merge):
    """Post the report, and return the server's answer, or None if there is
    none to print (in which case why is printed instead)."""
    with open(report_path, 'rb') as f:
        values = {
            'input_data': f.read(),
            'commit': "1",  # compatibility with old servers.
            'select_machine': select_machine,
            'merge': merge,
        }
    headers = {'Accept': 'application/json'}
    data = urllib.parse.urlencode(values).encode(encoding='ascii')
    try:
        context = ssl.create_default_context(cafile=certifi.where())
        response = urllib.request.urlopen(
            urllib.request.Request(url, data, headers=headers),
            context=context)
    except urllib.error.HTTPError as e:
        _show_json_error(e.read())
        return None
    except urllib.error.URLError as e:
        sys.stderr.write("error: could not resolve '%s': %s\n" % (url, e))
        return None
    result_data = response.read()

    # The result is expected to be a JSON object.
    try:
        return json.loads(result_data)
    except Exception:
        print("Unable to load result, not a valid JSON object.")
        print()
        print("Traceback:")
        traceback.print_exc()
        print()
        print("Result:")
        print("error:", result_data)
        return None


def _show_json_error(reply):
    """Print the error a server answered with: the error and message of a JSON
    answer to stderr, or else the answer itself, as bytes, to stdout."""
    try:
        error = json.loads(reply)
    except ValueError:
        print("error: {}".format(reply))
        return
    sys.stderr.write("error: lnt server: {}\n".format(error.get('error')))
    message = error.get('message', '')
    if message:
        sys.stderr.write(message + '\n')


def _print_result(result, verbose):
    """Print the server's answer to a submission, with the test results in
    'lit' format."""
    out, err = sys.stdout, sys.stderr

    # Print the generic import information.
    if 'import_file' in result:
        print("Importing %r" % os.path.basename(result['import_file']), file=out)
    if result['success']:
        print("Import succeeded.", file=out)
        print(file=out)
    else:
        out.flush()
        print("Import Failed:", file=err)
        print("%s\n" % result['error'], file=err)
        message = result.get('message', None)
        if message:
            print("%s\n" % message, file=err)
        print("--------------", file=err)
        err.flush()
        return

    # Print the test results.
    test_results = result.get('test_results')
    if not test_results:
        return

    # List the parameter sets, if interesting.
    show_pset = len(test_results) > 1
    if show_pset:
        print("Parameter Sets", file=out)
        print("--------------", file=out)
        for i, info in enumerate(test_results):
            print("P%d: %s" % (i, info['pset']), file=out)
        print(file=out)

    total_num_tests = sum([len(item['results'])
                           for item in test_results])
    print("--- Tested: %d tests --" % total_num_tests, file=out)
    test_index = 0
    result_kinds = collections.Counter()
    for i, item in enumerate(test_results):
        pset_results = item['results']

        for name, test_status, perf_status in pset_results:
            test_index += 1
            # FIXME: Show extended information for performance changes,
            # previous samples, standard deviation, all that.
            #
            # FIXME: Think longer about mapping to test codes.
            result_info = None

            if test_status == REGRESSED:
                result_string = 'FAIL'
            elif test_status == UNCHANGED_FAIL:
                result_string = 'FAIL'
            elif test_status == IMPROVED:
                result_string = 'IMPROVED'
                result_info = "Test started passing."
            elif perf_status is None:
                # Missing perf status means test was just added or removed.
                result_string = 'PASS'
            elif perf_status == REGRESSED:
                result_string = 'REGRESSED'
                result_info = 'Performance regressed.'
            elif perf_status == IMPROVED:
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
            print("%s: %s (%d of %d)" % (result_string, name,
                                         test_index, total_num_tests), file=out)

            if result_info:
                print("%s TEST '%s' %s" % ('*'*20, name, '*'*20), file=out)
                print(result_info, file=out)
                print("*" * 20, file=out)

    if 'original_run' in result:
        print(("This submission is a duplicate of run %d, "
               "already in the database.") % result['original_run'], file=out)
        print(file=out)

    if result['report_to_address']:
        print("Report emailed to: %r" % result['report_to_address'], file=out)
        print(file=out)

    # Print the processing times.
    print("Processing Times", file=out)
    print("----------------", file=out)
    print("Load   : %.2fs" % result['load_time'], file=out)
    print("Import : %.2fs" % result['import_time'], file=out)
    print("Report : %.2fs" % result['report_time'], file=out)
    print("Total  : %.2fs" % result['total_time'], file=out)
    print(file=out)

    # Print the added database items.
    total_added = (result['added_machines'] + result['added_runs'] +
                   result['added_tests'] + result.get('added_samples', 0))
    if total_added:
        print("Imported Data", file=out)
        print("-------------", file=out)
        if result['added_machines']:
            print("Added Machines: %d" % result['added_machines'], file=out)
        if result['added_runs']:
            print("Added Runs    : %d" % result['added_runs'], file=out)
        if result['added_tests']:
            print("Added Tests   : %d" % result['added_tests'], file=out)
        if result.get('added_samples', 0):
            print("Added Samples : %d" % result['added_samples'], file=out)
        print(file=out)
    print("Results", file=out)
    print("----------------", file=out)
    for kind, count in result_kinds.items():
        print(kind, ":", count, file=out)

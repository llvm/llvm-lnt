"""
Report functionality centered around individual runs.
"""

import StringIO
import os
import time
import urllib

import lnt.server.reporting.analysis
import lnt.server.ui.app
import lnt.util.stats

def generate_run_report(run, baseurl, only_html_body = False,
                        num_comparison_runs = 10, result = None,
                        compare_to = None, baseline = None,
                        comparison_window = None, aggregation_fn = min,
                        confidence_lv = .5):
    """
    generate_run_report(...) -> (str: subject, str: text_report,
                                 str: html_report)

    Generate a comprehensive report on the results of the given individual
    run, suitable for emailing or presentation on a web page.
    """

    assert num_comparison_runs > 0

    start_time = time.time()

    ts = run.testsuite
    machine = run.machine
    machine_parameters = machine.parameters
    
    if baseline is None:
        # If a baseline has not been given, look up the run closest to
        # the default baseline revision for which this machine also
        # reported.
        baseline = machine.get_baseline_run()
    
    # If the baseline is the same as the comparison run, ignore it.
    if baseline is compare_to:
        baseline = None

    # Gather the runs to use for statistical data.
    if comparison_window is None:
        comparison_start_run = compare_to or run
        comparison_window = list(ts.get_previous_runs_on_machine(
                comparison_start_run, num_comparison_runs))
    if baseline:
        baseline_window = list(ts.get_previous_runs_on_machine(
                baseline, num_comparison_runs))
    else:
        baseline_window = []

    # If we don't have an explicit baseline run or a comparison run, use the
    # previous run.
    if compare_to is None and comparison_window:
        compare_to = comparison_window[0]

    # Create the run info analysis object.
    runs_to_load = set(r.id for r in comparison_window)
    for r in baseline_window:
        runs_to_load.add(r.id)
    runs_to_load.add(run.id)
    if compare_to:
        runs_to_load.add(compare_to.id)
    if baseline:
        runs_to_load.add(baseline.id)
    sri = lnt.server.reporting.analysis.RunInfo(
        ts, runs_to_load, aggregation_fn, confidence_lv)

    # Get the test names, primary fields and total test counts.
    test_names = ts.query(ts.Test.name, ts.Test.id).\
        order_by(ts.Test.name).\
        filter(ts.Test.id.in_(sri.get_test_ids())).all()
    primary_fields = list(ts.Sample.get_primary_fields())
    num_total_tests = len(primary_fields) * len(test_names)

    # Gather the run-over-run changes to report, organized by field and then
    # collated by change type.
    run_to_run_info, test_results = _get_changes_by_type(
        run, compare_to, primary_fields, test_names, comparison_window, sri)

    # If we have a baseline, gather the run-over-baseline results and
    # changes.
    if baseline:
        run_to_baseline_info, baselined_results = _get_changes_by_type(
            run, baseline, primary_fields, test_names, baseline_window, sri)
    else:
        run_to_baseline_info = baselined_results = None

    # Gather the run-over-run changes to report.

    # Collect the simplified results, if desired, for sending back to clients.
    if result is not None:
        pset_results = []
        result['test_results'] = [{ 'pset' : (), 'results' : pset_results}]
        for field,field_results in test_results:
            for _,bucket,_ in field_results:
                for name,cr,_ in bucket:
                    # FIXME: Include additional information about performance
                    # changes.
                    pset_results.append(("%s.%s" % (name, field.name),
                                         cr.get_test_status(),
                                         cr.get_value_status()))

    # Aggregate counts across all bucket types for our num item
    # display
    def aggregate_counts_across_all_bucket_types(i, name):
        num_items = sum(len(field_results[i][1])
                        for _,field_results in test_results)
        if baseline:
            num_items_vs_baseline = sum(
                len(field_results[i][1])
                for _,field_results in baselined_results)
        else:
            num_items_vs_baseline = None

        return i, name, num_items, num_items_vs_baseline

    num_item_buckets = [aggregate_counts_across_all_bucket_types(x[0], x[1][0])\
                            for x in enumerate(test_results[0][1])]

    def maybe_sort_bucket(bucket, bucket_name, show_perf):
        if not bucket or bucket_name == 'Unchanged Test' or not show_perf:
            return bucket
        else:
            return sorted(bucket, key=lambda (_,cr,__): -abs(cr.pct_delta))
    def prioritize_buckets(test_results):
        prioritized = [(priority, field, bucket_name, maybe_sort_bucket(bucket, bucket_name, show_perf),
                        [name for name, _, __ in bucket], show_perf)
                       for field,field_results in test_results
                       for priority,(bucket_name, bucket,
                                     show_perf) in enumerate(field_results)]
        prioritized.sort(key = lambda item: (item[0], item[1].name))
        return prioritized

    # Generate prioritized buckets for run over run and run over baseline data.
    prioritized_buckets_run_over_run = prioritize_buckets(test_results)
    if baseline:
        prioritized_buckets_run_over_baseline = prioritize_buckets(baselined_results)
    else:
        prioritized_buckets_run_over_baseline = None
    
    # Prepare auxillary variables for rendering.
    # Create Subject
    subject = """%s test results""" % (machine.name,)

    # Define URLS.
    if baseurl[-1] == '/':
        baseurl = baseurl[:-1]
    ts_url = """%s/v4/%s""" % (baseurl, ts.name)
    run_url = """%s/%d""" % (ts_url, run.id)
    report_url = run_url
    url_fields = []
    if compare_to:
        url_fields.append(('compare_to', str(compare_to.id)))
    if baseline:
        url_fields.append(('baseline', str(baseline.id)))
    report_url = "%s?%s" % (run_url, "&".join("%s=%s" % (k,v)
                                              for k,v in url_fields))

    # Compute static CSS styles for elemenets. We use the style directly on
    # elements instead of via a stylesheet to support major email clients (like
    # Gmail) which can't deal with embedded style sheets.
    #
    # These are derived from the static style.css file we use elsewhere.
    styles = {
        "body" : ("color:#000000; background-color:#ffffff; "
                  "font-family: Helvetica, sans-serif; font-size:9pt"),
        "h1" : ("font-size: 14pt"),
        "table" : "font-size:9pt; border-spacing: 0px; border: 1px solid black",
        "th" : (
            "background-color:#eee; color:#666666; font-weight: bold; "
            "cursor: default; text-align:center; font-weight: bold; "
            "font-family: Verdana; padding:5px; padding-left:8px"),
        "td" : "padding:5px; padding-left:8px",
        }

    # Create an environment for rendering the reports.
    env = lnt.server.ui.app.create_jinja_environment()

    # Generate reports.  The timing code here is a cludge and will
    # give enough accuracy for approximate timing estimates. I am
    # going to separate the text/html report in a later commit (so
    # that we can have more output types [i.e. json] if we need to)
    # and remove this. The time will then be generated separately and
    # correctly for each different template.
    text_template = env.get_template('reporting/runs.txt')
    text_report_start_time = time.time()
    text_report = text_template.render(
        report_url=report_url,
        machine=machine,
        machine_parameters=machine_parameters,
        run=run,
        compare_to=compare_to,
        baseline=baseline,
        num_item_buckets=num_item_buckets,
        num_total_tests=num_total_tests,
        prioritized_buckets_run_over_run=prioritized_buckets_run_over_run,
        prioritized_buckets_run_over_baseline=prioritized_buckets_run_over_baseline,
        start_time=start_time)
    text_report_delta = time.time() - text_report_start_time
    start_time = start_time + text_report_delta

    html_template = env.get_template('reporting/runs.html')
    html_report = html_template.render(
        ts=ts,
        subject=subject,
        only_html_body=only_html_body,
        report_url=report_url,
        ts_url=ts_url,
        compare_to=compare_to,
        run=run,
        run_url=run_url,
        baseline=baseline,
        num_item_buckets=num_item_buckets,
        num_total_tests=num_total_tests,
        run_to_run_info=run_to_run_info,
        prioritized_buckets_run_over_run=prioritized_buckets_run_over_run,
        run_to_baseline_info=run_to_baseline_info,
        prioritized_buckets_run_over_baseline=prioritized_buckets_run_over_baseline,
        styles=styles,
        start_time=start_time)

    return subject, text_report, html_report, sri

def _get_changes_by_type(run_a, run_b, primary_fields, test_names,
                         comparison_window, sri):
    comparison_results = {}
    results_by_type = []
    for field in primary_fields:
        new_failures = []
        new_passes = []
        perf_regressions = []
        perf_improvements = []
        removed_tests = []
        added_tests = []
        existing_failures = []
        unchanged_tests = []
        for name,test_id in test_names:
            cr = sri.get_run_comparison_result(run_a, run_b, test_id, field,
                                               comparison_window)
            comparison_results[(name,field)] = cr
            test_status = cr.get_test_status()
            perf_status = cr.get_value_status()
            if test_status == lnt.server.reporting.analysis.REGRESSED:
                bucket = new_failures
            elif test_status == lnt.server.reporting.analysis.IMPROVED:
                bucket = new_passes
            elif cr.current is None and cr.previous is not None:
                bucket = removed_tests
            elif cr.current is not None and cr.previous is None:
                bucket = added_tests
            elif test_status == lnt.server.reporting.analysis.UNCHANGED_FAIL:
                bucket = existing_failures
            elif perf_status == lnt.server.reporting.analysis.REGRESSED:
                bucket = perf_regressions
            elif perf_status == lnt.server.reporting.analysis.IMPROVED:
                bucket = perf_improvements
            else:
                bucket = unchanged_tests

            bucket.append((name, cr, test_id))

        results_by_type.append(
            (field, (('New Failures', new_failures, False),
                     ('New Passes', new_passes, False),
                     ('Performance Regressions', perf_regressions, True),
                     ('Performance Improvements', perf_improvements, True),
                     ('Removed Tests', removed_tests, False),
                     ('Added Tests', added_tests, False),
                     ('Existing Failures', existing_failures, False),
                     ('Unchanged Tests', unchanged_tests, False))))
    return comparison_results, results_by_type

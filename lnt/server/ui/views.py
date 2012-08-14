import datetime
import os
import re
import tempfile
import time

import flask
from flask import abort
from flask import current_app
from flask import g
from flask import make_response
from flask import redirect
from flask import render_template
from flask import request
from flask import url_for

import sqlalchemy.sql

import lnt.util
import lnt.util.ImportData
import lnt.util.stats
from lnt.server.ui.globals import db_url_for, v4_url_for
import lnt.server.reporting.analysis
import lnt.server.reporting.runs
from lnt.server.ui.decorators import frontend, db_route, v4_route
import lnt.server.ui.util

###
# Root-Only Routes

@frontend.route('/favicon.ico')
def favicon_ico():
    return redirect(url_for('.static', filename='favicon.ico'))

@frontend.route('/select_db')
def select_db():
    path = request.args.get('path')
    db = request.args.get('db')
    if path is None:
        abort(400)
    if db not in current_app.old_config.databases:
        abort(404)

    # Rewrite the path.
    new_path = "/db_%s" % db
    if not path.startswith("/db_"):
        new_path += path
    else:
        if '/' in path[1:]:
            new_path += "/" + path.split("/", 2)[2]
    return redirect(request.script_root + new_path)

#####
# Per-Database Routes

@db_route('/', only_v3 = False)
def index():
    return render_template("index.html")

###
# Database Actions

@db_route('/submitRun', only_v3=False, methods=('GET', 'POST'))
def submit_run():
    if request.method == 'POST':
        input_file = request.files.get('file')
        input_data = request.form.get('input_data')
        commit = int(request.form.get('commit', 0))

	if input_file and not input_file.content_length:
            input_file = None

        if not input_file and not input_data:
            return render_template(
                "submit_run.html", error="must provide input file or data")
        if input_file and input_data:
            return render_template(
                "submit_run.html", error="cannot provide input file *and* data")

        if input_file:
            data_value = input_file.read()
        else:
            data_value = input_data

        # Stash a copy of the raw submission.
        #
        # To keep the temporary directory organized, we keep files in
        # subdirectories organized by (database, year-month).
        utcnow = datetime.datetime.utcnow()
        tmpdir = os.path.join(current_app.old_config.tempDir, g.db_name,
                              "%04d-%02d" % (utcnow.year, utcnow.month))
        try:
            os.makedirs(tmpdir)
        except OSError,e:
            pass

        # Save the file under a name prefixed with the date, to make it easier
        # to use these files in cases we might need them for debugging or data
        # recovery.
        prefix = utcnow.strftime("data-%Y-%m-%d_%H-%M-%S")
        fd,path = tempfile.mkstemp(prefix=prefix, suffix='.plist',
                                   dir=str(tmpdir))
        os.write(fd, data_value)
        os.close(fd)

        # Get a DB connection.
        db = request.get_db()

        # Import the data.
        #
        # FIXME: Gracefully handle formats failures and DOS attempts. We
        # should at least reject overly large inputs.
        result = lnt.util.ImportData.import_and_report(
            current_app.old_config, g.db_name, db, path, '<auto>', commit)

        return flask.jsonify(**result)

    return render_template("submit_run.html")

###
# V4 Schema Viewer

@v4_route("/")
def v4_overview():
    ts = request.get_testsuite()

    # Get the most recent runs in this tag, we just arbitrarily limit to looking
    # at the last 100 submission.
    recent_runs = ts.query(ts.Run).\
        order_by(ts.Run.start_time.desc()).limit(100)
    recent_runs = list(recent_runs)

    # Compute the active machine list.
    active_machines = dict((run.machine.name, run)
                           for run in recent_runs[::-1])

    # Compute the active submission list.
    #
    # FIXME: Remove hard coded field use here.
    N = 30
    active_submissions = [(r, r.order.llvm_project_revision)
                          for r in recent_runs[:N]]

    return render_template("v4_overview.html",
                           testsuite_name=g.testsuite_name,
                           active_machines=active_machines,
                           active_submissions=active_submissions)

@v4_route("/machine/<int:id>")
def v4_machine(id):
    # Compute the list of associated runs, grouped by order.
    from lnt.server.ui import util

    # Gather all the runs on this machine.
    ts = request.get_testsuite()

    associated_runs = util.multidict(
        (run_order, r)
        for r,run_order in ts.query(ts.Run, ts.Order).\
            join(ts.Order).\
            filter(ts.Run.machine_id == id).\
            order_by(ts.Run.start_time.desc()))
    associated_runs = associated_runs.items()
    associated_runs.sort()

    return render_template("v4_machine.html",
                           testsuite_name=g.testsuite_name, id=id,
                           associated_runs=associated_runs)

class V4RequestInfo(object):
    def __init__(self, run_id, only_html_body=True):
        self.db = request.get_db()
        self.ts = ts = request.get_testsuite()
        self.run = run = ts.query(ts.Run).filter_by(id=run_id).first()
        if run is None:
            abort(404)

        # Get the aggregation function to use.
        aggregation_fn_name = request.args.get('aggregation_fn')
        self.aggregation_fn = { 'min' : min,
                                'median' : lnt.util.stats.median }.get(
            aggregation_fn_name, min)

        # Find the neighboring runs, by order.
        prev_runs = list(ts.get_previous_runs_on_machine(run, N = 3))
        next_runs = list(ts.get_next_runs_on_machine(run, N = 3))
        self.neighboring_runs = next_runs[::-1] + [self.run] + prev_runs

        # Select the comparison run as either the previous run, or a user
        # specified comparison run.
        compare_to_str = request.args.get('compare_to')
        if compare_to_str:
            compare_to_id = int(compare_to_str)
            self.compare_to = ts.query(ts.Run).\
                filter_by(id=compare_to_id).first()
            if self.compare_to is None:
                # FIXME: Need better way to report this error.
                abort(404)

            self.comparison_neighboring_runs = (
                list(ts.get_next_runs_on_machine(self.compare_to, N=3))[::-1] +
                [self.compare_to] +
                list(ts.get_previous_runs_on_machine(self.compare_to, N=3)))
        else:
            if prev_runs:
                self.compare_to = prev_runs[0]
            else:
                self.compare_to = None
            self.comparison_neighboring_runs = self.neighboring_runs

        try:
            self.num_comparison_runs = int(
                request.args.get('num_comparison_runs'))
        except:
            self.num_comparison_runs = 10

        # Find the baseline run, if requested.
        baseline_str = request.args.get('baseline')
        if baseline_str:
            baseline_id = int(baseline_str)
            self.baseline = ts.query(ts.Run).\
                filter_by(id=baseline_id).first()
            if self.baseline is None:
                # FIXME: Need better way to report this error.
                abort(404)
        else:
            self.baseline = None

        # Gather the runs to use for statistical data.
        comparison_start_run = self.compare_to or self.run
        self.comparison_window = list(ts.get_previous_runs_on_machine(
                    comparison_start_run, self.num_comparison_runs))

        reports = lnt.server.reporting.runs.generate_run_report(
            self.run, baseurl=db_url_for('index', _external=True),
            only_html_body=only_html_body, result=None,
            compare_to=self.compare_to, baseline=self.baseline,
            comparison_window=self.comparison_window,
            aggregation_fn=self.aggregation_fn)
        _, self.text_report, self.html_report, self.sri = reports

@v4_route("/<int:id>/report")
def v4_report(id):
    info = V4RequestInfo(id, only_html_body=False)

    return make_response(info.html_report)

@v4_route("/<int:id>/text_report")
def v4_text_report(id):
    info = V4RequestInfo(id, only_html_body=False)

    response = make_response(info.text_report)
    response.mimetype = "text/plain"
    return response

# Compatilibity route for old run pages.
@db_route("/simple/<tag>/<int:id>/", only_v3=False)
def simple_run(tag, id):
    # Attempt to find a V4 run which declares that it matches this simple run
    # ID. We do this so we can preserve some URL compatibility for old
    # databases.
    if g.db_info.db_version != '0.4':
        return render_template("error.html", message="""\
Invalid URL for version %r database.""" % (g.db_info.db_version,))

    # Get the expected test suite.
    db = request.get_db()
    ts = db.testsuite[tag]

    # Look for a matched run.
    matched_run = ts.query(ts.Run).\
        filter(ts.Run.simple_run_id == id).\
        first()

    # If we found one, redirect to it's report.
    if matched_run is not None:
        return redirect(db_url_for("v4_run", testsuite_name=tag,
                                   id=matched_run.id))

    # Otherwise, report an error.
    return render_template("error.html", message="""\
Unable to find a v0.4 run for this ID. Please use the native v0.4 URL interface
(instead of the /simple/... URL schema).""")

@v4_route("/<int:id>")
def v4_run(id):
    info = V4RequestInfo(id)
    ts = info.ts
    run = info.run

    # Parse the view options.
    options = {}
    options['show_delta'] = bool(request.args.get('show_delta'))
    options['show_previous'] = bool(request.args.get('show_previous'))
    options['show_stddev'] =  bool(request.args.get('show_stddev'))
    options['show_mad'] = bool(request.args.get('show_mad'))
    options['show_all'] = bool(request.args.get('show_all'))
    options['show_all_samples'] = bool(request.args.get('show_all_samples'))
    options['show_sample_counts'] = bool(request.args.get('show_sample_counts'))
    options['show_graphs'] = show_graphs = bool(request.args.get('show_graphs'))
    options['show_data_table'] = bool(request.args.get('show_data_table'))
    options['hide_report_by_default'] = bool(
        request.args.get('hide_report_by_default'))
    options['num_comparison_runs'] = info.num_comparison_runs
    options['test_filter'] = test_filter_str = request.args.get(
        'test_filter', '')
    if test_filter_str:
        test_filter_re = re.compile(test_filter_str)
    else:
        test_filter_re = None

    options['test_min_value_filter'] = test_min_value_filter_str = \
        request.args.get('test_min_value_filter', '')
    if test_min_value_filter_str != '':
        test_min_value_filter = float(test_min_value_filter_str)
    else:
        test_min_value_filter = 0.0

    options['aggregation_fn'] = request.args.get('aggregation_fn', 'min')

    # Get the test names.
    test_info = ts.query(ts.Test.name, ts.Test.id).\
        order_by(ts.Test.name).all()

    # Filter the list of tests by name, if requested.
    if test_filter_re:
        test_info = [test
                     for test in test_info
                     if test_filter_re.search(test[0])]

    return render_template(
        "v4_run.html", ts=ts, options=options,
        primary_fields=list(ts.Sample.get_primary_fields()),
        test_info=test_info, analysis=lnt.server.reporting.analysis,
        test_min_value_filter=test_min_value_filter,
        request_info=info)

@v4_route("/order/<int:id>")
def v4_order(id):
    # Get the testsuite.
    ts = request.get_testsuite()

    # Get the order.
    order = ts.query(ts.Order).filter(ts.Order.id == id).first()
    if order is None:
        abort(404)

    return render_template("v4_order.html", ts=ts, order=order)

@v4_route("/all_orders")
def v4_all_orders():
    # Get the testsuite.
    ts = request.get_testsuite()

    # Get the orders.
    orders = ts.query(ts.Order).all()

    # Order the runs totally.
    orders.sort()

    return render_template("v4_all_orders.html", ts=ts, orders=orders)

@v4_route("/<int:id>/graph")
def v4_graph(id):
    from lnt.server.ui import util
    from lnt.testing import PASS
    from lnt.util import stats
    from lnt.external.stats import stats as ext_stats

    ts = request.get_testsuite()
    run = ts.query(ts.Run).filter_by(id=id).first()
    if run is None:
        abort(404)

    # Find the neighboring runs, by order.
    prev_runs = list(ts.get_previous_runs_on_machine(run, N = 3))
    next_runs = list(ts.get_next_runs_on_machine(run, N = 3))
    if prev_runs:
        compare_to = prev_runs[0]
    else:
        compare_to = None
    neighboring_runs = next_runs[::-1] + [run] + prev_runs

    # Parse the view options.
    options = {}
    options['show_mad'] = show_mad = bool(request.args.get('show_mad'))
    options['show_stddev'] = show_stddev = bool(request.args.get('show_stddev'))
    options['show_points'] = show_points = bool(request.args.get('show_points'))
    options['show_all_points'] = show_all_points = bool(
        request.args.get('show_all_points'))
    options['show_linear_regression'] = show_linear_regression = bool(
        request.args.get('show_linear_regression'))
    options['show_failures'] = show_failures = bool(
        request.args.get('show_failures'))
    options['normalize_by_median'] = normalize_by_median = bool(
        request.args.get('normalize_by_median'))

    # Load the graph parameters.
    graph_tests = []
    for name,value in request.args.items():
        # Tests to graph are passed as test.<test id>=<sample field id>.
        if not name.startswith(str('test.')):
            continue

        # Extract the test id string and convert to integers.
        test_id_str = name[5:]
        try:
            test_id = int(test_id_str)
            field_index = int(value)
        except:
            return abort(400)

        # Get the test and the field.
        if not (0 <= field_index < len(ts.sample_fields)):
            return abort(400)

        test = ts.query(ts.Test).filter(ts.Test.id == test_id).one()
        field = ts.sample_fields[field_index]

        graph_tests.append((test, field))

    # Order the plots by test name and then field.
    graph_tests.sort(key = lambda (t,f): (t.name, f.name))

    # Build the graph data.
    legend = []
    graph_plots = []
    num_points = 0
    num_plots = len(graph_tests)
    use_day_axis = None
    for i,(test,field) in enumerate(graph_tests):
        # Determine the base plot color.
        col = list(util.makeDarkColor(float(i) / num_plots))
        legend.append((test.name, field.name, tuple(col)))

        # Load all the field values for this test on the same machine.
        #
        # FIXME: Don't join to Order here, aggregate this across all the tests
        # we want to load. Actually, we should just make this a single query.
        #
        # FIXME: Don't hard code field name.
        q = ts.query(field.column, ts.Order.llvm_project_revision).\
            join(ts.Run).join(ts.Order).\
            filter(ts.Run.machine == run.machine).\
            filter(ts.Sample.test == test).\
            filter(field.column != None)

        # Unless all samples requested, filter out failing tests.
        if not show_failures:
            if field.status_field:
                q = q.filter((field.status_field.column == PASS) |
                             (field.status_field.column == None))

        # Aggregate by revision.
        #
        # FIXME: For now, we just do something stupid when we encounter release
        # numbers like '3.0.1' and use convert to 3. This makes the graphs
        # fairly useless...
        def convert_revision(r):
            if r.isdigit():
                return int(r)
            else:
                return int(r.split('.',1)[0])
            return r
        data = util.multidict((convert_revision(r),v)
                              for v,r in q).items()
        data.sort()

        # Infer whether or not we should use a day axis. This is a total hack to
        # try and get graphs of machines which report in the %04Y%02M%02D format
        # to look readable.
        #
        # We only do this detection for the first test.
        if use_day_axis is None:
            if data:
                use_day_axis = (20000000 <= data[0][0] < 20990000)
            else:
                use_day_axis = False

        # If we are using a day axis, convert the keys into seconds since the
        # epoch.
        if use_day_axis:
            def convert((x,y)):
                year = x//10000
                month = (x//100) % 100
                day = x % 100
                seconds = datetime.datetime
                timestamp = time.mktime((year, month, day,
                                         0, 0, 0, 0, 0, 0))
                return (timestamp,y)
            data = map(convert, data)

        # Compute the graph points.
        revision_range_region = []
        errorbar_data = []
        points_data = []
        pts = []

        # Create region of interest for run data region if
        # we are performing a comparison.
        if compare_to:
            start_rev = compare_to.order.llvm_project_revision
            end_rev = run.order.llvm_project_revision
            revision_range_region = (
                convert_revision(start_rev),
                convert_revision(end_rev)
            )

        if normalize_by_median:
            normalize_by = 1.0/stats.median([min(values)
                                           for _,values in data])
        else:
            normalize_by = 1.0
        for x,orig_values in data:
            values = [v*normalize_by for v in orig_values]
            min_value = min(values)
            pts.append((x, min_value))

            # Add the individual points, if requested.
            if show_all_points:
                for v in values:
                    points_data.append((x, v))
            elif show_points:
                points_data.append((x, min_value))

            # Add the standard deviation error bar, if requested.
            if show_stddev:
                mean = stats.mean(values)
                sigma = stats.standard_deviation(values)
                errorbar_data.append((x, mean - sigma, mean + sigma))

            # Add the MAD error bar, if requested.
            if show_mad:
                med = stats.median(values)
                mad = stats.median_absolute_deviation(values, med)
                errorbar_data.append((x, med - mad, med + mad))

        # Add the minimum line plot.
        num_points += len(data)
        graph_plots.append("graph.addPlot([%s], %s);" % (
                        ','.join(['[%.4f,%.4f]' % (t,v)
                                  for t,v in pts]),
                        "new Graph2D_LinePlotStyle(1, %r)" % col))

        # Add regression line, if requested.
        if show_linear_regression:
            xs = [t for t,v in pts]
            ys = [v for t,v in pts]

            # We compute the regression line in terms of a normalized X scale.
            x_min, x_max = min(xs), max(xs)
            try:
                norm_xs = [(x - x_min) / (x_max - x_min)
                           for x in xs]
            except ZeroDivisionError:
                norm_xs = xs

            try:
                info = ext_stats.linregress(norm_xs, ys)
            except ZeroDivisionError:
                info = None
            except ValueError:
                info = None

            if info is not None:
                slope, intercept,_,_,_ = info

                reglin_col = [c*.5 for c in col]
                pts = ','.join('[%.4f,%.4f]' % pt
                               for pt in [(x_min, 0.0 * slope + intercept),
                                          (x_max, 1.0 * slope + intercept)])
                style = "new Graph2D_LinePlotStyle(4, %r)" % ([.7, .7, .7],)
                graph_plots.append("graph.addPlot([%s], %s);" % (
                        pts,style))
                style = "new Graph2D_LinePlotStyle(2, %r)" % (reglin_col,)
                graph_plots.append("graph.addPlot([%s], %s);" % (
                        pts,style))

        # If we are comparing two revisions,
        if compare_to:
            reg_col = [0.0, 0.0, 1.0]
            graph_plots.append("graph.addPlot([%i, %i],%s);" % (
                    revision_range_region[0], revision_range_region[1],
                    "new Graph2D_RangePlotStyle(%r)" % reg_col))

        # Add the points plot, if used.
        if points_data:
            pts_col = (0,0,0)
            graph_plots.append("graph.addPlot([%s], %s);" % (
                ','.join(['[%.4f,%.4f]' % (t,v)
                            for t,v in points_data]),
                "new Graph2D_PointPlotStyle(1, %r)" % (pts_col,)))

        # Add the error bar plot, if used.
        if errorbar_data:
            bar_col = [c*.7 for c in col]
            graph_plots.append("graph.addPlot([%s], %s);" % (
                ','.join(['[%.4f,%.4f,%.4f]' % (x,y_min,y_max)
                          for x,y_min,y_max in errorbar_data]),
                "new Graph2D_ErrorBarPlotStyle(1, %r)" % (bar_col,)))

    return render_template("v4_graph.html", ts=ts, run=run,
                           compare_to=compare_to, options=options,
                           num_plots=num_plots, num_points=num_points,
                           neighboring_runs=neighboring_runs,
                           graph_plots=graph_plots, legend=legend,
                           use_day_axis=use_day_axis)

@v4_route("/daily_report")
def v4_daily_report_overview():
    # For now, redirect to the report for the most recent submitted run's date.

    ts = request.get_testsuite()

    # Get the latest run.
    latest = ts.query(ts.Run).\
        order_by(ts.Run.start_time.desc()).limit(1).first()

    # If we found a run, use it's start time.
    if latest:
        date = latest.start_time
    else:
        # Otherwise, just use today.
        date = datetime.date.today()

    return redirect(v4_url_for("v4_daily_report",
                               year=date.year, month=date.month, day=date.day))

@v4_route("/global_status")
def v4_global_status():
    from lnt.server.ui import util

    ts = request.get_testsuite()

    # Get the latest run.
    latest = ts.query(ts.Run.start_time).\
        order_by(ts.Run.start_time.desc()).first()

    # If we found an entry, use that.
    if latest is not None:
        latest_date, = latest
    else:
        # Otherwise, just use today.
        latest_date = datetime.date.today()

    # Create a datetime for the day before the most recent run.
    yesterday = latest_date - datetime.timedelta(days=1)

    # Get the revision number for the default baseline and look up
    # the fields we are interested in.
    revision = ts.Machine.DEFAULT_BASELINE_REVISION
    field = ts.Sample.get_primary_fields().next()

    # Get the list of all runs we might be interested in.
    recent_runs = ts.query(ts.Run).filter(ts.Run.start_time > yesterday).all()

    # Aggregate the runs by machine.
    recent_runs_by_machine = util.multidict()
    for run in recent_runs:
        recent_runs_by_machine[run.machine] = run

    # Get a sorted list of recent machines.
    recent_machines = sorted(recent_runs_by_machine.keys(),
                             key=lambda m: m.name)

    # For each machine, build a table of the machine, the baseline run, and the
    # most recent run. We also computed a list of all the runs we are reporting
    # over.
    machine_run_info = []
    reported_run_ids = []
    for machine in recent_machines:
        runs = recent_runs_by_machine[machine]

        # Get the baseline run for this machine.
        baseline = machine.get_baseline_run(revision)

        # Choose the "best" run to report on. We want the most recent one with
        # the most recent order.
        run = max(runs, key=lambda r: (r.order, r.start_time))

        machine_run_info.append((baseline, run))
        reported_run_ids.append(baseline.id)
        reported_run_ids.append(run.id)

    # Get the set all tests reported in the recent runs.
    reported_tests = ts.query(ts.Test.id, ts.Test.name).filter(
        sqlalchemy.sql.exists('*', sqlalchemy.sql.and_(
            ts.Sample.run_id.in_(reported_run_ids),
            ts.Sample.test_id == ts.Test.id))).all()

    # Load all of the runs we are interested in.
    runinfo = lnt.server.reporting.analysis.RunInfo(ts, reported_run_ids)

    # Build the test matrix. This is a two dimensional table index by
    # (machine-index, test-index), where each entry is the percent change.
    test_table = []
    for i,(test_id,test_name) in enumerate(reported_tests):
        # Create the row, starting with the test name and worst entry.
        row = [test_name, None]

        # Compute comparison results for each machine.
        row.extend(runinfo.get_run_comparison_result(run, baseline, test_id,
                                                     field)
                   for baseline,run in machine_run_info)

        # Compute the worst cell value.
        row[1] = max(cr.pct_delta
                     for cr in row[2:])

        test_table.append(row)

    # Order the table by worst regression.
    test_table.sort(key = lambda row: row[1], reverse=True)

    return render_template("v4_global_status.html",
                           ts=ts,
                           tests=test_table,
                           machines=recent_machines,
                           selected_field=field)

@v4_route("/daily_report/<int:year>/<int:month>/<int:day>")
def v4_daily_report(year, month, day):
    import datetime
    from lnt.server.ui import util

    ts = request.get_testsuite()

    # The number of previous days we are going to report on.
    num_prior_days_to_include = 3

    # Construct datetime instances for the report range.
    day_ordinal = datetime.datetime(year, month, day).toordinal()

    next_day = datetime.datetime.fromordinal(day_ordinal + 1)
    prior_days = [datetime.datetime.fromordinal(day_ordinal - i)
                  for i in range(num_prior_days_to_include + 1)]

    # Adjust the dates time component.  As we typically want to do runs
    # overnight, we define "daily" to really mean "at 0700".
    day_start_offset = datetime.timedelta(hours=7)
    next_day += day_start_offset
    for i,day in enumerate(prior_days):
        prior_days[i] = day + day_start_offset

    # Find all the runs that occurred for each day slice.
    prior_runs = [ts.query(ts.Run).\
                      filter(ts.Run.start_time > prior_day).\
                      filter(ts.Run.start_time <= day).all()
                  for day,prior_day in util.pairs(prior_days)]

    # For every machine, we only want to report on the last run order that was
    # reported for that machine for the particular day range.
    #
    # Note that this *does not* mean that we will only report for one particular
    # run order for each day, because different machines may report on different
    # orders.
    #
    # However, we want to limit ourselves to a single run order for each
    # (day,machine) so that we don't obscure any details through our
    # aggregation.
    prior_days_machine_order_map = [None] * num_prior_days_to_include
    for i,runs in enumerate(prior_runs):
        # Aggregate the runs by machine.
        machine_to_all_orders = util.multidict()
        for r in runs:
            machine_to_all_orders[r.machine] = r.order

        # Create a map from machine to max order.
        prior_days_machine_order_map[i] = machine_order_map = dict(
            (machine, max(orders))
            for machine,orders in machine_to_all_orders.items())

        # Update the run list to only include the runs with that order.
        prior_runs[i] = [r for r in runs
                         if r.order is machine_order_map[r.machine]]

    # Form a list of all relevant runs.
    relevant_runs = sum(prior_runs, [])

    # Find the union of all machines reporting in the relevant runs.
    reporting_machines = list(set(r.machine for r in relevant_runs))
    reporting_machines.sort(key = lambda m: m.name)

    # We aspire to present a "lossless" report, in that we don't ever hide any
    # possible change due to aggregation. In addition, we want to make it easy
    # to see the relation of results across all the reporting machines. In
    # particular:
    #
    #   (a) When a test starts failing or passing on one machine, it should be
    #       easy to see how that test behaved on other machines. This makes it
    #       easy to identify the scope of the change.
    #
    #   (b) When a performance change occurs, it should be easy to see the
    #       performance of that test on other machines. This makes it easy to
    #       see the scope of the change and to potentially apply human
    #       discretion in determining whether or not a particular result is
    #       worth considering (as opposed to noise).
    #
    # The idea is as follows, for each (machine, test, primary_field), classify
    # the result into one of REGRESSED, IMPROVED, UNCHANGED_FAIL, ADDED,
    # REMOVED, PERFORMANCE_REGRESSED, PERFORMANCE_IMPROVED.
    #
    # For now, we then just aggregate by test and present the results as
    # is. This is lossless, but not nearly as nice to read as the old style
    # per-machine reports. In the future we will want to find a way to combine
    # the per-machine report style of presenting results aggregated by the kind
    # of status change, while still managing to present the overview across
    # machines.

    # Batch load all of the samples reported by all these runs.
    columns = [ts.Sample.run_id,
               ts.Sample.test_id]
    columns.extend(f.column
                   for f in ts.sample_fields)
    samples = ts.query(*columns).\
        filter(ts.Sample.run_id.in_(
            r.id for r in relevant_runs)).all()

    # Find the union of tests reported in the relevant runs.
    #
    # FIXME: This is not particularly efficient, should we just use all tests in
    # the database?
    reporting_tests = ts.query(ts.Test).\
        filter(ts.Test.id.in_(set(s[1] for s in samples))).\
        order_by(ts.Test.name).all()

    # Aggregate all of the samples by (run_id, test_id).
    sample_map = util.multidict()
    for s in samples:
        sample_map[(s[0], s[1])] = s[2:]

    # Build the result table:
    #   result_table[test_index][day_index][machine_index] = {samples}
    result_table = []
    for test in reporting_tests:
        key = test
        test_results = []
        for day_runs in prior_runs:
            day_results = []
            for machine in reporting_machines:
                # Collect all the results for this machine.
                results = [s
                           for run in day_runs
                           if run.machine is machine
                           for s in sample_map.get((run.id, test.id), ())]
                day_results.append(results)
            test_results.append(day_results)
        result_table.append(test_results)

    # FIXME: Now compute ComparisonResult objects for each (test, machine, day).

    return render_template(
        "v4_daily_report.html", ts=ts, day_start_offset=day_start_offset,
        num_prior_days_to_include=num_prior_days_to_include,
        reporting_machines=reporting_machines, reporting_tests=reporting_tests,
        prior_days=prior_days, next_day=next_day,
        prior_days_machine_order_map=prior_days_machine_order_map,
        result_table=result_table)

###
# Cross Test-Suite V4 Views

import lnt.server.reporting.summaryreport

def get_summary_config_path():
    return os.path.join(current_app.old_config.tempDir,
                        'summary_report_config.json')

@db_route("/summary_report/edit", only_v3=False, methods=('GET', 'POST'))
def v4_summary_report_ui():
    # If this is a POST request, update the saved config.
    if request.method == 'POST':
        # Parse the config data.
        config_data = request.form.get('config')
        config = flask.json.loads(config_data)

        # Write the updated config.
        with open(get_summary_config_path(), 'w') as f:
            flask.json.dump(config, f, indent=2)

        # Redirect to the summary report.
        return redirect(db_url_for("v4_summary_report"))

    config_path = get_summary_config_path()
    if os.path.exists(config_path):
        with open(config_path) as f:
            config = flask.json.load(f)
    else:
        config = {
            "machine_names" : [],
            "orders" : [],
            "machine_patterns" : [],
            "machines_to_merge" : {}
            }

    # Get the list of available test suites.
    testsuites = request.get_db().testsuite.values()

    # Gather the list of all run orders and all machines.
    def to_key(name):
        first = name.split('.', 1)[0]
        if first.isdigit():
            return (int(first), name)
        return (first, name)
    all_machines = set()
    all_orders = set()
    for ts in testsuites:
        for name, in ts.query(ts.Machine.name):
            all_machines.add(name)
        for name, in ts.query(ts.Order.llvm_project_revision):
            all_orders.add(name)
    all_machines = sorted(all_machines)
    all_orders = sorted(all_orders, key=to_key)

    return render_template("v4_summary_report_ui.html",
                           config=config, all_machines=all_machines,
                           all_orders=all_orders)

@db_route("/summary_report", only_v3=False)
def v4_summary_report():
    # FIXME: Add a UI for defining the report configuration.

    # Load the summary report configuration.
    config_path = get_summary_config_path()
    if not os.path.exists(config_path):
        return render_template("error.html", message="""\
You must define a summary report configuration first.""")

    with open(config_path) as f:
        config = flask.json.load(f)

    # Create the report object.
    report = lnt.server.reporting.summaryreport.SummaryReport(
        request.get_db(), config['orders'], config['machine_names'],
        config['machine_patterns'],
        dict((int(key),value)
             for key,value in config['machines_to_merge'].items()))

    # Build the report.
    report.build()

    return render_template("v4_summary_report.html", report=report)

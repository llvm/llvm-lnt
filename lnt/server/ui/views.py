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
import lnt.server.reporting.dailyreport
import lnt.server.reporting.summaryreport
from collections import namedtuple

integral_rex = re.compile(r"[\d]+")

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
    return render_template("v4_overview.html",
                           testsuite_name=g.testsuite_name)

@v4_route("/recent_activity")
def v4_recent_activity():
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

    return render_template("v4_recent_activity.html",
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

        # Get the MW confidence level
        confidence_lv = float(request.args.get('MW_confidence_lv', .9))
        self.confidence_lv = confidence_lv

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
            aggregation_fn=self.aggregation_fn, confidence_lv=confidence_lv)
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
    options['MW_confidence_lv'] = float(request.args.get('MW_confidence_lv', .9))
    options['show_p_value'] = bool(request.args.get('show_p_value'))
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
def v4_run_graph(id):
    # This is an old style endpoint that treated graphs as associated with
    # runs. Redirect to the new endpoint.

    ts = request.get_testsuite()
    run = ts.query(ts.Run).filter_by(id=id).first()
    if run is None:
        abort(404)

    # Convert the old style test parameters encoding.
    args = { 'highlight_run' : id }
    plot_number = 0
    for name,value in request.args.items():
        # If this isn't a test specification, just forward it.
        if not name.startswith('test.'):
            args[name] = value
            continue

        # Otherwise, rewrite from the old style of::
        #
        #   test.<test id>=<sample field index>
        #
        # into the new style of::
        #
        #   plot.<number>=<machine id>.<test id>.<sample field index>
        test_id = name.split('.', 1)[1]
        args['plot.%d' % (plot_number,)] = '%d.%s.%s' % (
            run.machine.id, test_id, value)
        plot_number += 1

    return redirect(v4_url_for("v4_graph", **args))

BaselineLegendItem = namedtuple('BaselineLegendItem', 'name id')

@v4_route("/graph")
def v4_graph():
    from lnt.server.ui import util
    from lnt.testing import PASS
    from lnt.util import stats
    from lnt.external.stats import stats as ext_stats

    ts = request.get_testsuite()

    # Parse the view options.
    options = {}
    options['hide_lineplot'] = bool(request.args.get('hide_lineplot'))
    show_lineplot = not options['hide_lineplot']
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
    options['show_moving_average'] = moving_average = bool(
        request.args.get('show_moving_average'))
    options['show_moving_median'] = moving_median = bool(
        request.args.get('show_moving_median'))
    options['moving_window_size'] = moving_window_size = int(
        request.args.get('moving_window_size', 10))
    options['hide_highlight'] = bool(
        request.args.get('hide_highlight'))
    show_highlight = not options['hide_highlight']

    def convert_revision(dotted):
        """Turn a version number like 489.2.10 into something
        that is ordered and sortable.
        For now 489.2.10 will be returned as a tuple of ints.
        """
        dotted = integral_rex.findall(dotted)
        return tuple([int(d) for d in dotted])

    # Load the graph parameters.
    graph_parameters = []
    for name,value in request.args.items():
        # Plots to graph are passed as::
        #
        #  plot.<unused>=<machine id>.<test id>.<field index>
        if not name.startswith(str('plot.')):
            continue

        # Ignore the extra part of the key, it is unused.
        machine_id_str,test_id_str,field_index_str = value.split('.')
        try:
            machine_id = int(machine_id_str)
            test_id = int(test_id_str)
            field_index = int(field_index_str)
        except:
            return abort(400)

        if not (0 <= field_index < len(ts.sample_fields)):
            return abort(400)

        machine = ts.query(ts.Machine).filter(ts.Machine.id == machine_id).one()
        test = ts.query(ts.Test).filter(ts.Test.id == test_id).one()
        field = ts.sample_fields[field_index]

        graph_parameters.append((machine, test, field))

    # Order the plots by machine name, test name and then field.
    graph_parameters.sort(key = lambda (m,t,f): (m.name, t.name, f.name))

    # Sanity check the arguments.
    if not graph_parameters:
        return render_template("error.html", message="Nothing to graph.")

    # Extract requested baselines.
    baseline_parameters = []
    for name,value in request.args.items():
        # Baselines to graph are passed as:
        #
        #  baseline.<unused>=<run id>
        if not name.startswith(str('baseline.')):
            continue

        # Ignore the extra part of the key, it is unused.
        run_id_str = value
        try:
            run_id = int(run_id_str)
        except:
            return abort(400)

        try:
            run = ts.query(ts.Run).join(ts.Machine).filter(ts.Run.id == run_id).one()
        except:
            err_msg = "The run {} was not found in the database.".format(run_id)
            return render_template("error.html",
                                   message=err_msg)

        baseline_parameters.append(run)

    # Create region of interest for run data region if we are performing a
    # comparison.
    revision_range = None
    highlight_run_id = request.args.get('highlight_run')
    if show_highlight and highlight_run_id and highlight_run_id.isdigit():
        highlight_run = ts.query(ts.Run).filter_by(
            id=int(highlight_run_id)).first()
        if highlight_run is None:
            abort(404)

        # Find the neighboring runs, by order.
        prev_runs = list(ts.get_previous_runs_on_machine(highlight_run, N = 1))
        if prev_runs:
            start_rev = prev_runs[0].order.llvm_project_revision
            end_rev = highlight_run.order.llvm_project_revision
            revision_range = {
                "start": convert_revision(start_rev),
                "end": convert_revision(end_rev) }

    # Build the graph data.
    legend = []
    graph_plots = []
    overview_plots = []
    baseline_plots = []
    num_plots = len(graph_parameters)
    for i,(machine,test,field) in enumerate(graph_parameters):
        # Determine the base plot color.
        col = list(util.makeDarkColor(float(i) / num_plots))
        legend.append((machine, test.name, field.name, tuple(col)))

        # Load all the field values for this test on the same machine.
        #
        # FIXME: Don't join to Order here, aggregate this across all the tests
        # we want to load. Actually, we should just make this a single query.
        #
        # FIXME: Don't hard code field name.
        q = ts.query(field.column, ts.Order.llvm_project_revision, ts.Run.start_time).\
            join(ts.Run).join(ts.Order).\
            filter(ts.Run.machine_id == machine.id).\
            filter(ts.Sample.test == test).\
            filter(field.column != None)

        # Unless all samples requested, filter out failing tests.
        if not show_failures:
            if field.status_field:
                q = q.filter((field.status_field.column == PASS) |
                             (field.status_field.column == None))

        # Aggregate by revision.
        data = util.multidict((rev, (val, date)) for val,rev,date in q).items()
        data.sort(key=lambda sample: convert_revision(sample[0]))

        # Get baselines for this line
        for baseline in baseline_parameters:
            q_baseline = ts.query(field.column, ts.Order.llvm_project_revision, ts.Run.start_time, ts.Machine.name).\
                         join(ts.Run).join(ts.Order).join(ts.Machine).\
                         filter(ts.Run.id == baseline.id).\
                         filter(ts.Sample.test == test).\
                         filter(field.column != None)
            # In the event of many samples, use the mean of the samples as the baseline.
            samples = []
            for sample in q_baseline:
                samples.append(sample[0])
            mean = sum(samples)/len(samples)
            # Darken the baseline color distinguish from real line.
            dark_col = list(util.makeDarkerColor(float(i) / num_plots))
            str_dark_col =  util.toColorString(dark_col)
            baseline_plots.append({'color': str_dark_col,
                                   'lineWidth': 2,
                                   'yaxis': {'from': mean, 'to': mean},
                                   'name': q_baseline[0].llvm_project_revision})
            baseline_name = "Baseline {} on {}".format(q_baseline[0].llvm_project_revision,  q_baseline[0].name)
            legend.append((BaselineLegendItem(baseline_name, baseline.id), test.name, field.name, dark_col))
        # Compute the graph points.
        errorbar_data = []
        points_data = []
        pts = []
        moving_median_data = []
        moving_average_data = []
        if normalize_by_median:
            normalize_by = 1.0/stats.median([min([d[0] for d in values])
                                           for _,values in data])
        else:
            normalize_by = 1.0
        for pos, (point_label, datapoints) in enumerate(data):
            # Get the samples.
            data = [data_date[0] for data_date in datapoints]
            # And the date on which they were taken.
            dates = [data_date[1] for data_date in datapoints]

            metadata = {"label":point_label}
            
            # When we can, map x-axis to revisions, but when that is too hard
            # use the position of the sample instead.
            rev_x = convert_revision(point_label)
            x = rev_x[0] if len(rev_x)==1 else pos

            values = [v*normalize_by for v in data]
            min_value,min_index = min((value, index) for (index, value) in enumerate(values))
            metadata["date"] = str(dates[min_index])
            pts.append((x, min_value, metadata))

            # Add the individual points, if requested.
            # For each point add a text label for the mouse over.
            if show_all_points:
                for i,v in enumerate(values):
                    point_metadata = dict(metadata)
                    point_metadata["date"] = str(dates[i]) 
                    points_data.append((x, v, point_metadata))
            elif show_points:
                points_data.append((x, min_value, metadata))
    
            # Add the standard deviation error bar, if requested.
            if show_stddev:
                mean = stats.mean(values)
                sigma = stats.standard_deviation(values)
                errorbar_data.append((x, mean, sigma))

            # Add the MAD error bar, if requested.
            if show_mad:
                med = stats.median(values)
                mad = stats.median_absolute_deviation(values, med)
                errorbar_data.append((x, med, mad))

        # Compute the moving average and or moving median of our data if requested.
        if moving_average or moving_median:
            fun = None

            def compute_moving_average(x, window, average_list, median_list):
                average_list.append((x, lnt.util.stats.mean(window)))
            def compute_moving_median(x, window, average_list, median_list):
                median_list.append((x, lnt.util.stats.median(window)))
            def compute_moving_average_and_median(x, window, average_list, median_list):
                average_list.append((x, lnt.util.stats.mean(window)))
                median_list.append((x, lnt.util.stats.median(window)))

            if moving_average and moving_median:
                fun = compute_moving_average_and_median
            elif moving_average:
                fun = compute_moving_average
            else:
                fun = compute_moving_median

            len_pts = len(pts)
            for i in range(len_pts):
                start_index = max(0, i - moving_window_size)
                end_index = min(len_pts, i + moving_window_size)

                window_pts = [x[1] for x in pts[start_index:end_index]]
                fun(pts[i][0], window_pts, moving_average_data, moving_median_data)

        # On the overview, we always show the line plot.
        overview_plots.append({
                "data" : pts,
                "color" : util.toColorString(col) })

        # Add the minimum line plot, if requested.
        if show_lineplot:
            graph_plots.append({
                    "data" : pts,
                    "color" : util.toColorString(col) })

        # Add regression line, if requested.
        if show_linear_regression:
            xs = [t for t,v,_ in pts]
            ys = [v for t,v,_ in pts]

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

                reglin_col = [c * .7 for c in col]
                reglin_pts = [(x_min, 0.0 * slope + intercept),
                              (x_max, 1.0 * slope + intercept)]
                graph_plots.insert(0, {
                        "data" : reglin_pts,
                        "color" : util.toColorString(reglin_col),
                        "lines" : {
                            "lineWidth" : 2 },
                        "shadowSize" : 4 })

        # Add the points plot, if used.
        if points_data:
            pts_col = (0,0,0)
            graph_plots.append({
                    "data" : points_data,
                    "color" : util.toColorString(pts_col),
                    "lines" : {
                        "show" : False },
                    "points" : {
                        "show" : True,
                        "radius" : .25,
                        "fill" : True } })

        # Add the error bar plot, if used.
        if errorbar_data:
            bar_col = [c*.7 for c in col]
            graph_plots.append({
                    "data" : errorbar_data,
                    "lines" : { "show" : False },
                    "color" : util.toColorString(bar_col),
                    "points" : {
                        "errorbars" : "y",
                        "yerr" : { "show" : True,
                                   "lowerCap" : "-",
                                   "upperCap" : "-",
                                   "lineWidth" : 1 } } })

        # Add the moving average plot, if used.
        if moving_average_data:
            col = [0.32, 0.6, 0.0]
            graph_plots.append({
                    "data" : moving_average_data,
                    "color" : util.toColorString(col) })


        # Add the moving median plot, if used.
        if moving_median_data:
            col = [0.75, 0.0, 1.0]
            graph_plots.append({
                    "data" : moving_median_data,
                    "color" : util.toColorString(col) })

    if bool(request.args.get('json')):
        json_obj = dict()
        json_obj['data'] = graph_plots
        # Flatten ORM machine objects to their string names.
        simple_type_legend = []
        for machine, test, unit, color in legend:
            # Flatten name, make color a dict.
            new_entry = {'name': machine.name,
                         'test': test,
                         'unit': unit,
                         'color': util.toColorString(color),}
            simple_type_legend.append(new_entry)
        json_obj['legend'] = simple_type_legend
        json_obj['revision_range'] = revision_range
        json_obj['current_options'] = options
        json_obj['test_suite_name'] = ts.name
        json_obj['baselines'] = baseline_plots
        return flask.jsonify(**json_obj)

    return render_template("v4_graph.html", ts=ts, options=options,
                           revision_range=revision_range,
                           graph_plots=graph_plots,
                           overview_plots=overview_plots, legend=legend,
                           baseline_plots=baseline_plots)

@v4_route("/global_status")
def v4_global_status():
    from lnt.server.ui import util

    ts = request.get_testsuite()
    primary_fields = sorted(list(ts.Sample.get_primary_fields()),
                            key=lambda f: f.name)
    fields = dict((f.name, f) for f in primary_fields)

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

    # Get arguments.
    revision = int(request.args.get('revision',
                                    ts.Machine.DEFAULT_BASELINE_REVISION))
    field = fields.get(request.args.get('field', None), primary_fields[0])

    # Get the list of all runs we might be interested in.
    recent_runs = ts.query(ts.Run).filter(ts.Run.start_time > yesterday).all()

    # Aggregate the runs by machine.
    recent_runs_by_machine = util.multidict()
    for run in recent_runs:
        recent_runs_by_machine[run.machine] = run

    # Get a sorted list of recent machines.
    recent_machines = sorted(recent_runs_by_machine.keys(),
                             key=lambda m: m.name)
    
    # We use periods in our machine names. css does not like this
    # since it uses periods to demark classes. Thus we convert periods
    # in the names of our machines to dashes for use in css. It is
    # also convenient for our computations in the jinja page to have
    # access to 
    def get_machine_keys(m):
        m.css_name = m.name.replace('.','-')
        return m    
    recent_machines = map(get_machine_keys, recent_machines)

    # For each machine, build a table of the machine, the baseline run, and the
    # most recent run. We also computed a list of all the runs we are reporting
    # over.
    machine_run_info = []
    reported_run_ids = []

    for machine in recent_machines:
        runs = recent_runs_by_machine[machine]

        # Get the baseline run for this machine.
        baseline = machine.get_closest_previously_reported_run(revision)

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
        row = [(test_id, test_name), None]

        # Compute comparison results for each machine.
        row.extend((runinfo.get_run_comparison_result(run, baseline, test_id,
                                                     field), run.id)
                   for baseline,run in machine_run_info)

        # Compute the worst cell value.
        row[1] = max(cr.pct_delta
                     for cr,_ in row[2:])

        test_table.append(row)

    # Order the table by worst regression.
    test_table.sort(key = lambda row: row[1], reverse=True)    
    
    return render_template("v4_global_status.html",
                           ts=ts,
                           tests=test_table,
                           machines=recent_machines,
                           fields=primary_fields,
                           selected_field=field,
                           selected_revision=revision)

@v4_route("/daily_report")
def v4_daily_report_overview():
    # Redirect to the report for the most recent submitted run's date.

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

@v4_route("/daily_report/<int:year>/<int:month>/<int:day>")
def v4_daily_report(year, month, day):
    num_days_str = request.args.get('num_days')
    if num_days_str is not None:
        num_days = int(num_days_str)
    else:
        num_days = 3
    
    day_start_str = request.args.get('day_start')
    if day_start_str is not None:
        day_start = int(day_start_str)
    else:
        day_start = 16
    
    ts = request.get_testsuite()

    # Create the report object.
    report = lnt.server.reporting.dailyreport.DailyReport(
        ts, year, month, day, num_days, day_start)

    # Build the report.
    report.build()

    return render_template("v4_daily_report.html", ts=ts, report=report,
                           analysis=lnt.server.reporting.analysis)

###
# Cross Test-Suite V4 Views

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
        config['machine_patterns'])
    # Build the report.
    report.build()

    if bool(request.args.get('json')):
        json_obj = dict()
        json_obj['ticks'] = report.report_orders
        data = []
        for e in report.normalized_data_table.items():
            header, samples = e
            raw_samples = samples.getvalue()
            data.append([header, raw_samples])
        json_obj['data'] = data

        return flask.jsonify(**json_obj)

    return render_template("v4_summary_report.html", report=report)

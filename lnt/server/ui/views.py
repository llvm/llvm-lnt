import datetime
import json
import os
import re
import tempfile
from collections import namedtuple, defaultdict
from urlparse import urlparse, urljoin

import flask
import sqlalchemy.sql
from flask import abort
from flask import current_app
from flask import flash
from flask import g
from flask import make_response
from flask import redirect
from flask import render_template
from flask import request, url_for
from flask import session
from flask_wtf import Form
from sqlalchemy.orm import joinedload
from sqlalchemy.orm.exc import NoResultFound
from typing import List, Optional
from wtforms import SelectField, StringField, SubmitField
from wtforms.validators import DataRequired, Length

import lnt.server.db.rules_manager
import lnt.server.db.search
import lnt.server.reporting.analysis
import lnt.server.reporting.dailyreport
import lnt.server.reporting.runs
import lnt.server.reporting.summaryreport
import lnt.server.ui.util
import lnt.util
import lnt.util.ImportData
import lnt.util.stats
from lnt.server.reporting.analysis import ComparisonResult, calc_geomean
from lnt.server.ui.decorators import frontend, db_route, v4_route
from lnt.server.ui.globals import db_url_for, v4_url_for
from lnt.server.ui.regression_views import PrecomputedCR
from lnt.server.ui.util import FLASH_DANGER, FLASH_SUCCESS, FLASH_INFO
from lnt.server.ui.util import mean
from lnt.util import async_ops
from lnt.server.ui.util import baseline_key, convert_revision


# http://flask.pocoo.org/snippets/62/
def is_safe_url(target):
    ref_url = urlparse(request.host_url)
    test_url = urlparse(urljoin(request.host_url, target))
    return test_url.scheme in ('http', 'https') and \
        ref_url.netloc == test_url.netloc


def get_redirect_target():
    for target in request.values.get('next'), request.referrer:
        if not target:
            continue
        if is_safe_url(target):
            return target

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

def _do_submit():
    if request.method == 'GET':
        return render_template("submit_run.html")

    assert request.method == 'POST'
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

    # The following accomodates old submitters. Note that we explicitely removed
    # the tag field from the new submission format, this is only here for old
    # submission jobs. The better way of doing it is mentioning the correct
    # test-suite in the URL. So when submitting to suite YYYY use
    # db_XXX/v4/YYYY/submitRun instead of db_XXXX/submitRun!
    if g.testsuite_name is None:
        try:
            data = json.loads(data_value)
            Run = data.get('Run')
            if Run is not None:
                Info = Run.get('Info')
                if Info is not None:
                    g.testsuite_name = Info.get('tag')
        except Exception as e:
            pass
    if g.testsuite_name is None:
        g.testsuite_name = 'nts'

    # Get a DB connection.
    db = request.get_db()

    # Import the data.
    #
    # FIXME: Gracefully handle formats failures and DOS attempts. We
    # should at least reject overly large inputs.

    result = lnt.util.ImportData.import_and_report(
        current_app.old_config, g.db_name, db, path, '<auto>',
        ts_name=g.testsuite_name, commit=commit)

    # It is nice to have a full URL to the run, so fixup the request URL
    # here were we know more about the flask instance.
    if result.get('result_url'):
        result['result_url'] = request.url_root + result['result_url']

    return flask.jsonify(**result)


@db_route('/submitRun', only_v3=False, methods=('GET', 'POST'))
def submit_run():
    """Compatibility url that hardcodes testsuite to 'nts'"""
    # This route doesn't know the testsuite to use. We have some defaults/
    # autodetection for old submissions, but really you should use the full
    # db_XXX/v4/YYYY/submitRun URL when using non-nts suites.
    g.testsuite_name = None
    return _do_submit()


@v4_route('/submitRun', methods=('GET', 'POST'))
def submit_run_ts():
    return _do_submit()

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
    recent_runs = ts.query(ts.Run) \
        .join(ts.Order) \
        .join(ts.Machine) \
        .options(joinedload(ts.Run.order)) \
        .options(joinedload(ts.Run.machine)) \
        .order_by(ts.Run.start_time.desc()).limit(100)
    recent_runs = recent_runs.all()

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
                           active_submissions=active_submissions,
                           ts=ts)

@v4_route("/machine/")
def v4_machines():
    # Compute the list of associated runs, grouped by order.

    # Gather all the runs on this machine.
    ts = request.get_testsuite()

    return render_template("all_machines.html",
                           ts=ts)


@v4_route("/machine/<int:machine_id>/latest")
def v4_machine_latest(machine_id):
    """Return the most recent run on this machine."""
    ts = request.get_testsuite()

    run = ts.query(ts.Run) \
        .filter(ts.Run.machine_id == machine_id) \
        .order_by(ts.Run.start_time.desc()) \
        .first()
    return redirect(v4_url_for('v4_run', id=run.id, **request.args))


@v4_route("/machine/<int:machine_id>/compare")
def v4_machine_compare(machine_id):
    """Return the most recent run on this machine."""
    ts = request.get_testsuite()
    machine_compare_to_id = int(request.args['compare_to_id'])
    machine_1_run = ts.query(ts.Run) \
        .filter(ts.Run.machine_id == machine_id) \
        .order_by(ts.Run.start_time.desc()) \
        .first()

    machine_2_run = ts.query(ts.Run) \
        .filter(ts.Run.machine_id == machine_compare_to_id) \
        .order_by(ts.Run.start_time.desc()) \
        .first()

    return redirect(v4_url_for('v4_run', id=machine_1_run.id, compare_to=machine_2_run.id))


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

    machines = ts.query(ts.Machine).all()

    if request.args.get('json'):
        json_obj = dict()
        try:
            machine_obj = ts.query(ts.Machine).filter(ts.Machine.id == id).one()
        except NoResultFound:
            abort(404)
        json_obj['name'] = machine_obj.name
        json_obj['id'] = machine_obj.id
        json_obj['runs'] = []
        for order in associated_runs:
            rev = order[0].llvm_project_revision
            for run in order[1]:
                json_obj['runs'].append((run.id, rev,
                                         run.start_time.isoformat(), run.end_time.isoformat()))
        return flask.jsonify(**json_obj)
    try:
        return render_template("v4_machine.html",
                               testsuite_name=g.testsuite_name,
                               id=id,
                               associated_runs=associated_runs,
                               machines=machines)
    except NoResultFound:
        abort(404)

class V4RequestInfo(object):
    def __init__(self, run_id):
        self.db = request.get_db()
        self.ts = ts = request.get_testsuite()
        self.run = run = ts.query(ts.Run).filter_by(id=run_id).first()
        if run is None:
            abort(404)

        # Get the aggregation function to use.
        aggregation_fn_name = request.args.get('aggregation_fn')
        self.aggregation_fn = {'min': lnt.util.stats.safe_min,
                               'median': lnt.util.stats.median}.get(
            aggregation_fn_name, lnt.util.stats.safe_min)

        # Get the MW confidence level.
        try:
            confidence_lv = float(request.args.get('MW_confidence_lv'))
        except (TypeError, ValueError):
            confidence_lv = .05
        self.confidence_lv = confidence_lv

        # Find the neighboring runs, by order.
        prev_runs = list(ts.get_previous_runs_on_machine(run, N=3))
        next_runs = list(ts.get_next_runs_on_machine(run, N=3))
        self.neighboring_runs = next_runs[::-1] + [self.run] + prev_runs

        # Select the comparison run as either the previous run, or a user
        # specified comparison run.
        compare_to_str = request.args.get('compare_to')
        if compare_to_str:
            compare_to_id = int(compare_to_str)
            compare_to = ts.query(ts.Run).filter_by(id=compare_to_id).first()
            if compare_to is None:
                flash("Comparison Run is invalid: " + compare_to_str,
                      FLASH_DANGER)
            else:
                self.comparison_neighboring_runs = (
                    list(ts.get_next_runs_on_machine(compare_to, N=3))[::-1] +
                    [compare_to] +
                    list(ts.get_previous_runs_on_machine(compare_to, N=3)))
        else:
            if prev_runs:
                compare_to = prev_runs[0]
            else:
                compare_to = None
            self.comparison_neighboring_runs = self.neighboring_runs

        try:
            self.num_comparison_runs = int(
                request.args.get('num_comparison_runs'))
        except:
            self.num_comparison_runs = 0

        # Find the baseline run, if requested.
        baseline_str = request.args.get('baseline')
        if baseline_str:
            baseline_id = int(baseline_str)
            baseline = ts.query(ts.Run).filter_by(id=baseline_id).first()
            if baseline is None:
                flash("Could not find baseline " + baseline_str, FLASH_DANGER)
        else:
            baseline = None

        # Gather the runs to use for statistical data.
        comparison_start_run = compare_to or self.run

        # We're going to render this on a real webpage with CSS support, so
        # override the default styles and provide bootstrap class names for
        # the tables.
        styles = {
            'body': '', 'td': '',
            'h1': 'font-size: 14pt',
            'table': 'width: initial; font-size: 9pt;',
            'th': 'text-align: center;'
        }
        classes = {
            'table': 'table table-striped table-condensed table-hover'
        }

        self.data = lnt.server.reporting.runs.generate_run_data(
            self.run, baseurl=db_url_for('index', _external=True),
            result=None, compare_to=compare_to, baseline=baseline,
            num_comparison_runs=self.num_comparison_runs,
            aggregation_fn=self.aggregation_fn, confidence_lv=confidence_lv,
            styles=styles, classes=classes)
        self.sri = self.data['sri']
        note = self.data['visible_note']
        if note:
            flash(note, FLASH_INFO)

@v4_route("/<int:id>/report")
def v4_report(id):
    info = V4RequestInfo(id)
    return render_template('reporting/run_report.html', **info.data)

@v4_route("/<int:id>/text_report")
def v4_text_report(id):
    info = V4RequestInfo(id)

    text_report = render_template('reporting/run_report.txt', **info.data)
    response = make_response(text_report)
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
    options['show_small_diff'] = bool(request.args.get('show_small_diff'))
    options['hide_report_by_default'] = bool(
        request.args.get('hide_report_by_default'))
    options['num_comparison_runs'] = info.num_comparison_runs
    options['test_filter'] = test_filter_str = request.args.get(
        'test_filter', '')
    options['MW_confidence_lv'] = info.confidence_lv
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

    if request.args.get('json'):
        json_obj = dict()

        sri = lnt.server.reporting.analysis.RunInfo(ts, [id])
        reported_tests = ts.query(ts.Test.name, ts.Test.id).\
            filter(ts.Run.id == id).\
            filter(ts.Test.id.in_(sri.test_ids)).all()
        order = run.order.as_ordered_string()

        for test_name, test_id in reported_tests:
            test = dict(test_name=test_name, test_id=test_id,
                        order=order, machine=run.machine.name)
            for sample_field in ts.sample_fields:
                res = sri.get_run_comparison_result(
                    run, None, test_id, sample_field,
                    ts.Sample.get_hash_of_binary_field())
                test[sample_field.name] = res.current
            json_obj[test_name] = test

        return flask.jsonify(**json_obj)

    urls = {
        'search': v4_url_for('v4_search')
    }
    data = info.data
    data.update({
        'analysis': lnt.server.reporting.analysis,
        'metric_fields': list(ts.Sample.get_metric_fields()),
        'options': options,
        'request_info': info,
        'test_info': test_info,
        'test_min_value_filter': test_min_value_filter,
        'urls': urls,
    })
    return render_template("v4_run.html", **data)


class PromoteOrderToBaseline(Form):
    name = StringField('Name', validators=[DataRequired(), Length(max=32)])
    description = StringField('Description', validators=[Length(max=256)])
    promote = SubmitField('Promote')
    update = SubmitField('Update')
    demote = SubmitField('Demote')


@v4_route("/order/<int:id>", methods=['GET', 'POST'])
def v4_order(id):
    """Order page details order information, as well as runs that are in this
    order as well setting this run as a baseline."""
    ts = request.get_testsuite()
    form = PromoteOrderToBaseline()

    if form.validate_on_submit():
        try:
            baseline = ts.query(ts.Baseline) \
                .filter(ts.Baseline.order_id == id) \
                .one()
        except NoResultFound:
            baseline = ts.Baseline()

        if form.demote.data:
            ts.session.delete(baseline)
            ts.session.commit()

            flash("Baseline demoted.", FLASH_SUCCESS)
        else:
            baseline.name = form.name.data
            baseline.comment = form.description.data
            baseline.order_id = id
            ts.session.add(baseline)
            ts.session.commit()

            flash("Baseline {} updated.".format(baseline.name), FLASH_SUCCESS )
        return redirect(v4_url_for("v4_order", id=id))
    else:
        print form.errors

    try:
        baseline = ts.query(ts.Baseline) \
            .filter(ts.Baseline.order_id == id) \
            .one()
        form.name.data = baseline.name
        form.description.data = baseline.comment
    except NoResultFound:
        pass

    # Get the order.
    order = ts.query(ts.Order).filter(ts.Order.id == id).first()
    if order is None:
        abort(404)

    return render_template("v4_order.html", ts=ts, order=order, form=form)


@v4_route("/set_baseline/<int:id>")
def v4_set_baseline(id):
    """Update the baseline stored in the user's session."""
    ts = request.get_testsuite()
    base = ts.query(ts.Baseline).get(id)
    if not base:
        return abort(404)
    flash("Baseline set to " + base.name, FLASH_SUCCESS)
    session[baseline_key()] = id

    return redirect(get_redirect_target())


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
LegendItem = namedtuple('LegendItem', 'machine test_name field_name color url')

@v4_route("/graph")
def v4_graph():
    from lnt.server.ui import util
    from lnt.testing import PASS
    from lnt.util import stats
    from lnt.external.stats import stats as ext_stats

    ts = request.get_testsuite()
    switch_min_mean_local = False

    if 'switch_min_mean_session' not in session:
        session['switch_min_mean_session'] = False
    # Parse the view options.
    options = {'min_mean_checkbox': 'min()'}
    if 'submit' in request.args:  # user pressed a button
        if 'switch_min_mean' in request.args:  # user checked mean() checkbox
            session['switch_min_mean_session'] = options['switch_min_mean'] = \
                bool(request.args.get('switch_min_mean'))
            switch_min_mean_local = session['switch_min_mean_session']
        else:  # mean() check box is not checked
            session['switch_min_mean_session'] = options['switch_min_mean'] = \
                bool(request.args.get('switch_min_mean'))
            switch_min_mean_local = session['switch_min_mean_session']
    else:  # new page was loaded by clicking link, not submit button
        options['switch_min_mean'] = switch_min_mean_local = \
            session['switch_min_mean_session']

    options['hide_lineplot'] = bool(request.args.get('hide_lineplot'))
    show_lineplot = not options['hide_lineplot']
    options['show_mad'] = show_mad = bool(request.args.get('show_mad'))
    options['show_stddev'] = show_stddev = bool(request.args.get('show_stddev'))
    options['hide_all_points'] = hide_all_points = bool(
        request.args.get('hide_all_points'))
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
            return abort(404)

        try:
            machine = \
                ts.query(ts.Machine).filter(ts.Machine.id == machine_id).one()
            test = ts.query(ts.Test).filter(ts.Test.id == test_id).one()
            field = ts.sample_fields[field_index]
        except NoResultFound:
            return abort(404)
        graph_parameters.append((machine, test, field, field_index))

    # Order the plots by machine name, test name and then field.
    graph_parameters.sort(key = lambda (m,t,f,_): (m.name, t.name, f.name, _))

    # Extract requested mean trend.
    mean_parameter = None
    for name,value in request.args.items():
        # Mean to graph is passed as:
        #
        #  mean=<machine id>.<field index>
        if name != 'mean':
            continue

        machine_id_str,field_index_str  = value.split('.')
        try:
            machine_id = int(machine_id_str)
            field_index = int(field_index_str)
        except ValueError:
            return abort(400)

        if not (0 <= field_index < len(ts.sample_fields)):
            return abort(404)

        try:
            machine = \
                ts.query(ts.Machine).filter(ts.Machine.id == machine_id).one()
        except NoResultFound:
            return abort(404)
        field = ts.sample_fields[field_index]

        mean_parameter = (machine, field)

    # Sanity check the arguments.
    if not graph_parameters and not mean_parameter:
        return render_template("error.html", message="Nothing to graph.")

    # Extract requested baselines, and their titles.
    baseline_parameters = []
    for name,value in request.args.items():
        # Baselines to graph are passed as:
        #
        #  baseline.title=<run id>
        if not name.startswith(str('baseline.')):
            continue

        baseline_title = name[len('baseline.'):]

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

        baseline_parameters.append((run, baseline_title))

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
    graph_datum = []
    overview_plots = []
    baseline_plots = []
    num_plots = len(graph_parameters)
    for i,(machine,test,field, field_index) in enumerate(graph_parameters):
        # Determine the base plot color.
        col = list(util.makeDarkColor(float(i) / num_plots))
        url = "/".join([str(machine.id), str(test.id), str(field_index)])
        legend.append(LegendItem(machine, test.name, field.name, tuple(col), url))

        # Load all the field values for this test on the same machine.
        #
        # FIXME: Don't join to Order here, aggregate this across all the tests
        # we want to load. Actually, we should just make this a single query.
        #
        # FIXME: Don't hard code field name.
        q = ts.query(field.column, ts.Order.llvm_project_revision, ts.Run.start_time, ts.Run.id).\
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
        data = util.multidict((rev, (val, date, run_id)) for val,rev,date,run_id in q).items()
        data.sort(key=lambda sample: convert_revision(sample[0]))

        graph_datum.append((test.name, data, col, field, url))

        # Get baselines for this line
        num_baselines = len(baseline_parameters)
        for baseline_id, (baseline, baseline_title) in enumerate(baseline_parameters):
            q_baseline = ts.query(field.column, ts.Order.llvm_project_revision, ts.Run.start_time, ts.Machine.name).\
                         join(ts.Run).join(ts.Order).join(ts.Machine).\
                         filter(ts.Run.id == baseline.id).\
                         filter(ts.Sample.test == test).\
                         filter(field.column != None)
            # In the event of many samples, use the mean of the samples as the baseline.
            samples = []
            for sample in q_baseline:
                samples.append(sample[0])
            # Skip this baseline if there is no data.
            if not samples:
                continue
            mean = sum(samples)/len(samples)
            # Darken the baseline color distinguish from non-baselines.
            # Make a color closer to the sample than its neighbour.
            color_offset = float(baseline_id) / num_baselines / 2
            my_color = (i + color_offset) / num_plots
            dark_col = list(util.makeDarkerColor(my_color))
            str_dark_col =  util.toColorString(dark_col)
            baseline_plots.append({'color': str_dark_col,
                                   'lineWidth': 2,
                                   'yaxis': {'from': mean, 'to': mean},
                                   'name': q_baseline[0].llvm_project_revision})
            baseline_name = "Baseline {} on {}".format(baseline_title,  q_baseline[0].name)
            legend.append(LegendItem(BaselineLegendItem(baseline_name, baseline.id), test.name, field.name, dark_col, None))

    # Draw mean trend if requested.
    if mean_parameter:
        machine, field = mean_parameter
        test_name = 'Geometric Mean'

        col = (0,0,0)
        legend.append(LegendItem(machine, test_name, field.name, col, None))

        q = ts.query(sqlalchemy.sql.func.min(field.column),
                ts.Order.llvm_project_revision,
                sqlalchemy.sql.func.min(ts.Run.start_time)).\
            join(ts.Run).join(ts.Order).join(ts.Test).\
            filter(ts.Run.machine_id == machine.id).\
            filter(field.column != None).\
            group_by(ts.Order.llvm_project_revision, ts.Test)

        # Calculate geomean of each revision.
        data = util.multidict(((rev, date), val) for val,rev,date in q).items()
        data = [(rev, [(lnt.server.reporting.analysis.calc_geomean(vals), date)])
                for ((rev, date), vals) in data]

        # Sort data points according to revision number.
        data.sort(key=lambda sample: convert_revision(sample[0]))

        graph_datum.append((test_name, data, col, field, None))

    for name, data, col, field, url in graph_datum:
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

        using_ints = True
        for pos, (point_label, datapoints) in enumerate(data):
            # Get the samples.
            data = [data_date[0] for data_date in datapoints]
            # And the date on which they were taken.
            dates = [data_date[1] for data_date in datapoints]
            # Run where this point was collected.
            runs = [data_pts[2] for data_pts in datapoints if len(data_pts)==3]

            # When we can, map x-axis to revisions, but when that is too hard
            # use the position of the sample instead.
            rev_x = convert_revision(point_label)
            if using_ints and len(rev_x) != 1:
                using_ints = False
            x = rev_x[0] if using_ints else pos

            values = [v*normalize_by for v in data]
            aggregation_fn = min

            if switch_min_mean_local:
                aggregation_fn = lnt.util.stats.agg_mean
            if field.bigger_is_better:
                aggregation_fn = max

            agg_value, agg_index = \
                aggregation_fn((value, index)
                               for (index, value) in enumerate(values))

            # Generate metadata.
            metadata = {"label": point_label}
            metadata["date"] = str(dates[agg_index])
            if runs:
                metadata["runID"] = str(runs[agg_index])

            if len(graph_datum) > 1:
                # If there are more than one plot in the graph, also label the
                # test name.
                metadata["test_name"] = name

            pts.append((x, agg_value, metadata))

            # Add the individual points, if requested.
            # For each point add a text label for the mouse over.
            if not hide_all_points:
                for i,v in enumerate(values):
                    point_metadata = dict(metadata)
                    point_metadata["date"] = str(dates[i])
                    points_data.append((x, v, point_metadata))

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
            plot = {"data" : pts,
                    "color" : util.toColorString(col)
                    }
            if url:
                plot["url"] = url
            graph_plots.append(plot)
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
            plot = {"data" : points_data,
                    "color" : util.toColorString(pts_col),
                    "lines" : {"show" : False },
                    "points" : {
                        "show" : True,
                        "radius" : .25,
                        "fill" : True
                        }
                    }
            if url:
                plot['url'] = url
            graph_plots.append(plot)

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
        for li in legend:
            # Flatten name, make color a dict.
            new_entry = {'name': li.machine.name,
                         'test': li.test_name,
                         'unit': li.field_name,
                         'color': util.toColorString(li.color),
                         'url': li.url}
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
    metric_fields = sorted(list(ts.Sample.get_metric_fields()),
                           key=lambda f: f.name)
    fields = dict((f.name, f) for f in metric_fields)

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
    field = fields.get(request.args.get('field', None), metric_fields[0])

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
    for i, (test_id, test_name) in enumerate(reported_tests):
        # Create the row, starting with the test name and worst entry.
        row = [(test_id, test_name), None]

        # Compute comparison results for each machine.
        row.extend((runinfo.get_run_comparison_result(
                        run, baseline, test_id, field,
                        ts.Sample.get_hash_of_Binary_field),
                    run.id)
                   for baseline, run in machine_run_info)

        # Compute the worst cell value.
        row[1] = max(cr.pct_delta
                     for cr, _ in row[2:])

        test_table.append(row)

    # Order the table by worst regression.
    test_table.sort(key = lambda row: row[1], reverse=True)

    return render_template("v4_global_status.html",
                           ts=ts,
                           tests=test_table,
                           machines=recent_machines,
                           fields=metric_fields,
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

    extra_args = request.args.copy()
    extra_args.pop("year", None)
    extra_args.pop("month", None)
    extra_args.pop("day", None)

    return redirect(v4_url_for("v4_daily_report",
                               year=date.year, month=date.month, day=date.day,
                               **extra_args))

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

    filter_machine_regex = request.args.get('filter-machine-regex')

    ts = request.get_testsuite()

    # Create the report object.
    report = lnt.server.reporting.dailyreport.DailyReport(
        ts, year, month, day, num_days, day_start,
        filter_machine_regex=filter_machine_regex)

    # Build the report.
    try:
        report.build()
    except ValueError:
        return abort(400)

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


@frontend.route('/rules')
def rules():
    discovered_rules = lnt.server.db.rules_manager.DESCRIPTIONS
    return render_template("rules.html",rules=discovered_rules)

@frontend.route('/log')
def log():
    async_ops.check_workers(True)
    return render_template("log.html")

@frontend.route('/debug')
def debug():
    assert current_app.debug == False


@frontend.route('/__health')
def health():
    """Our instnace health. If queue is too long or we use too much mem,
    return 500.  Monitor might reboot us for this."""
    explode = False
    msg = "Ok"
    queue_length = async_ops.check_workers(False)
    if queue_length > 10:
        explode = True
        msg = "Queue too long."

    import resource
    stats = resource.getrusage(resource.RUSAGE_SELF)
    mem = stats.ru_maxrss
    if mem > 1024**3:
        explode = True
        msg = "Over memory " + str(mem) + ">" + str(1024**3)
    if explode:
        return msg, 500
    return msg, 200

@v4_route("/search")
def v4_search():
    def _isint(i):
        try:
            int(i)
            return True
        except:
            return False

    ts = request.get_testsuite()
    query = request.args.get('q')
    l = request.args.get('l', 8)
    default_machine = request.args.get('m', None)

    assert query
    results = lnt.server.db.search.search(ts, query, num_results=l,
                                          default_machine=default_machine)

    return json.dumps(
        [('%s #%s' % (r.machine.name, r.order.llvm_project_revision),
          r.id)
         for r in results])


class MatrixDataRequest(object):
    def __init__(self, machine, test, field):
        self.machine = machine
        self.test = test
        self.field = field

    def __repr__(self):
        return "{}:{}({} samples)" \
            .format(self.machine.name,
                    self.test.name,
                    len(self.samples) if self.samples else "No")


# How much data to render in the Matrix view.
MATRIX_LIMITS = [('12', 'Small'),
                 ('50', 'Medium'),
                 ('250', 'Large'),
                 ('-1', 'All')]


class MatrixOptions(Form):
    limit = SelectField('Size', choices=MATRIX_LIMITS)


def baseline():
    # type: () -> Optional[testsuitedb.Baseline]
    """Get the baseline object from the user's current session baseline value
    or None if one is not defined.
    """
    ts = request.get_testsuite()
    base_id = session.get(baseline_key())
    if not base_id:
        return None
    try:
        base = ts.query(ts.Baseline).get(base_id)
    except NoResultFound:
        return None
    return base


@v4_route("/matrix", methods=['GET', 'POST'])
def v4_matrix():
    """A table view for Run sample data, because *some* people really
    like to be able to see results textually.
    request.args.limit limits the number of samples.
    for each dataset to add, there will be a "plot.n=.m.b.f" where m is machine
    ID, b is benchmark ID and f os field kind offset. "n" is used to unique
    the paramters, and is ignored.

    """
    ts = request.get_testsuite()
    # Load the matrix request parameters.
    form = MatrixOptions(request.form)
    if request.method == 'POST':
        post_limit = form.limit.data
    else:
        post_limit = MATRIX_LIMITS[0][0]
    data_parameters = []  # type: List[MatrixDataRequest]
    for name, value in request.args.items():
        #  plot.<unused>=<machine id>.<test id>.<field index>
        if not name.startswith(str('plot.')):
            continue

        # Ignore the extra part of the key, it is unused.
        machine_id_str, test_id_str, field_index_str = value.split('.')
        try:
            machine_id = int(machine_id_str)
            test_id = int(test_id_str)
            field_index = int(field_index_str)
        except ValueError:
            err_msg = "data {} was malformed. {} must be int.int.int"
            return abort(400, err_msg.format(name, value))

        if not (0 <= field_index < len(ts.sample_fields)):
            return abort(404, "Invalid field index: {}".format(field_index))

        try:
            machine = \
                ts.query(ts.Machine).filter(ts.Machine.id == machine_id).one()
        except NoResultFound:
            return abort(404, "Invalid machine ID: {}".format(machine_id))
        try:
            test = ts.query(ts.Test).filter(ts.Test.id == test_id).one()
        except NoResultFound:
            return abort(404, "Invalid test ID: {}".format(test_id))
        try:
            field = ts.sample_fields[field_index]
        except NoResultFound:
            return abort(404, "Invalid field_index: {}".format(field_index))

        valid_request = MatrixDataRequest(machine, test, field)
        data_parameters.append(valid_request)

    if not data_parameters:
        abort(404, "Request requires some data arguments.")
    # Feature: if all of the results are from the same machine, hide the name to
    # make the headers more compact.
    dedup = True
    for r in data_parameters:
        if r.machine.id != data_parameters[0].machine.id:
            dedup = False
    if dedup:
        machine_name_common = data_parameters[0].machine.name
        machine_id_common = data_parameters[0].machine.id
    else:
        machine_name_common = machine_id_common = None

    # It is nice for the columns to be sorted by name.
    data_parameters.sort(key=lambda x: x.test.name),

    # Now lets get the data.
    all_orders = set()
    order_to_id = {}
    for req in data_parameters:
        q = ts.query(req.field.column, ts.Order.llvm_project_revision, ts.Order.id) \
            .join(ts.Run) \
            .join(ts.Order) \
            .filter(ts.Run.machine_id == req.machine.id) \
            .filter(ts.Sample.test == req.test) \
            .filter(req.field.column != None) \
            .order_by(ts.Order.llvm_project_revision.desc())

        limit = request.args.get('limit', post_limit)
        if limit or post_limit:
            limit = int(limit)
            if limit != -1:
                q = q.limit(limit)

        req.samples = defaultdict(list)

        for s in q.all():
            req.samples[s[1]].append(s[0])
            all_orders.add(s[1])
            order_to_id[s[1]] = s[2]
        req.derive_stat = {}
        for order, samples in req.samples.items():
            req.derive_stat[order] = mean(samples)
    if not all_orders:
        abort(404, "No data found.")
    # Now grab the baseline data.
    user_baseline = baseline()
    backup_baseline = next(iter(all_orders))
    if user_baseline:
        all_orders.add(user_baseline.order.llvm_project_revision)
        baseline_rev = user_baseline.order.llvm_project_revision
        baseline_name = user_baseline.name
    else:
        baseline_rev = backup_baseline
        baseline_name = backup_baseline

    for req in data_parameters:
        q_baseline = ts.query(req.field.column, ts.Order.llvm_project_revision, ts.Order.id) \
                       .join(ts.Run) \
                       .join(ts.Order) \
                       .filter(ts.Run.machine_id == req.machine.id) \
                       .filter(ts.Sample.test == req.test) \
                       .filter(req.field.column != None) \
                       .filter(ts.Order.llvm_project_revision == baseline_rev)
        baseline_data = q_baseline.all()
        if baseline_data:
            for s in baseline_data:
                req.samples[s[1]].append(s[0])
                all_orders.add(s[1])
                order_to_id[s[1]] = s[2]
        else:
            # Well, there is a baseline, but we did not find data for it...
            # So lets revert back to the first run.
            msg = "Did not find data for {}. Showing {}."
            flash(msg.format(user_baseline, backup_baseline), FLASH_DANGER)
            all_orders.remove(baseline_rev)
            baseline_rev = backup_baseline
            baseline_name = backup_baseline

    all_orders = list(all_orders)
    all_orders.sort(reverse=True)
    all_orders.insert(0, baseline_rev)
    # Now calculate Changes between each run.

    for req in data_parameters:
        req.change = {}
        for order in all_orders:
            cur_samples = req.samples[order]
            prev_samples = req.samples.get(baseline_rev, None)
            cr = ComparisonResult(mean,
                                  False, False,
                                  cur_samples,
                                  prev_samples,
                                  None, None,
                                  confidence_lv=0.05,
                                  bigger_is_better=False)
            req.change[order] = cr

    # Calculate Geomean for each order.
    order_to_geomean = {}
    curr_geomean = None
    for order in all_orders:
        curr_samples = []
        prev_samples = []
        for req in data_parameters:
            curr_samples.extend(req.samples[order])
            prev_samples.extend(req.samples[baseline_rev])
        prev_geomean = calc_geomean(prev_samples)
        curr_geomean = calc_geomean(curr_samples)
        if prev_geomean:
            cr = ComparisonResult(mean,
                                  False, False,
                                  [curr_geomean],
                                  [prev_geomean],
                                  None, None,
                                  confidence_lv=0.05,
                                  bigger_is_better=False)
            order_to_geomean[order] = cr
        else:
            # There will be no change here, but display current val.
            if curr_geomean:
                order_to_geomean[order] = PrecomputedCR(curr_geomean,
                                                        curr_geomean,
                                                        False)
    # Calculate the date of each order.
    runs = ts.query(ts.Run.start_time, ts.Order.llvm_project_revision) \
             .join(ts.Order) \
             .filter(ts.Order.llvm_project_revision.in_(all_orders)) \
             .all()

    order_to_date = dict([(x[1], x[0]) for x in runs])

    class FakeOptions(object):
        show_small_diff = False
        show_previous = False
        show_all = True
        show_delta = False
        show_stddev = False
        show_mad = False
        show_all_samples = False
        show_sample_counts = False

    return render_template("v4_matrix.html",
                           testsuite_name=g.testsuite_name,
                           associated_runs=data_parameters,
                           orders=all_orders,
                           options=FakeOptions(),
                           analysis=lnt.server.reporting.analysis,
                           geomeans=order_to_geomean,
                           order_to_id=order_to_id,
                           form=form,
                           baseline_rev=baseline_rev,
                           baseline_name=baseline_name,
                           machine_name_common=machine_name_common,
                           machine_id_common=machine_id_common,
                           order_to_date=order_to_date)


@frontend.route("/explode")
def explode():
    """This route is going to exception. Used for testing 500 page."""
    return 1/0


@frontend.route("/gone")
def gone():
    """This route returns 404. Used for testing 404 page."""
    abort(404, "test")

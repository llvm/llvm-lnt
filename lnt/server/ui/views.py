import datetime
import json
import os
import re
import time
import typing  # noqa: F401
from collections import namedtuple, defaultdict
from urllib.parse import urlparse, urljoin
from io import BytesIO

import flask
import flask_wtf
import sqlalchemy.sql
from flask import abort
from flask import current_app
from flask import flash
from flask import g
from flask import make_response
from flask import render_template
from flask import request, url_for
from flask import send_file
from sqlalchemy.orm import joinedload
from sqlalchemy.orm.exc import NoResultFound
from wtforms import SelectField, StringField, SubmitField
from wtforms.validators import DataRequired, Length

import lnt.server.db.rules_manager
import lnt.server.db.search
import lnt.server.reporting.analysis
import lnt.server.reporting.dailyreport
import lnt.server.reporting.latestrunsreport
import lnt.server.reporting.runs
import lnt.server.reporting.summaryreport
import lnt.server.ui.util
import lnt.util
import lnt.util.ImportData
import lnt.util.stats
from lnt.external.stats import stats as ext_stats
from lnt.server.db import testsuitedb  # noqa: F401
from lnt.server.reporting.analysis import ComparisonResult, calc_geomean
from lnt.server.ui import util
from lnt.server.ui.decorators import frontend, db_route, v4_route
from lnt.server.ui.globals import db_url_for, v4_url_for, v4_redirect
from lnt.server.ui.util import FLASH_DANGER, FLASH_SUCCESS, FLASH_INFO
from lnt.server.ui.util import PrecomputedCR
from lnt.server.ui.util import baseline_key, convert_revision
from lnt.server.ui.util import mean
from lnt.testing import PASS
from lnt.util import logger
from lnt.util import multidict
from lnt.util import stats


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
    return v4_redirect(url_for('.static', filename='favicon.ico'))


@frontend.route('/select_db')
def select_db():
    path = request.args.get('path')
    db = request.args.get('db')
    if path is None:
        abort(400, "'path' argument is missing")
    if db not in current_app.old_config.databases:
        abort(404, "'db' argument is missing or invalid")

    # Rewrite the path.
    new_path = "/db_%s" % db
    if not path.startswith("/db_"):
        new_path += path
    else:
        if '/' in path[1:]:
            new_path += "/" + path.split("/", 2)[2]
    return v4_redirect(request.script_root + new_path)

#####
# Per-Database Routes


@db_route('/')
def index():
    return render_template("index.html")


###
# Database Actions
def _do_submit():
    assert request.method == 'POST'
    input_file = request.files.get('file')
    input_data = request.form.get('input_data')
    if 'select_machine' not in request.form and \
            'update_machine' in request.form:
        # Compatibility with old clients
        update_machine = int(request.form.get('update_machine', 0)) != 0
        select_machine = 'update' if update_machine else 'match'
    else:
        select_machine = request.form.get('select_machine', 'match')
    merge_run = request.form.get('merge', None)
    ignore_regressions = request.form.get('ignore_regressions', False) \
        or getattr(current_app.old_config, 'ignore_regressions', False)

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

    # The following accomodates old submitters. Note that we explicitely
    # removed the tag field from the new submission format, this is only here
    # for old submission jobs. The better way of doing it is mentioning the
    # correct test-suite in the URL. So when submitting to suite YYYY use
    # db_XXX/v4/YYYY/submitRun instead of db_XXXX/submitRun!
    if g.testsuite_name is None:
        try:
            data = json.loads(data_value)
            Run = data.get('Run')
            if Run is not None:
                Info = Run.get('Info')
                if Info is not None:
                    g.testsuite_name = Info.get('tag')
        except Exception:
            pass
    if g.testsuite_name is None:
        g.testsuite_name = 'nts'

    # Get a DB connection.
    session = request.session
    db = request.get_db()

    result = lnt.util.ImportData.import_from_string(
        current_app.old_config, g.db_name, db, session, g.testsuite_name,
        data_value, select_machine=select_machine, merge_run=merge_run,
        ignore_regressions=ignore_regressions)

    # It is nice to have a full URL to the run, so fixup the request URL
    # here were we know more about the flask instance.
    if result.get('result_url'):
        result['result_url'] = request.url_root + result['result_url']

    response = flask.jsonify(**result)
    error = result['error']
    if error is not None:
        response.status_code = 400
        logger.warning("%s: Submission rejected: %s" % (request.url, error))
    return response


def ts_data(ts):
    """Data about the current testsuite used by layout.html which should be
    present in most templates."""
    baseline_id = flask.session.get(baseline_key(ts.name))
    baselines = request.session.query(ts.Baseline).all()
    return {
        'baseline_id': baseline_id,
        'baselines': baselines,
        'ts': ts
    }


def determine_aggregation_function(function_name):
    """
    Return the aggregation function associated to the provided function name, or None if
    the function name is unsupported.

    This is used by dropdown menus that allow selecting from multiple aggregation functions.
    """
    if function_name == 'min':
        return lnt.util.stats.safe_min
    elif function_name == 'max':
        return lnt.util.stats.safe_max
    elif function_name == 'mean':
        return lnt.util.stats.mean
    elif function_name == 'median':
        return lnt.util.stats.median
    else:
        return None


@db_route('/submitRun', methods=('GET', 'POST'))
def submit_run():
    """Compatibility url that hardcodes testsuite to 'nts'"""
    if request.method == 'GET':
        g.testsuite_name = 'nts'
        return v4_redirect(v4_url_for('.v4_submitRun'))

    # This route doesn't know the testsuite to use. We have some defaults/
    # autodetection for old submissions, but really you should use the full
    # db_XXX/v4/YYYY/submitRun URL when using non-nts suites.
    g.testsuite_name = None
    return _do_submit()


@v4_route('/submitRun', methods=('GET', 'POST'))
def v4_submitRun():
    if request.method == 'GET':
        ts = request.get_testsuite()
        return render_template("submit_run.html", **ts_data(ts))
    return _do_submit()

###
# V4 Schema Viewer


@v4_route("/")
def v4_overview():
    ts = request.get_testsuite()
    return render_template("v4_overview.html", testsuite_name=g.testsuite_name,
                           **ts_data(ts))


@v4_route("/recent_activity")
def v4_recent_activity():
    session = request.session
    ts = request.get_testsuite()

    # Get the most recent runs in this tag, we just arbitrarily limit to
    # looking at the last 100 submission.
    recent_runs = session.query(ts.Run) \
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
                           **ts_data(ts))


@v4_route("/machine/")
def v4_machines():
    # Compute the list of associated runs, grouped by order.

    # Gather all the runs on this machine.
    session = request.session
    ts = request.get_testsuite()
    machines = session.query(ts.Machine).order_by(ts.Machine.name)

    return render_template("all_machines.html", machines=machines,
                           **ts_data(ts))


@v4_route("/machine/<int:machine_id>/latest")
def v4_machine_latest(machine_id):
    """Return the most recent run on this machine."""
    session = request.session
    ts = request.get_testsuite()

    run = session.query(ts.Run) \
        .filter(ts.Run.machine_id == machine_id) \
        .order_by(ts.Run.start_time.desc()) \
        .first()
    return v4_redirect(v4_url_for('.v4_run', id=run.id, **request.args))


@v4_route("/machine/<int:machine_id>/compare")
def v4_machine_compare(machine_id):
    """Return the most recent run on this machine."""
    session = request.session
    ts = request.get_testsuite()
    machine_compare_to_id = int(request.args['compare_to_id'])
    machine_1_run = session.query(ts.Run) \
        .filter(ts.Run.machine_id == machine_id) \
        .order_by(ts.Run.start_time.desc()) \
        .first()

    machine_2_run = session.query(ts.Run) \
        .filter(ts.Run.machine_id == machine_compare_to_id) \
        .order_by(ts.Run.start_time.desc()) \
        .first()

    return v4_redirect(v4_url_for('.v4_run', id=machine_1_run.id,
                                  compare_to=machine_2_run.id))


@v4_route("/machine/<int:id>")
def v4_machine(id):

    # Compute the list of associated runs, grouped by order.

    # Gather all the runs on this machine.
    session = request.session
    ts = request.get_testsuite()

    associated_runs = multidict.multidict(
        (run_order, r)
        for r, run_order in (session.query(ts.Run, ts.Order)
                             .join(ts.Order)
                             .filter(ts.Run.machine_id == id)
                             .order_by(ts.Run.start_time.desc())))
    associated_runs = sorted(associated_runs.items())

    try:
        machine = session.query(ts.Machine).filter(ts.Machine.id == id).one()
    except NoResultFound:
        abort(404, "Invalid machine id {}".format(id))

    if request.args.get('json'):
        json_obj = dict()
        json_obj['name'] = machine.name
        json_obj['id'] = machine.id
        json_obj['runs'] = []
        for order in associated_runs:
            rev = order[0].llvm_project_revision
            for run in order[1]:
                json_obj['runs'].append((run.id, rev,
                                         run.start_time.isoformat(),
                                         run.end_time.isoformat()))
        return flask.jsonify(**json_obj)

    machines = session.query(ts.Machine).order_by(ts.Machine.name).all()
    relatives = [m for m in machines if m.name == machine.name]
    return render_template("v4_machine.html",
                           testsuite_name=g.testsuite_name,
                           id=id,
                           associated_runs=associated_runs,
                           machine=machine,
                           machines=machines,
                           relatives=relatives,
                           **ts_data(ts))


class V4RequestInfo(object):
    def __init__(self, run_id):
        session = request.session
        self.db = request.get_db()
        self.session = session
        self.ts = ts = request.get_testsuite()
        self.run = run = session.query(ts.Run).filter_by(id=run_id).first()
        if run is None:
            abort(404, "Invalid run id {}".format(run_id))

        # Get the aggregation function to use.
        fn_name = request.args.get('aggregation_function', 'min')
        aggregation_fn = determine_aggregation_function(fn_name)
        if aggregation_fn is None:
            abort(404, "Invalid aggregation function name {}".format(fn_name))

        # Get the MW confidence level.
        try:
            confidence_lv = float(request.args.get('MW_confidence_lv'))
        except (TypeError, ValueError):
            confidence_lv = .05
        self.confidence_lv = confidence_lv

        # Find the neighboring runs, by order.
        prev_runs = list(ts.get_previous_runs_on_machine(session, run, N=3))
        next_runs = list(ts.get_next_runs_on_machine(session, run, N=3))
        self.neighboring_runs = next_runs[::-1] + [self.run] + prev_runs

        # Select the comparison run as either the previous run, or a user
        # specified comparison run.
        compare_to_str = request.args.get('compare_to')
        if compare_to_str:
            compare_to_id = int(compare_to_str)
            compare_to = session.query(ts.Run) \
                .filter_by(id=compare_to_id) \
                .first()
            if compare_to is None:
                flash("Comparison Run is invalid: " + compare_to_str,
                      FLASH_DANGER)
            else:
                self.comparison_neighboring_runs = (
                    list(ts.get_next_runs_on_machine(session, compare_to,
                                                     N=3))[::-1] +
                    [compare_to] +
                    list(ts.get_previous_runs_on_machine(session, compare_to,
                                                         N=3)))
        else:
            if prev_runs:
                compare_to = prev_runs[0]
            else:
                compare_to = None
            self.comparison_neighboring_runs = self.neighboring_runs

        try:
            self.num_comparison_runs = int(
                request.args.get('num_comparison_runs'))
        except Exception:
            self.num_comparison_runs = 0

        # Find the baseline run, if requested.
        baseline_str = request.args.get('baseline')
        if baseline_str:
            baseline_id = int(baseline_str)
            baseline = session.query(ts.Run).filter_by(id=baseline_id).first()
            if baseline is None:
                flash("Could not find baseline " + baseline_str, FLASH_DANGER)
        else:
            baseline = None

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
            session, self.run, baseurl=db_url_for('.index', _external=False),
            result=None, compare_to=compare_to, baseline=baseline,
            num_comparison_runs=self.num_comparison_runs,
            aggregation_fn=aggregation_fn, confidence_lv=confidence_lv,
            styles=styles, classes=classes)
        self.sri = self.data['sri']
        note = self.data['visible_note']
        if note:
            flash(note, FLASH_INFO)
        self.data.update(ts_data(ts))


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
@db_route("/simple/<tag>/<int:id>/")
def simple_run(tag, id):
    # Get the expected test suite.
    db = request.get_db()
    session = request.session
    ts = db.testsuite[tag]

    # Look for a matched run.
    matched_run = session.query(ts.Run).\
        filter(ts.Run.simple_run_id == id).\
        first()

    # If we found one, redirect to it's report.
    if matched_run is not None:
        return v4_redirect(db_url_for(".v4_run", testsuite_name=tag,
                                      id=matched_run.id))

    # Otherwise, report an error.
    return render_template("error.html", message="""\
Unable to find a run for this ID. Please use the native v4 URL interface
(instead of the /simple/... URL schema).""")


@v4_route("/<int:id>")
def v4_run(id):
    info = V4RequestInfo(id)

    session = info.session
    ts = info.ts
    run = info.run

    # Parse the view options.
    options = {}
    options['show_delta'] = bool(request.args.get('show_delta'))
    options['show_previous'] = bool(request.args.get('show_previous'))
    options['show_stddev'] = bool(request.args.get('show_stddev'))
    options['show_mad'] = bool(request.args.get('show_mad'))
    options['show_all'] = bool(request.args.get('show_all'))
    options['show_all_samples'] = bool(request.args.get('show_all_samples'))
    options['show_sample_counts'] = \
        bool(request.args.get('show_sample_counts'))
    options['show_graphs'] = bool(request.args.get('show_graphs'))
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

    options['aggregation_function'] = request.args.get('aggregation_function', 'min')

    # Get the test names.
    test_info = session.query(ts.Test.name, ts.Test.id).\
        order_by(ts.Test.name).all()

    # Filter the list of tests by name, if requested.
    if test_filter_re:
        test_info = [test
                     for test in test_info
                     if test_filter_re.search(test[0])]

    if request.args.get('json'):
        json_obj = dict()

        sri = lnt.server.reporting.analysis.RunInfo(session, ts, [id])
        reported_tests = session.query(ts.Test.name, ts.Test.id).\
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
        'search': v4_url_for('.v4_search')
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


class PromoteOrderToBaseline(flask_wtf.FlaskForm):
    name = StringField('Name', validators=[DataRequired(), Length(max=32)])
    description = StringField('Description', validators=[Length(max=256)])
    promote = SubmitField('Promote')
    update = SubmitField('Update')
    demote = SubmitField('Demote')


@v4_route("/order/<int:id>", methods=['GET', 'POST'])
def v4_order(id):
    """Order page details order information, as well as runs that are in this
    order as well setting this run as a baseline."""
    session = request.session
    ts = request.get_testsuite()
    form = PromoteOrderToBaseline()

    if form.validate_on_submit():
        try:
            baseline = session.query(ts.Baseline) \
                .filter(ts.Baseline.order_id == id) \
                .one()
        except NoResultFound:
            baseline = ts.Baseline()

        if form.demote.data:
            session.delete(baseline)
            session.commit()

            flash("Baseline demoted.", FLASH_SUCCESS)
        else:
            baseline.name = form.name.data
            baseline.comment = form.description.data
            baseline.order_id = id
            session.add(baseline)
            session.commit()

            flash("Baseline {} updated.".format(baseline.name), FLASH_SUCCESS)
        return v4_redirect(v4_url_for(".v4_order", id=id))

    try:
        baseline = session.query(ts.Baseline) \
            .filter(ts.Baseline.order_id == id) \
            .one()
        form.name.data = baseline.name
        form.description.data = baseline.comment
    except NoResultFound:
        pass

    # Get the order.
    order = session.query(ts.Order).filter(ts.Order.id == id).first()
    if order is None:
        abort(404, "Invalid order id {}".format(id))

    previous_order = None
    if order.previous_order_id:
        previous_order = session.query(ts.Order) \
            .filter(ts.Order.id == order.previous_order_id).one()
    next_order = None
    if order.next_order_id:
        next_order = session.query(ts.Order) \
            .filter(ts.Order.id == order.next_order_id).one()

    runs = session.query(ts.Run) \
        .filter(ts.Run.order_id == id) \
        .options(joinedload(ts.Run.machine)) \
        .all()
    num_runs = len(runs)

    return render_template("v4_order.html", order=order, form=form,
                           previous_order=previous_order,
                           next_order=next_order, runs=runs, num_runs=num_runs,
                           **ts_data(ts))


@v4_route("/set_baseline/<int:id>")
def v4_set_baseline(id):
    """Update the baseline stored in the user's session."""
    session = request.session
    ts = request.get_testsuite()
    base = session.query(ts.Baseline).get(id)
    if not base:
        return abort(404, "Invalid baseline id {}".format(id))
    flash("Baseline set to " + base.name, FLASH_SUCCESS)
    flask.session[baseline_key(ts.name)] = id

    return v4_redirect(get_redirect_target())


@v4_route("/all_orders")
def v4_all_orders():
    # Get the testsuite.
    session = request.session
    ts = request.get_testsuite()

    # Get the orders and sort them totally.
    orders = sorted(session.query(ts.Order).all())

    return render_template("v4_all_orders.html", orders=orders, **ts_data(ts))


@v4_route("/<int:id>/graph")
def v4_run_graph(id):
    # This is an old style endpoint that treated graphs as associated with
    # runs. Redirect to the new endpoint.

    session = request.session
    ts = request.get_testsuite()
    run = session.query(ts.Run).filter_by(id=id).first()
    if run is None:
        abort(404, "Invalid run id {}".format(id))

    # Convert the old style test parameters encoding.
    args = {'highlight_run': id}
    plot_number = 0
    for name, value in request.args.items():
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

    return v4_redirect(v4_url_for(".v4_graph", **args))


BaselineLegendItem = namedtuple('BaselineLegendItem', 'name id')
LegendItem = namedtuple('LegendItem', 'machine test_name field_name color url')


@v4_route("/graph_for_sample/<int:sample_id>/<string:field_name>")
def v4_graph_for_sample(sample_id, field_name):
    """Redirect to a graph of the data that a sample and field came from.

    When you have a sample from an API call, this can get you into the LNT
    graph page, for that sample.  Extra args are passed through, to allow the
    caller to customize the graph page displayed, with for example run
    highlighting.

    :param sample_id: the sample ID from the database, obtained from the API.
    :param field_name: the name of the field.
    :return: a redirect to the graph page for that sample and field.

    """
    session = request.session
    ts = request.get_testsuite()
    target_sample = session.query(ts.Sample).get(sample_id)
    if not target_sample:
        abort(404, "Could not find sample id {}".format(sample_id))

    # Get the field index we are interested in.
    field_index = None
    for idx, f in enumerate(ts.sample_fields):
        if f.name == field_name:
            field_index = idx
            break
    if field_index is None:
        abort(400, "Could not find field {}".format(field_name))

    kwargs = {'plot.0': '{machine_id}.{test_id}.{field_index}'.format(
        machine_id=target_sample.run.machine.id,
        test_id=target_sample.test_id,
        field_index=field_index)}
    # Pass request args through, so you can add graph options.
    kwargs.update(request.args)

    graph_url = v4_url_for('.v4_graph', **kwargs)
    return v4_redirect(graph_url)


class PlotParameter(object):
    def __init__(self, machine, test, field, field_index):
        self.machine = machine
        self.test = test
        self.field = field
        self.field_index = field_index
        self.samples = None

    def __repr__(self):
        return "{}:{}({} samples)" \
            .format(self.machine.name,
                    self.test.name,
                    len(self.samples) if self.samples else "No")


def assert_field_idx_valid(field_idx, count):
    if not (0 <= field_idx < count):
        return abort(404, "Invalid field index {}. Total sample_fields for "
                          "the current suite is {}.".format(field_idx, count))


def load_plot_parameter(machine_id, test_id, field_index, session, ts):
    try:
        machine_id = int(machine_id)
        test_id = int(test_id)
        field_index = int(field_index)
    except ValueError:
        return abort(400, "Invalid plot arguments.")

    try:
        machine = session.query(ts.Machine) \
            .filter(ts.Machine.id == machine_id) \
            .one()
    except NoResultFound:
        return abort(404, "Invalid machine id {}".format(machine_id))
    try:
        test = session.query(ts.Test).filter(ts.Test.id == test_id).one()
    except NoResultFound:
        return abort(404, "Invalid test id {}".format(test_id))

    assert_field_idx_valid(field_index, len(ts.sample_fields))
    try:
        field = ts.sample_fields[field_index]
    except NoResultFound:
        return abort(404, "Invalid field_index {}".format(field_index))

    return PlotParameter(machine, test, field, field_index)


def parse_plot_parameters(args):
    """
    Returns a list of tuples of integers (machine_id, test_id, field_index).
    :param args: The request parameters dictionary.
    """
    plot_parameters = []
    for name, value in args.items():
        # Plots are passed as::
        #
        #  plot.<unused>=<machine id>.<test id>.<field index>
        if not name.startswith('plot.'):
            continue

        # Ignore the extra part of the key, it is unused.

        try:
            machine_id, test_id, field_index = map(int, value.split('.'))
        except ValueError:
            return abort(400, "Parameter {} was malformed. {} must be int.int.int"
                              .format(name, value))

        plot_parameters.append((machine_id, test_id, field_index))

    return plot_parameters


def parse_and_load_plot_parameters(args, session, ts):
    """
    Parses plot parameters and loads the corresponding entities from the database.
    Returns a list of PlotParameter instances sorted by machine name, test name and then field.
    :param args: The request parameters dictionary.
    :param session: The database session.
    :param ts: The test suite.
    """
    plot_parameters = [load_plot_parameter(machine_id, test_id, field_index, session, ts)
                       for (machine_id, test_id, field_index) in parse_plot_parameters(args)]
    # Order the plots by machine name, test name and then field.
    plot_parameters.sort(key=lambda plot_parameter:
                         (plot_parameter.machine.name, plot_parameter.test.name,
                          plot_parameter.field.name, plot_parameter.field_index))

    return plot_parameters


def parse_mean_parameter(args, session, ts):
    # Mean to graph is passed as:
    #
    #  mean=<machine id>.<field index>
    value = args.get('mean')
    if not value:
        return None

    try:
        machine_id, field_index = map(int, value.split('.'))
    except ValueError:
        return abort(400,
                     "Invalid format of 'mean={}', expected mean=<machine id>.<field index>".format(value))

    try:
        machine = session.query(ts.Machine) \
            .filter(ts.Machine.id == machine_id) \
            .one()
    except NoResultFound:
        return abort(404, "Invalid machine id {}".format(machine_id))

    assert_field_idx_valid(field_index, len(ts.sample_fields))
    field = ts.sample_fields[field_index]

    return machine, field


def load_graph_data(plot_parameter, show_failures, limit, xaxis_date, revision_cache=None):
    """
    Load all the field values for this test on the same machine.
    :param plot_parameter: Stores machine, test and field to load.
    :param show_failures: Filter only passed values if False.
    :param limit: Limit points if specified.
    :param xaxis_date: X axis is Date, otherwise Order.
    """
    session = request.session
    ts = request.get_testsuite()

    # Load all the field values for this test on the same machine.
    #
    # FIXME: Don't join to Order here, aggregate this across all the tests
    # we want to load. Actually, we should just make this a single query.
    values = session.query(plot_parameter.field.column, ts.Order,
                           ts.Run.start_time, ts.Run.id) \
                    .select_from(ts.Sample) \
                    .join(ts.Run).join(ts.Order) \
                    .filter(ts.Run.machine_id == plot_parameter.machine.id) \
                    .filter(ts.Sample.test == plot_parameter.test) \
                    .filter(plot_parameter.field.column.isnot(None))
    # Unless all samples requested, filter out failing tests.
    if not show_failures:
        if plot_parameter.field.status_field:
            values = values.filter((plot_parameter.field.status_field.column == PASS) |
                                   (plot_parameter.field.status_field.column.is_(None)))
    if limit:
        values = values.limit(limit)

    if xaxis_date:
        # Aggregate by date.
        data = list(multidict.multidict(
            (date, (val, order, date, run_id))
            for val, order, date, run_id in values).items())
        # Sort data points according to date.
        data.sort(key=lambda sample: sample[0])
    else:
        # Aggregate by order (revision).
        data = list(multidict.multidict(
            (order.llvm_project_revision, (val, order, date, run_id))
            for val, order, date, run_id in values).items())
        # Sort data points according to order (revision).
        data.sort(key=lambda sample: convert_revision(sample[0], cache=revision_cache))

    return data


def load_geomean_data(field, machine, limit, xaxis_date, revision_cache=None):
    """
    Load geomean for specified field on the same machine.
    :param field: Field.
    :param machine: Machine.
    :param limit: Limit points if specified.
    :param xaxis_date: X axis is Date, otherwise Order.
    """
    session = request.session
    ts = request.get_testsuite()
    values = session.query(sqlalchemy.sql.func.min(field.column),
                           ts.Order,
                           sqlalchemy.sql.func.min(ts.Run.start_time)) \
                    .select_from(ts.Sample) \
                    .join(ts.Run).join(ts.Order).join(ts.Test) \
                    .filter(ts.Run.machine_id == machine.id) \
                    .filter(field.column.isnot(None)) \
                    .group_by(ts.Order.llvm_project_revision, ts.Test)

    if limit:
        values = values.limit(limit)

    data = multidict.multidict(
        ((order, date), val)
        for val, order, date in values).items()

    # Calculate geomean of each revision.
    if xaxis_date:
        data = [(date, [(calc_geomean(vals), order, date)])
                for ((order, date), vals) in data]
        # Sort data points according to date.
        data.sort(key=lambda sample: sample[0])
    else:
        data = [(order.llvm_project_revision, [(calc_geomean(vals), order, date)])
                for ((order, date), vals) in data]
        # Sort data points according to order (revision).
        data.sort(key=lambda sample: convert_revision(sample[0], cache=revision_cache))

    return data


@v4_route("/tableau")
def v4_tableau():
    """Tableau WDC."""
    return render_template("v4_tableau.html")


@v4_route("/graph")
def v4_graph():
    session = request.session
    ts = request.get_testsuite()

    # Parse the view options.
    options = {}
    options['aggregation_function'] = \
        request.args.get('aggregation_function')  # default determined later based on the field being graphed
    options['hide_lineplot'] = bool(request.args.get('hide_lineplot'))
    show_lineplot = not options['hide_lineplot']
    options['show_mad'] = show_mad = bool(request.args.get('show_mad'))
    options['show_stddev'] = show_stddev = \
        bool(request.args.get('show_stddev'))
    options['hide_all_points'] = hide_all_points = bool(
        request.args.get('hide_all_points'))
    options['xaxis_date'] = xaxis_date = bool(
        request.args.get('xaxis_date'))
    options['limit'] = limit = int(
        request.args.get('limit', 0))
    options['show_cumulative_minimum'] = show_cumulative_minimum = bool(
        request.args.get('show_cumulative_minimum'))
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
    options['logarithmic_scale'] = bool(
        request.args.get('logarithmic_scale'))

    show_highlight = not options['hide_highlight']

    # Load the graph parameters.
    plot_parameters = parse_and_load_plot_parameters(request.args, session, ts)

    # Extract requested mean trend.
    mean_parameter = parse_mean_parameter(request.args, session, ts)

    # Sanity check the arguments.
    if not plot_parameters and not mean_parameter:
        return render_template("error.html", message="Nothing to graph.")

    # Extract requested baselines, and their titles.
    baseline_parameters = []
    for name, value in request.args.items():
        # Baselines to graph are passed as:
        #
        #  baseline.title=<run id>
        if not name.startswith('baseline.'):
            continue

        baseline_title = name[len('baseline.'):]

        run_id_str = value
        try:
            run_id = int(run_id_str)
        except Exception:
            return abort(400, "Invalid baseline run id {}".format(run_id_str))

        try:
            run = session.query(ts.Run) \
                .options(joinedload(ts.Run.machine)) \
                .filter(ts.Run.id == run_id) \
                .one()
        except Exception:
            err_msg = ("The run {} was not found in the database."
                       .format(run_id))
            return render_template("error.html",
                                   message=err_msg)

        baseline_parameters.append((run, baseline_title))

    # Create region of interest for run data region if we are performing a
    # comparison.
    revision_range = None
    highlight_run_id = request.args.get('highlight_run')
    if show_highlight and highlight_run_id and highlight_run_id.isdigit():
        highlight_run = session.query(ts.Run).filter_by(
            id=int(highlight_run_id)).first()
        if highlight_run is None:
            abort(404, "Invalid highlight_run id {}".format(highlight_run_id))

        # Find the neighboring runs, by order.
        prev_runs = list(ts.get_previous_runs_on_machine(session,
                                                         highlight_run, N=1))
        if prev_runs:
            start_rev = prev_runs[0].order.llvm_project_revision
            end_rev = highlight_run.order.llvm_project_revision
            revision_range = {
                "start": start_rev,
                "end": end_rev,
            }

    # Build the graph data.
    legend = []
    graph_plots = []
    graph_datum = []
    baseline_plots = []
    revision_cache = {}
    num_plots = len(plot_parameters)

    metrics = list(set(req.field.name for req in plot_parameters))

    for i, req in enumerate(plot_parameters):
        # Determine the base plot color.
        col = list(util.makeDarkColor(float(i) / num_plots))
        url = "/".join([str(req.machine.id), str(req.test.id), str(req.field_index)])
        legend.append(LegendItem(req.machine, req.test.name, req.field.name,
                                 tuple(col), url))

        # Load all the field values for this test on the same machine.
        data = load_graph_data(req, show_failures, limit, xaxis_date, revision_cache)

        graph_datum.append((req.test.name, data, col, req.field, url, req.machine))

        # Get baselines for this line
        num_baselines = len(baseline_parameters)
        for baseline_id, (baseline, baseline_title) in \
                enumerate(baseline_parameters):
            q_baseline = session.query(req.field.column,
                                       ts.Order.llvm_project_revision,
                                       ts.Run.start_time, ts.Machine.name) \
                         .select_from(ts.Sample) \
                         .join(ts.Run).join(ts.Order).join(ts.Machine) \
                         .filter(ts.Run.id == baseline.id) \
                         .filter(ts.Sample.test == req.test) \
                         .filter(req.field.column.isnot(None))
            # In the event of many samples, use the mean of the samples as the
            # baseline.
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
            str_dark_col = util.toColorString(dark_col)
            baseline_plots.append({
                "color": str_dark_col,
                "lineWidth": 2,
                "yaxis": {"from": mean, "to": mean},
                # "name": q_baseline[0].llvm_project_revision,
                "name": "Baseline %s: %s (%s)" % (baseline_title, req.test.name, req.field.name),
            })
            baseline_name = ("Baseline {} on {}"
                             .format(baseline_title, q_baseline[0].name))
            legend.append(LegendItem(BaselineLegendItem(
                baseline_name, baseline.id), req.test.name, req.field.name, dark_col,
                None))

    # Draw mean trend if requested.
    if mean_parameter:
        machine, field = mean_parameter
        test_name = 'Geometric Mean'

        if field.name not in metrics:
            metrics.append(field.name)

        col = (0, 0, 0)
        legend.append(LegendItem(machine, test_name, field.name, col, None))
        data = load_geomean_data(field, machine, limit, xaxis_date, revision_cache)
        graph_datum.append((test_name, data, col, field, None, machine))

    def trace_name(name, test_name, field_name):
        return "%s: %s (%s)" % (name, test_name, field_name)

    for test_name, data, col, field, url, machine in graph_datum:
        # Generate trace metadata.
        trace_meta = {}
        trace_meta["machine"] = machine.name
        trace_meta["machineID"] = machine.id
        if len(graph_datum) > 1:
            # If there are more than one plot in the graph, also label the
            # test name.
            trace_meta["test_name"] = test_name
            trace_meta["metric"] = field.name

        # Compute the graph points.
        pts_x = []
        pts_y = []
        meta = []
        errorbar = {"x": [], "y": [], "error_y": {"type": "data", "visible": True, "array": []}}
        cumulative_minimum = {"x": [], "y": []}
        moving_median_data = {"x": [], "y": []}
        moving_average_data = {"x": [], "y": []}
        multisample_points_data = {"x": [], "y": [], "meta": []}

        if normalize_by_median:
            normalize_by = 1.0/stats.median([min([d[0] for d in values])
                                            for _, values in data])
        else:
            normalize_by = 1.0

        min_val = None
        # Note data is sorted in load_graph_data().
        for point_label, datapoints in data:
            # Get the samples.
            values = [data_array[0] for data_array in datapoints]
            orders = [data_array[1] for data_array in datapoints]
            # And the date on which they were taken.
            dates = [data_array[2] for data_array in datapoints]
            # Run ID where this point was collected.
            run_ids = [data_array[3] for data_array in datapoints if len(data_array) == 4]

            values = [v * normalize_by for v in values]

            is_multisample = (len(values) > 1)

            fn_name = options.get('aggregation_function') or ('max' if field.bigger_is_better else 'min')
            aggregation_fn = determine_aggregation_function(fn_name)
            if aggregation_fn is None:
                abort(404, "Invalid aggregation function name {}".format(fn_name))
            agg_value = aggregation_fn(values)

            # When aggregating multiple samples, it becomes unclear which sample to use for
            # associated data like the run date, the order, etc. Use the index of the closest
            # value in all the samples.
            closest_value = sorted(values, key=lambda val: abs(val - agg_value))[0]
            agg_index = values.index(closest_value)

            pts_y.append(agg_value)

            # Plotly does not sort X axis in case of type: 'category'.
            # point_label is a string (order revision) if xaxis_date = False
            pts_x.append(point_label)

            # Generate point metadata.
            point_metadata = {"order": orders[agg_index].as_ordered_string(),
                              "orderID": orders[agg_index].id,
                              "date": str(dates[agg_index])}
            if run_ids:
                point_metadata["runID"] = str(run_ids[agg_index])
            meta.append(point_metadata)

            # Add the multisample points, if requested.
            if not hide_all_points and (is_multisample or
               bool(request.args.get('csv')) or bool(request.args.get('download_csv'))):
                for i, v in enumerate(values):
                    multisample_metadata = {"order": orders[i].as_ordered_string(),
                                            "orderID": orders[i].id,
                                            "date": str(dates[i])}
                    if run_ids:
                        multisample_metadata["runID"] = str(run_ids[i])
                    multisample_points_data["x"].append(point_label)
                    multisample_points_data["y"].append(v)
                    multisample_points_data["meta"].append(multisample_metadata)

            # Add the standard deviation error bar, if requested.
            if show_stddev:
                mean = stats.mean(values)
                sigma = stats.standard_deviation(values)
                errorbar["x"].append(point_label)
                errorbar["y"].append(mean)
                errorbar["error_y"]["array"].append(sigma)

            # Add the MAD error bar, if requested.
            if show_mad:
                med = stats.median(values)
                mad = stats.median_absolute_deviation(values, med)
                errorbar["x"].append(point_label)
                errorbar["y"].append(med)
                errorbar["error_y"]["array"].append(mad)

            if show_cumulative_minimum:
                min_val = agg_value if min_val is None else min(min_val, agg_value)
                cumulative_minimum["x"].append(point_label)
                cumulative_minimum["y"].append(min_val)

        # Compute the moving average and or moving median of our data if
        # requested.
        if moving_average or moving_median:

            def compute_moving_average(x, window, average_list, _):
                average_list["x"].append(x)
                average_list["y"].append(lnt.util.stats.mean(window))

            def compute_moving_median(x, window, _, median_list):
                median_list["x"].append(x)
                median_list["y"].append(lnt.util.stats.median(window))

            def compute_moving_average_and_median(x, window, average_list,
                                                  median_list):
                average_list["x"].append(x)
                average_list["y"].append(lnt.util.stats.mean(window))
                median_list["x"].append(x)
                median_list["y"].append(lnt.util.stats.median(window))

            if moving_average and moving_median:
                fun = compute_moving_average_and_median
            elif moving_average:
                fun = compute_moving_average
            else:
                fun = compute_moving_median

            len_pts = len(pts_x)
            for i in range(len_pts):
                start_index = max(0, i - moving_window_size)
                end_index = min(len_pts, i + moving_window_size)

                window_pts = pts_y[start_index:end_index]
                fun(pts_x[i], window_pts, moving_average_data,
                    moving_median_data)

        yaxis_index = metrics.index(field.name)
        yaxis = "y" if yaxis_index == 0 else "y%d" % (yaxis_index + 1)

        # Add the minimum line plot, if requested.
        if show_lineplot:
            plot = {
                "name": trace_name("Line", test_name, field.name),
                "legendgroup": test_name,
                "yaxis": yaxis,
                "type": "scatter",
                "mode": "lines+markers",
                "line": {"color": util.toColorString(col)},
                "x": pts_x,
                "y": pts_y,
                "meta": meta
            }
            plot.update(trace_meta)
            if url:
                plot["url"] = url
            graph_plots.append(plot)

        # Add regression line, if requested.
        if show_linear_regression and len(pts_x) >= 2:
            unique_x = list(set(pts_x))
            if xaxis_date:
                unique_x.sort()
            else:
                unique_x.sort(key=lambda sample: convert_revision(sample, cache=revision_cache))
            num_unique_x = len(unique_x)
            if num_unique_x >= 2:
                dict_x = {}
                x_min = pts_x[0]
                x_max = pts_x[-1]

                # We compute the regression line in terms of a normalized X scale.
                if xaxis_date:
                    x_range = float((x_max - x_min).total_seconds())
                    for x_key in unique_x:
                        dict_x[x_key] = (x_key - x_min).total_seconds() / x_range
                else:
                    for i, x_key in enumerate(unique_x):
                        dict_x[x_key] = i/(num_unique_x - 1)

                norm_x = [dict_x[xi] for xi in pts_x]

                try:
                    info = ext_stats.linregress(norm_x, pts_y)
                except ZeroDivisionError:
                    info = None
                except ValueError:
                    info = None

                if info is not None:
                    slope, intercept, _, _, _ = info

                    reglin_col = [c * 0.8 for c in col]
                    if xaxis_date:
                        reglin_y = [(xi - x_min).total_seconds() / x_range * slope +
                                    intercept for xi in unique_x]
                    else:
                        reglin_y = [i/(num_unique_x - 1) * slope +
                                    intercept for i in range(num_unique_x)]
                    plot = {
                        "name": trace_name("Linear Regression", test_name, field.name),
                        "legendgroup": test_name,
                        "yaxis": yaxis,
                        "hoverinfo": "skip",
                        "type": "scatter",
                        "mode": "lines",
                        "line": {"color": util.toColorString(reglin_col), "width": 2},
                        # "shadowSize": 4,
                        "x": unique_x,
                        "y": reglin_y
                    }
                    plot.update(trace_meta)
                    graph_plots.insert(0, plot)

        # Add the points plot, if used.
        if multisample_points_data["x"]:
            pts_col = (0, 0, 0)
            multisample_points_data.update({
                "name": trace_name("Points", test_name, field.name),
                "legendgroup": test_name,
                "showlegend": False,
                "yaxis": yaxis,
                # "hoverinfo": "skip",
                "type": "scatter",
                "mode": "markers",
                "marker": {"color": util.toColorString(pts_col), "size": 5}
            })
            multisample_points_data.update(trace_meta)
            if url:
                multisample_points_data["url"] = url
            graph_plots.append(multisample_points_data)

        # Add the error bar plot, if used.
        if errorbar["x"]:
            bar_col = [c * 0.4 for c in col]
            errorbar.update({
                "name": trace_name("Error bars", test_name, field.name),
                "showlegend": False,
                "yaxis": yaxis,
                "hoverinfo": "skip",
                "type": "scatter",
                "mode": "markers",
                "marker": {"color": util.toColorString(bar_col)}
            })
            errorbar.update(trace_meta)
            graph_plots.append(errorbar)

        # Add the moving average plot, if used.
        if moving_average_data["x"]:
            avg_col = [c * 0.7 for c in col]
            moving_average_data.update({
                "name": trace_name("Moving average", test_name, field.name),
                "legendgroup": test_name,
                "yaxis": yaxis,
                "hoverinfo": "skip",
                "type": "scatter",
                "mode": "lines",
                "line": {"color": util.toColorString(avg_col)}
            })
            moving_average_data.update(trace_meta)
            graph_plots.append(moving_average_data)

        # Add the moving median plot, if used.
        if moving_median_data["x"]:
            med_col = [c * 0.6 for c in col]
            moving_median_data.update({
                "name": trace_name("Moving median", test_name, field.name),
                "legendgroup": test_name,
                "yaxis": yaxis,
                "hoverinfo": "skip",
                "type": "scatter",
                "mode": "lines",
                "line": {"color": util.toColorString(med_col)}
            })
            moving_median_data.update(trace_meta)
            graph_plots.append(moving_median_data)

        if cumulative_minimum["x"]:
            min_col = [c * 0.5 for c in col]
            cumulative_minimum.update({
                "name": trace_name("Cumulative Minimum", test_name, field.name),
                "legendgroup": test_name,
                "yaxis": yaxis,
                "hoverinfo": "skip",
                "type": "scatter",
                "mode": "lines",
                "line": {"color": util.toColorString(min_col)}
            })
            cumulative_minimum.update(trace_meta)
            graph_plots.append(cumulative_minimum)

    if bool(request.args.get("json")) or bool(request.args.get("download_json")):
        json_obj = dict()
        json_obj['data'] = graph_plots
        # Flatten ORM machine objects to their string names.
        simple_type_legend = []
        for li in legend:
            # Flatten name, make color a dict.
            new_entry = {
                'name': li.machine.name,
                'test': li.test_name,
                'unit': li.field_name,
                'color': util.toColorString(li.color),
                'url': li.url,
            }
            simple_type_legend.append(new_entry)
        json_obj['legend'] = simple_type_legend
        json_obj['revision_range'] = revision_range
        json_obj['current_options'] = options
        json_obj['test_suite_name'] = ts.name
        json_obj['baselines'] = baseline_plots
        flask_json = flask.jsonify(**json_obj)

        if bool(request.args.get('json')):
            return flask_json
        else:
            json_file = BytesIO()
            lines = flask_json.get_data()
            json_file.write(lines)
            json_file.seek(0)
            return send_file(json_file,
                             mimetype='text/json',
                             attachment_filename='Graph.json',
                             as_attachment=True)

    return render_template("v4_graph.html", options=options,
                           graph_plots=graph_plots,
                           metrics=metrics,
                           legend=legend,
                           **ts_data(ts))


@v4_route("/global_status")
def v4_global_status():
    session = request.session
    ts = request.get_testsuite()
    metric_fields = sorted(list(ts.Sample.get_metric_fields()),
                           key=lambda f: f.name)
    fields = dict((f.name, f) for f in metric_fields)

    # Get the latest run.
    latest = session.query(ts.Run.start_time).\
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
    revision = request.args.get('revision',
                                str(ts.Machine.DEFAULT_BASELINE_REVISION))
    field = fields.get(request.args.get('field', None), metric_fields[0])

    # Get the list of all runs we might be interested in.
    recent_runs = session.query(ts.Run) \
        .filter(ts.Run.start_time > yesterday) \
        .all()

    # Aggregate the runs by machine.
    recent_runs_by_machine = multidict.multidict()
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
        m.css_name = m.name.replace('.', '-')
        return m
    recent_machines = list(map(get_machine_keys, recent_machines))

    # For each machine, build a table of the machine, the baseline run, and the
    # most recent run. We also computed a list of all the runs we are reporting
    # over.
    machine_run_info = []
    reported_run_ids = []

    for machine in recent_machines:
        runs = recent_runs_by_machine[machine]

        # Get the baseline run for this machine.
        baseline = machine.get_closest_previously_reported_run(
            session, ts.Order(llvm_project_revision=revision))

        # Choose the "best" run to report on. We want the most recent one with
        # the most recent order.
        run = max(runs, key=lambda r: (r.order, r.start_time))
        if baseline:
            machine_run_info.append((baseline, run))
            reported_run_ids.append(baseline.id)
        reported_run_ids.append(run.id)

    if not machine_run_info:
        abort(404, "No closest runs for revision '{}'".format(revision))

    # Get the set all tests reported in the recent runs.
    reported_tests = session.query(ts.Test.id, ts.Test.name).filter(
        sqlalchemy.sql.exists('*', sqlalchemy.sql.and_(
            ts.Sample.run_id.in_(reported_run_ids),
            ts.Sample.test_id == ts.Test.id))).all()

    # Load all of the runs we are interested in.
    runinfo = lnt.server.reporting.analysis.RunInfo(session, ts,
                                                    reported_run_ids)

    # Build the test matrix. This is a two dimensional table index by
    # (machine-index, test-index), where each entry is the percent change.
    test_table = []
    for i, (test_id, test_name) in enumerate(reported_tests):
        # Create the row, starting with the test name and worst entry.
        row = [(test_id, test_name), None]

        # Compute comparison results for each machine.
        row.extend((runinfo.get_run_comparison_result(
                        run, baseline, test_id, field,
                        ts.Sample.get_hash_of_binary_field()),
                    run.id)
                   for baseline, run in machine_run_info)

        # Compute the worst cell value.
        if len(row) > 2:
            row[1] = max(cr.pct_delta
                         for cr, _ in row[2:])

        test_table.append(row)

    # Order the table by worst regression.
    test_table.sort(key=lambda row: row[1], reverse=True)

    return render_template("v4_global_status.html",
                           tests=test_table,
                           machines=recent_machines,
                           fields=metric_fields,
                           selected_field=field,
                           selected_revision=revision,
                           **ts_data(ts))


@v4_route("/daily_report")
def v4_daily_report_overview():
    # Redirect to the report for the most recent submitted run's date.

    session = request.session
    ts = request.get_testsuite()

    # Get the latest run.
    latest = session.query(ts.Run).\
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

    return v4_redirect(v4_url_for(".v4_daily_report",
                                  year=date.year, month=date.month,
                                  day=date.day, **extra_args))


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
        report.build(request.session)
    except ValueError:
        return abort(400)

    return render_template("v4_daily_report.html", report=report,
                           analysis=lnt.server.reporting.analysis,
                           **ts_data(ts))

###
# Cross Test-Suite V4 Views


def get_summary_config_path():
    return os.path.join(current_app.old_config.tempDir,
                        'summary_report_config.json')


@db_route("/summary_report/edit", methods=('GET', 'POST'))
def v4_summary_report_ui():
    # If this is a POST request, update the saved config.
    session = request.session
    if request.method == 'POST':
        # Parse the config data.
        config_data = request.form.get('config')
        config = flask.json.loads(config_data)

        # Write the updated config.
        with open(get_summary_config_path(), 'w') as f:
            flask.json.dump(config, f, indent=2)

        # Redirect to the summary report.
        return v4_redirect(db_url_for(".v4_summary_report"))

    config_path = get_summary_config_path()
    if os.path.exists(config_path):
        with open(config_path) as f:
            config = flask.json.load(f)
    else:
        config = {
            "machine_names": [],
            "orders": [],
            "machine_patterns": [],
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
        for name, in session.query(ts.Machine.name):
            all_machines.add(name)
        for name, in session.query(ts.Order.llvm_project_revision):
            all_orders.add(name)
    all_machines = sorted(all_machines)
    all_orders = sorted(all_orders, key=to_key)

    return render_template("v4_summary_report_ui.html",
                           config=config, all_machines=all_machines,
                           all_orders=all_orders, **ts_data(ts))


@v4_route("/latest_runs_report")
def v4_latest_runs_report():
    ts = request.get_testsuite()

    num_runs_str = request.args.get('num_runs')
    if num_runs_str is not None:
        num_runs = int(num_runs_str)
    else:
        num_runs = 10

    report = lnt.server.reporting.latestrunsreport.LatestRunsReport(ts, num_runs)
    report.build(request.session)

    return render_template("v4_latest_runs_report.html", report=report,
                           analysis=lnt.server.reporting.analysis,
                           **ts_data(ts))


@db_route("/summary_report")
def v4_summary_report():
    session = request.session
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
    report.build(session)

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
    return render_template("rules.html", rules=discovered_rules)


@frontend.route('/log')
def log():
    with open(current_app.config['log_file_name'], 'r') as f:
        log_lines = f.readlines()
    return render_template("log.html", log_lines=log_lines)


@frontend.route('/debug')
def debug():
    assert not current_app.debug


@frontend.route('/__health')
def health():
    """Our instance health. If queue is too long or we use too much mem,
    return 500.  Monitor might reboot us for this."""
    is_bad_state = False
    msg = "Ok"

    import resource
    stats = resource.getrusage(resource.RUSAGE_SELF)
    mem = stats.ru_maxrss
    if mem > 1024**3:
        is_bad_state = True
        msg = "Over memory " + str(mem) + ">" + str(1024**3)
    if is_bad_state:
        return msg, 500
    return msg, 200


@v4_route("/search")
def v4_search():
    session = request.session
    ts = request.get_testsuite()
    query = request.args.get('q')
    l_arg = request.args.get('l', 8)
    default_machine = request.args.get('m', None)

    assert query
    results = lnt.server.db.search.search(session, ts, query,
                                          num_results=l_arg,
                                          default_machine=default_machine)

    return json.dumps(
        [('%s #%s' % (r.machine.name, r.order.llvm_project_revision),
          r.id)
         for r in results])


# How much data to render in the Matrix view.
MATRIX_LIMITS = [
    ('12', 'Small'),
    ('50', 'Medium'),
    ('250', 'Large'),
    ('-1', 'All'),
]


class MatrixOptions(flask_wtf.FlaskForm):
    limit = SelectField('Size', choices=MATRIX_LIMITS)


def baseline():
    # type: () -> typing.Optional[testsuitedb.TestSuiteDB.Baseline]
    """Get the baseline object from the user's current session baseline value
    or None if one is not defined.
    """
    session = request.session
    ts = request.get_testsuite()
    base_id = flask.session.get(baseline_key(ts.name))
    if not base_id:
        return None
    try:
        base = session.query(ts.Baseline).get(base_id)
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
    session = request.session
    ts = request.get_testsuite()
    # Load the matrix request parameters.
    form = MatrixOptions(request.form)
    if request.method == 'POST':
        post_limit = form.limit.data
    else:
        post_limit = MATRIX_LIMITS[0][0]
    plot_parameters = parse_and_load_plot_parameters(request.args, session, ts)

    if not plot_parameters:
        abort(404, "Request requires some plot arguments.")
    # Feature: if all of the results are from the same machine, hide the name
    # to make the headers more compact.
    dedup = True
    for r in plot_parameters:
        if r.machine.id != plot_parameters[0].machine.id:
            dedup = False
    if dedup:
        machine_name_common = plot_parameters[0].machine.name
        machine_id_common = plot_parameters[0].machine.id
    else:
        machine_name_common = machine_id_common = None

    # It is nice for the columns to be sorted by name.
    plot_parameters.sort(key=lambda x: x.test.name),

    # Now lets get the data.
    all_orders = set()
    order_to_id = {}
    for req in plot_parameters:
        q = session.query(req.field.column, ts.Order.llvm_project_revision,
                          ts.Order.id) \
            .select_from(ts.Sample) \
            .join(ts.Run) \
            .join(ts.Order) \
            .filter(ts.Run.machine_id == req.machine.id) \
            .filter(ts.Sample.test == req.test) \
            .filter(req.field.column.isnot(None)) \
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
    if not all_orders:
        abort(404, "No orders found.")
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

    for req in plot_parameters:
        q_baseline = session.query(req.field.column,
                                   ts.Order.llvm_project_revision,
                                   ts.Order.id) \
                       .select_from(ts.Sample) \
                       .join(ts.Run) \
                       .join(ts.Order) \
                       .filter(ts.Run.machine_id == req.machine.id) \
                       .filter(ts.Sample.test == req.test) \
                       .filter(req.field.column.isnot(None)) \
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

    for req in plot_parameters:
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
        for req in plot_parameters:
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
    runs = session.query(ts.Run.start_time, ts.Order.llvm_project_revision) \
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
                           associated_runs=plot_parameters,
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
                           order_to_date=order_to_date,
                           **ts_data(ts))


@frontend.route("/explode")
def explode():
    """This route is going to exception. Used for testing 500 page."""
    return 1/0


@frontend.route("/gone")
def gone():
    """This route returns 404. Used for testing 404 page."""
    abort(404, "test")


@frontend.route("/ping")
def ping():
    """Simple route to see if server is alive.

    Used by tests to poll on server creation."""
    return "pong", 200


@frontend.route("/sleep")
def sleep():
    """Simple route to simulate long running page loads.

    Used by to diagnose proxy issues etc."""
    sleep_time = 1
    if request.args.get('timeout'):
        sleep_time = int(request.args.get('timeout'))
    time.sleep(sleep_time)
    return "Done", 200

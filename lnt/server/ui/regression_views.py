import sqlalchemy
import json
import flask
from flask import g
from flask import abort
from flask import render_template
from flask import request
from flask import flash
import flask_wtf
from sqlalchemy import desc
from sqlalchemy.orm.exc import NoResultFound
from wtforms import SelectMultipleField, StringField, widgets, SelectField
from wtforms import HiddenField
from wtforms.validators import DataRequired

from lnt.server.ui.decorators import v4_route
import lnt.server.reporting.analysis
from lnt.server.ui.globals import v4_url_for, v4_redirect
from lnt.server.ui.views import ts_data

from lnt.util import logger
from lnt.server.ui.util import FLASH_DANGER, FLASH_SUCCESS, PrecomputedCR
import lnt.server.db.fieldchange
from lnt.server.db.regression import RegressionState, new_regression
from lnt.server.db.regression import get_first_runs_of_fieldchange
from lnt.server.db.regression import get_cr_for_field_change
from lnt.server.db.regression import ChangeData
from lnt.server.db import rules_manager as rule_hooks


class MultiCheckboxField(SelectMultipleField):
    """
    A multiple-select, except displays a list of checkboxes.

    Iterating the field will produce subfields, allowing custom rendering of
    the enclosed checkbox fields.
    """
    widget = widgets.ListWidget(prefix_label=False)
    option_widget = widgets.CheckboxInput()


class TriagePageSelectedForm(flask_wtf.FlaskForm):
    field_changes = MultiCheckboxField("Changes", coerce=int)
    name = StringField('name', validators=[DataRequired()])


def get_fieldchange(session, ts, id):
    return session.query(ts.FieldChange) \
        .filter(ts.FieldChange.id == id) \
        .one()


@v4_route("/regressions/new", methods=["GET", "POST"])
def v4_new_regressions():
    form = TriagePageSelectedForm(request.form)
    session = request.session
    ts = request.get_testsuite()
    if request.method == 'POST' and \
            request.form['btn'] == "Create New Regression":
        regression, _ = new_regression(session, ts, form.field_changes.data)
        flash("Created " + regression.title, FLASH_SUCCESS)
        return v4_redirect(v4_url_for(".v4_regression_list",
                                      highlight=regression.id))
    if request.method == 'POST' and request.form['btn'] == "Ignore Changes":
        msg = "Ignoring changes: "
        ignored = []
        for fc_id in form.field_changes.data:
            ignored.append(str(fc_id))
            fc = get_fieldchange(session, ts, fc_id)
            ignored_change = ts.ChangeIgnore(fc)
            session.add(ignored_change)
        session.commit()
        flash(msg + ", ".join(ignored), FLASH_SUCCESS)

#    d = datetime.datetime.now()
#    two_weeks_ago = d - datetime.timedelta(days=14)
    recent_fieldchange = session.query(ts.FieldChange) \
        .join(ts.Test) \
        .outerjoin(ts.ChangeIgnore) \
        .filter(ts.ChangeIgnore.id.is_(None)) \
        .outerjoin(ts.RegressionIndicator) \
        .filter(ts.RegressionIndicator.id.is_(None)) \
        .order_by(desc(ts.FieldChange.id)) \
        .limit(500) \
        .all()
    crs = []

    form.field_changes.choices = list()
    for fc in recent_fieldchange:
        if fc.old_value is None:
            cr, key_run, _ = get_cr_for_field_change(session, ts, fc)
        else:
            cr = PrecomputedCR(fc.old_value, fc.new_value,
                               fc.field.bigger_is_better)
            key_run = get_first_runs_of_fieldchange(session, ts, fc)
        current_cr, _, _ = get_cr_for_field_change(session, ts, fc,
                                                   current=True)
        crs.append(ChangeData(fc, cr, key_run, current_cr))
        form.field_changes.choices.append((fc.id, 1,))
    return render_template("v4_new_regressions.html",
                           testsuite_name=g.testsuite_name,
                           changes=crs, analysis=lnt.server.reporting.analysis,
                           form=form, **ts_data(ts))


def calc_impact(session, ts, fcs):
    crs = []
    for fc in fcs:
        if fc is None:
            continue
        if fc.old_value is None:
            cr, _, _ = get_cr_for_field_change(session, ts, fc)
        else:
            cr = PrecomputedCR(fc.old_value, fc.new_value,
                               fc.field.bigger_is_better)
        crs.append(cr)
    if crs:
        olds = sum([x.previous for x in crs if x.previous])
        news = sum([x.current for x in crs if x.current])
        if olds and news:
            new_cr = PrecomputedCR(olds, news, crs[0].bigger_is_better)
            # TODO both directions
            return new_cr

    return PrecomputedCR(1, 1, True)


class MergeRegressionForm(flask_wtf.FlaskForm):
    regression_checkboxes = MultiCheckboxField("regression_checkboxes",
                                               coerce=int)


class EmptyDate(object):
    def isoformat(self):
        return "-"

    def strftime(self, _):
        return "0"


@v4_route("/regressions/", methods=["GET", "POST"])
def v4_regression_list():
    session = request.session
    ts = request.get_testsuite()
    form = MergeRegressionForm(request.form)
    machine_filter = request.args.get('machine_filter')
    state_filter = int(request.args.get('state', RegressionState.ACTIVE))
    # Merge requested regressions.
    if request.method == 'POST' and \
       request.form['merge_btn'] == "Merge Regressions":
        reg_inds, regressions = _get_regressions_from_selected_form(session,
                                                                    form, ts)
        links = []
        target = 0
        for i, r in enumerate(regressions):
            if r.bug:
                target = i
                links.append(r.bug)

        new_regress, _ = new_regression(session, ts,
                                        [x.field_change_id for x in reg_inds])
        new_regress.state = regressions[target].state
        new_regress.title = regressions[target].title
        new_regress.bug = ' '.join(links)
        for r in regressions:
            r.bug = v4_url_for(".v4_regression_detail", id=new_regress.id)
            r.title = "Merged into Regression " + str(new_regress.id)
            r.state = RegressionState.IGNORED
        [session.delete(x) for x in reg_inds]

        session.commit()
        flash("Created: " + new_regress.title, FLASH_SUCCESS)
        return v4_redirect(v4_url_for(".v4_regression_detail", id=new_regress.id))
    # Delete requested regressions.
    if request.method == 'POST' and \
            request.form['merge_btn'] == "Delete Regressions":
        reg_inds, regressions = _get_regressions_from_selected_form(session,
                                                                    form, ts)
        titles = [r.title for r in regressions]
        for res_ind in reg_inds:
            session.delete(res_ind)
        for reg in regressions:
            session.delete(reg)
        session.commit()
        flash(' Deleted: '.join(titles), FLASH_SUCCESS)
        return v4_redirect(v4_url_for(".v4_regression_list", state=state_filter))

    q = session.query(ts.Regression)
    title = "All Regressions"
    if state_filter != -1:
        q = q.filter(ts.Regression.state == state_filter)
        title = RegressionState.names[state_filter]
    regression_info = q.all()[::-1]

    form.regression_checkboxes.choices = list()
    regression_sizes = []
    impacts = []
    ages = []

    filtered_regressions = []
    for regression in regression_info:
        reg_inds = session.query(ts.RegressionIndicator) \
            .filter(ts.RegressionIndicator.regression_id ==
                    regression.id) \
            .all()
        if machine_filter:
            machine_names = \
                set([x.field_change.machine.name for x in reg_inds])
            if machine_filter in machine_names:
                filtered_regressions.append(regression)
            else:
                continue
        else:
            filtered_regressions.append(regression)
        form.regression_checkboxes.choices.append((regression.id, 1,))

        regression_sizes.append(len(reg_inds))
        impacts.append(calc_impact(session, ts,
                                   [x.field_change for x in reg_inds]))
        # Now guess the regression age:
        if len(reg_inds) and reg_inds[0].field_change and \
                reg_inds[0].field_change.run:
            age = reg_inds[0].field_change.run.end_time
        else:
            age = EmptyDate()
        ages.append(age)

    return render_template("v4_regression_list.html",
                           testsuite_name=g.testsuite_name,
                           regressions=filtered_regressions,
                           highlight=request.args.get('highlight'),
                           title=title,
                           RegressionState=RegressionState,
                           state_filter=state_filter,
                           form=form,
                           sizes=regression_sizes,
                           impacts=impacts,
                           ages=ages,
                           analysis=lnt.server.reporting.analysis,
                           **ts_data(ts))


def _get_regressions_from_selected_form(session, form, ts):
    regressions_id_to_merge = form.regression_checkboxes.data
    regressions = session.query(ts.Regression) \
        .filter(ts.Regression.id.in_(regressions_id_to_merge)).all()
    reg_inds = session.query(ts.RegressionIndicator) \
        .filter(ts.RegressionIndicator.regression_id.in_(
            regressions_id_to_merge)) \
        .all()
    return reg_inds, regressions


class EditRegressionForm(flask_wtf.FlaskForm):
    title = StringField(u'Title', validators=[DataRequired()])
    bug = StringField(u'Bug', validators=[DataRequired()])
    field_changes = MultiCheckboxField("Changes", coerce=int)
    choices = list(RegressionState.names.items())
    state = SelectField(u'State', choices=choices)
    edit_state = HiddenField(u'EditState', validators=[DataRequired()])


def name(cls):
    """Get a nice name for this object."""
    return cls.__class__.__name__


class LNTEncoder(json.JSONEncoder):
    """Encode all the common LNT objects."""
    def default(self, obj):
        # Most of our objects have a __json__ defined.
        if hasattr(obj, "__json__"):
            return obj.__json__()
        # From sqlalchemy, when we encounter ignore.
        if name(obj) == "InstanceState":
            return
        if name(obj) == "SampleField":
            return obj.name
        return flask.json.provider.DefaultJSONProvider.default(obj)


@v4_route("/regressions/<int:id>", methods=["GET", "POST"])
def v4_regression_detail(id):
    session = request.session
    ts = request.get_testsuite()
    form = EditRegressionForm(request.form)

    try:
        regression_info = session.query(ts.Regression) \
            .filter(ts.Regression.id == id) \
            .one()
    except NoResultFound:
        abort(404)
    if request.method == 'POST' and request.form['save_btn'] == "Save Changes":
        regression_info.title = form.title.data
        regression_info.bug = form.bug.data
        regression_info.state = form.state.data
        session.commit()
        flash("Updated " + regression_info.title, FLASH_SUCCESS)
        return v4_redirect(v4_url_for(".v4_regression_list",
                                      highlight=regression_info.id,
                                      state=int(form.edit_state.data)))
    if request.method == 'POST' and \
            request.form['save_btn'] == "Split Regression":
        # For each of the regression indicators, grab their field ids.
        res_inds = session.query(ts.RegressionIndicator) \
            .filter(ts.RegressionIndicator.field_change_id.in_(
                form.field_changes.data)) \
            .all()
        fc_ids = [x.field_change_id for x in res_inds]
        second_regression, _ = new_regression(session, ts, fc_ids)
        second_regression.state = regression_info.state

        # Now remove our links to this regression.
        for res_ind in res_inds:
            session.delete(res_ind)
        lnt.server.db.fieldchange.rebuild_title(session, ts, regression_info)
        session.commit()
        flash("Split " + second_regression.title, FLASH_SUCCESS)
        return v4_redirect(v4_url_for(".v4_regression_list",
                                      highlight=second_regression.id,
                                      state=int(form.edit_state.data)))
    if request.method == 'POST' and request.form['save_btn'] == "Delete":
        # For each of the regression indicators, grab their field ids.
        title = regression_info.title
        res_inds = session.query(ts.RegressionIndicator) \
            .filter(
                ts.RegressionIndicator.regression_id == regression_info.id) \
            .all()
        # Now remove our links to this regression.
        for res_ind in res_inds:
            session.delete(res_ind)
        session.delete(regression_info)
        session.commit()
        flash("Deleted " + title, FLASH_SUCCESS)
        return v4_redirect(v4_url_for(".v4_regression_list",
                                      state=int(form.edit_state.data)))
    form.field_changes.choices = list()
    form.state.default = regression_info.state
    form.process()
    form.edit_state.data = regression_info.state
    form.title.data = regression_info.title
    form.bug.data = regression_info.bug
    regression_indicators = session.query(ts.RegressionIndicator) \
        .filter(ts.RegressionIndicator.regression_id == id) \
        .all()

    crs = []

    test_suite_versions = set()
    form.field_changes.choices = list()
    # If we have more than 10 regressions, don't graph any by default.
    checkbox_state = 1
    if len(regression_indicators) >= 10:
        checkbox_state = 0

    for regression in regression_indicators:
        fc = regression.field_change
        if fc is None:
            continue
        if fc.old_value is None:
            cr, key_run, all_runs = get_cr_for_field_change(session, ts, fc)
        else:
            cr = PrecomputedCR(fc.old_value, fc.new_value,
                               fc.field.bigger_is_better)
            key_run = get_first_runs_of_fieldchange(session, ts, fc)
        current_cr, _, all_runs = get_cr_for_field_change(session, ts, fc,
                                                          current=True)
        crs.append(ChangeData(fc, cr, key_run, current_cr))
        form.field_changes.choices.append((fc.id, checkbox_state,))
        for run in all_runs:
            ts_rev = key_run.parameters.get('test_suite_revision')
            if ts_rev and ts_rev != u'None':
                test_suite_versions.add(ts_rev)

    if len(test_suite_versions) > 1:
        revs = ', '.join(list(test_suite_versions))
        flash("More than one test-suite version: " + revs,
              FLASH_DANGER)

    if request.args.get('json'):
        return json.dumps({u'Regression': regression_info,
                           u'Changes': crs},
                          cls=LNTEncoder)

    return render_template("v4_regression_detail.html",
                           testsuite_name=g.testsuite_name,
                           regression=regression_info, changes=crs,
                           form=form, analysis=lnt.server.reporting.analysis,
                           check_all=checkbox_state,
                           **ts_data(ts))


@v4_route("/hook", methods=["GET"])
def v4_hook():
    session = request.session
    ts = request.get_testsuite()
    rule_hooks.post_submission_hooks(session, ts, 0)
    abort(400)


@v4_route("/regressions/new_from_graph/<int:machine_id>/<int:test_id>"
          "/<int:field_index>/<int:run_id>", methods=["GET"])
def v4_make_regression(machine_id, test_id, field_index, run_id):
    """This function is called to make a new regression from a graph data point.

    It is not nessessarly the case that there will be a real change there,
    so we must create a regression, bypassing the normal analysis.

    """
    session = request.session
    ts = request.get_testsuite()
    field = ts.sample_fields[field_index]
    run = session.query(ts.Run).get(run_id)

    runs = session.query(ts.Run). \
        filter(ts.Run.order_id == run.order_id). \
        filter(ts.Run.machine_id == run.machine_id). \
        all()

    if len(runs) == 0:
        abort(404)

    previous_runs = ts.get_previous_runs_on_machine(session, run, 1)

    # Find our start/end order.
    if previous_runs != []:
        start_order = previous_runs[0].order
    else:
        start_order = run.order
    end_order = run.order

    # Load our run data for the creation of the new fieldchanges.
    runs_to_load = [r.id for r in (runs + previous_runs)]

    runinfo = lnt.server.reporting.analysis.RunInfo(session, ts, runs_to_load)

    result = runinfo.get_comparison_result(
        runs, previous_runs, test_id, field,
        ts.Sample.get_hash_of_binary_field())

    # Try and find a matching FC and update, else create one.
    try:
        f = session.query(ts.FieldChange) \
            .filter(ts.FieldChange.start_order == start_order) \
            .filter(ts.FieldChange.end_order == end_order) \
            .filter(ts.FieldChange.test_id == test_id) \
            .filter(ts.FieldChange.machine == run.machine) \
            .filter(ts.FieldChange.field_id == field.id) \
            .one()
    except sqlalchemy.orm.exc.NoResultFound:
        # Create one
        test = session.query(ts.Test).filter(ts.Test.id == test_id).one()
        f = ts.FieldChange(start_order=start_order,
                           end_order=run.order,
                           machine=run.machine,
                           test=test,
                           field_id=field.id)
        session.add(f)

    # Always update FCs with new values.
    if f:
        f.old_value = result.previous
        f.new_value = result.current
        f.run = run
    session.commit()

    # Make new regressions.
    regression, _ = new_regression(session, ts, [f.id])
    regression.state = RegressionState.ACTIVE

    session.commit()
    logger.info("Manually created new regressions: {}".format(regression.id))
    flash("Created " + regression.title, FLASH_SUCCESS)

    return v4_redirect(v4_url_for(".v4_regression_detail", id=regression.id))

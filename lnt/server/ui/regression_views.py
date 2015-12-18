import datetime
from flask import g
from flask import render_template
from flask import request
from flask import make_response
from flask import flash
from flask import redirect

# import sqlalchemy.sql
# from sqlalchemy.orm.exc import NoResultFound

from lnt.server.ui.decorators import v4_route
from lnt.server.reporting.analysis import RunInfo
import lnt.server.reporting.analysis
from lnt.server.ui.globals import db_url_for, v4_url_for

from collections import namedtuple
from random import randint
from sqlalchemy import desc, asc
from lnt.server.ui.util import FLASH_DANGER, FLASH_INFO, FLASH_SUCCESS
from lnt.server.reporting.analysis import REGRESSED
from wtforms import SelectMultipleField, StringField, widgets, SelectField
from flask_wtf import Form
from wtforms.validators import DataRequired
import lnt.server.ui.util as util

import lnt.server.db.fieldchange


class RegressionState:
    # A new regression, not approved by the user yet.
    DETECTED = 0
    # Approved, but waiting for cooldown.
    STAGED = 1
    # Needs to be investigated.
    ACTIVE = 10

    # We won't fix this.
    NTBF = 20
    # This is not a real regression.
    IGNORED = 21
    # Manually marked as fixed.
    FIXED = 22
    # System detected it is fixed.
    DETECTED_FIXED = 23
    names = {DETECTED: u'Detected',
             STAGED: u'Staged',
             ACTIVE: u'Active',
             NTBF: u'Not to be Fixed',
             IGNORED: u'Ignored',
             DETECTED_FIXED: u'Verify',
             FIXED: u'Fixed'
             }


class MultiCheckboxField(SelectMultipleField):
    """
    A multiple-select, except displays a list of checkboxes.

    Iterating the field will produce subfields, allowing custom rendering of
    the enclosed checkbox fields.
    """
    widget = widgets.ListWidget(prefix_label=False)
    option_widget = widgets.CheckboxInput()


class TriagePageSelectedForm(Form):
    field_changes = MultiCheckboxField("Changes", coerce=int)
    name = StringField('name', validators=[DataRequired()])


ChangeData = namedtuple("ChangeData", ["ri", "cr", "run", "latest_cr"])


def get_fieldchange(ts, id):
    return ts.query(ts.FieldChange).filter(ts.FieldChange.id == id).one()


class PrecomputedCR():
    """Make a thing that looks like a comprison result, that is derived
    from a field change."""
    previous = 0
    current = 0
    pct_delta = 0.00
    bigger_is_better = False

    def __init__(self, old, new, bigger_is_better):
        self.previous = old
        self.current = new
        self.delta = new - old
        self.pct_delta = self.delta / old

    def get_test_status(self):
        return True

    def get_value_status(self, ignore_small=True):
        return REGRESSED


def new_regression(ts, field_changes):
    """Make a new regression and add to DB."""
    today = datetime.date.today()
    MSG = "Regression of 0 benchmarks"
    title = MSG
    regression = ts.Regression(title, "", RegressionState.DETECTED)
    ts.add(regression)
    for fc_id in field_changes:
        fc = get_fieldchange(ts, fc_id)
        ri1 = ts.RegressionIndicator(regression, fc)
        ts.add(ri1)
    lnt.server.db.fieldchange.rebuild_title(ts, regression)
    ts.commit()
    return regression


@v4_route("/regressions/new", methods=["GET", "POST"])
def v4_new_regressions():
    form = TriagePageSelectedForm(request.form)
    ts = request.get_testsuite()
    if request.method == 'POST' and request.form['btn'] == "Create New Regression":
        regression = new_regression(ts, form.field_changes.data)
        flash("Created " + regression.title, FLASH_SUCCESS)
        return redirect(v4_url_for("v4_regression_list",
                        highlight=regression.id))
    if request.method == 'POST' and request.form['btn'] == "Ignore Changes":
        msg = "Ignoring changes: "
        ignored = []
        for fc_id in form.field_changes.data:
            ignored.append(str(fc_id))
            fc = get_fieldchange(ts, fc_id)
            ignored_change = ts.ChangeIgnore(fc)
            ts.add(ignored_change)
        ts.commit()
        flash(msg + ", ".join(ignored), FLASH_SUCCESS)

#    d = datetime.datetime.now()
#    two_weeks_ago = d - datetime.timedelta(days=14)
    recent_fieldchange = ts.query(ts.FieldChange) \
        .join(ts.Test) \
        .outerjoin(ts.ChangeIgnore) \
        .filter(ts.ChangeIgnore.id == None) \
        .outerjoin(ts.RegressionIndicator) \
        .filter(ts.RegressionIndicator.id == None) \
        .order_by(desc(ts.FieldChange.id)) \
        .limit(500) \
        .all()
    crs = []

    form.field_changes.choices = list()
    for fc in recent_fieldchange:
        if fc.old_value is None:
            cr, key_run = get_cr_for_field_change(ts, fc)
        else:
            cr = PrecomputedCR(fc.old_value, fc.new_value, fc.field.bigger_is_better)
            key_run = get_first_runs_of_fieldchange(ts, fc)
        current_cr, _ = get_cr_for_field_change(ts, fc, current=True)
        crs.append(ChangeData(fc, cr, key_run, current_cr))
        form.field_changes.choices.append((fc.id, 1,))
    return render_template("v4_new_regressions.html",
                           testsuite_name=g.testsuite_name,
                           changes=crs, analysis=lnt.server.reporting.analysis,
                           form=form)


ChangeRuns = namedtuple("ChangeRuns", ["before", "after"])


def get_runs_for_order_and_machine(ts, order_id, machine_id):
    """Collect all the runs for a particular order/machine combo."""
    runs = ts.query(ts.Run) \
        .filter(ts.Run.machine_id == machine_id) \
        .filter(ts.Run.order_id == order_id) \
        .all()
    return runs


def get_runs_of_fieldchange(ts, fc):
    before_runs = get_runs_for_order_and_machine(ts, fc.start_order_id,
                                                 fc.machine_id)
    after_runs = get_runs_for_order_and_machine(ts, fc.end_order_id,
                                                fc.machine_id)
    return ChangeRuns(before_runs, after_runs)


def get_current_runs_of_fieldchange(ts, fc):
    before_runs = get_runs_for_order_and_machine(ts, fc.start_order_id,
                                                 fc.machine_id)
    newest_order = get_all_orders_for_machine(ts, fc.machine_id)[-1]

    after_runs = get_runs_for_order_and_machine(ts, newest_order.id,
                                                fc.machine_id)
    return ChangeRuns(before_runs, after_runs)


def get_first_runs_of_fieldchange(ts, fc):
    # import ipdb; ipdb.set_trace()
    run = ts.query(ts.Run) \
        .filter(ts.Run.machine_id == fc.machine_id) \
        .filter(ts.Run.order_id == fc.end_order_id) \
        .first()
    return run


def get_all_orders_for_machine(ts, machine):
    """Get all the oredrs for this sa machine."""
    return ts.query(ts.Order) \
        .join(ts.Run) \
        .filter(ts.Run.machine_id == machine) \
        .order_by(asc(ts.Order.llvm_project_revision)) \
        .all()


def get_cr_for_field_change(ts, field_change, current=False):
    """Given a filed_change, calculate a comparison result for that change. 
    And the last run."""
    if current:
        runs = get_current_runs_of_fieldchange(ts, field_change)
    else:
        runs = get_runs_of_fieldchange(ts, field_change)
    runs_all = list(runs.before)
    runs_all.extend(runs.after)
    ri = RunInfo(ts, [r.id for r in runs_all], only_tests=[field_change.test_id])
    cr = ri.get_comparison_result(runs.after, runs.before,
                                  field_change.test.id, field_change.field)
    return cr, runs.after[0]


def calc_impact(ts, fcs):
    crs = []
    for fc in fcs:
        if fc == None:
            continue
        if fc.old_value is None:
            cr, _ = get_cr_for_field_change(ts, fc)
        else:
            cr = PrecomputedCR(fc.old_value, fc.new_value, fc.field.bigger_is_better)
        crs.append(cr)
    if crs:
        olds = sum([x.previous for x in crs])
        news = sum([x.current for x in crs])
        new_cr = PrecomputedCR(olds, news, crs[0].bigger_is_better) # TODO both directions
        return new_cr
    else:
        return PrecomputedCR(1, 1, True)


class MergeRegressionForm(Form):
    regression_checkboxes = MultiCheckboxField("regression_checkboxes",
                                               coerce=int)


@v4_route("/regressions/", methods=["GET", "POST"])
def v4_regression_list():
    ts = request.get_testsuite()
    form = MergeRegressionForm(request.form)

    if request.method == 'POST' and \
       request.form['merge_btn'] == "Merge Regressions":
        regressions_id_to_merge = form.regression_checkboxes.data
        regressions = ts.query(ts.Regression) \
            .filter(ts.Regression.id.in_(regressions_id_to_merge)).all()
        reg_inds = ts.query(ts.RegressionIndicator) \
            .filter(ts.RegressionIndicator.regression_id.in_(
                    regressions_id_to_merge)) \
            .all()
        new_regress = new_regression(ts, [x.field_change_id for x in reg_inds])
        new_regress.state = regressions[0].state
        [ts.delete(x) for x in reg_inds]
        [ts.delete(x) for x in regressions]
        ts.commit()
        flash("Created" + new_regress.title, FLASH_SUCCESS)
        return redirect(v4_url_for("v4_regression_detail", id=new_regress.id))

    state_filter = int(request.args.get('state', RegressionState.ACTIVE))
    q = ts.query(ts.Regression)
    title = "All Regressions"
    if state_filter != -1:
        q = q.filter(ts.Regression.state == state_filter)
        title = RegressionState.names[state_filter]
    regression_info = q.all()[::-1]

    form.regression_checkboxes.choices = list()
    regression_sizes = []
    impacts = []
    for regression in regression_info:
        form.regression_checkboxes.choices.append((regression.id, 1,))
        reg_inds = ts.query(ts.RegressionIndicator) \
            .filter(ts.RegressionIndicator.regression_id ==
                    regression.id) \
            .all()
        regression_sizes.append(len(reg_inds))
        impacts.append(calc_impact(ts, [x.field_change for x in reg_inds]))
    return render_template("v4_regression_list.html",
                           testsuite_name=g.testsuite_name,
                           regressions=regression_info,
                           highlight=request.args.get('highlight'),
                           title=title,
                           RegressionState=RegressionState,
                           form=form,
                           sizes=regression_sizes,
                           impacts=impacts,
                           analysis=lnt.server.reporting.analysis)


class EditRegressionForm(Form):
    title = StringField(u'Title', validators=[DataRequired()])
    bug = StringField(u'Bug', validators=[DataRequired()])
    field_changes = MultiCheckboxField("Changes", coerce=int)
    choices = RegressionState.names.items()
    state = SelectField(u'State', choices=choices)


@v4_route("/regressions/<int:id>",  methods=["GET", "POST"])
def v4_regression_detail(id):
    ts = request.get_testsuite()
    form = EditRegressionForm(request.form)

    regression_info = ts.query(ts.Regression) \
        .filter(ts.Regression.id == id) \
        .one()

    if request.method == 'POST' and request.form['save_btn'] == "Save Changes":
        regression_info.title = form.title.data
        regression_info.bug = form.bug.data
        regression_info.state = form.state.data
        ts.commit()
        flash("Updated " + regression_info.title, FLASH_SUCCESS)
        return redirect(v4_url_for("v4_regression_list",
                        highlight=regression_info.id,
                        state=regression_info.state))
    if request.method == 'POST' and request.form['save_btn'] == "Split Regression":
        # For each of the regression indicators, grab their field ids.
        res_inds = ts.query(ts.RegressionIndicator) \
            .filter(ts.RegressionIndicator.field_change_id.in_(form.field_changes.data)) \
            .all()
        fc_ids = [x.field_change_id for x in res_inds]
        second_regression = new_regression(ts, fc_ids)
        second_regression.state = regression_info.state

        # Now remove our links to this regression.
        for res_ind in res_inds:
            ts.delete(res_ind)
        lnt.server.db.fieldchange.rebuild_title(ts, regression_info)
        ts.commit()
        flash("Split " + second_regression.title, FLASH_SUCCESS)
        return redirect(v4_url_for("v4_regression_list",
                        highlight=second_regression.id))
    if request.method == 'POST' and request.form['save_btn'] == "Delete":
        # For each of the regression indicators, grab their field ids.
        title = regression_info.title
        res_inds = ts.query(ts.RegressionIndicator) \
            .filter(ts.RegressionIndicator.regression_id == regression_info.id) \
            .all()
        # Now remove our links to this regression.
        for res_ind in res_inds:
            ts.delete(res_ind)
        ts.delete(regression_info)
        ts.commit()
        flash("Deleted " + title, FLASH_SUCCESS)
        return redirect(v4_url_for("v4_regression_list"))
    form.field_changes.choices = list()
    form.state.default = regression_info.state
    form.process()
    form.title.data = regression_info.title
    form.bug.data = regression_info.bug
    regression_indicators = ts.query(ts.RegressionIndicator) \
        .filter(ts.RegressionIndicator.regression_id == id) \
        .all()
    # indicators = []
    # for regression in regression_indicators:
    #     fc = regression.field_change
    #     cr, key_run = get_cr_for_field_change(ts, fc)
    #     latest_cr, _ = get_cr_for_field_change(ts, fc, current=True)
    #     indicators.append(ChangeData(fc, cr, key_run, latest_cr))
    
    
    ######
    crs = []

    form.field_changes.choices = list()
    for regression in regression_indicators:
        fc = regression.field_change
        if fc is None:
            continue
        if fc.old_value is None:
            cr, key_run = get_cr_for_field_change(ts, fc)
        else:
            cr = PrecomputedCR(fc.old_value, fc.new_value, fc.field.bigger_is_better)
            key_run = get_first_runs_of_fieldchange(ts, fc)
        current_cr, _ = get_cr_for_field_change(ts, fc, current=True)
        crs.append(ChangeData(fc, cr, key_run, current_cr))
        form.field_changes.choices.append((fc.id, 1,))

    return render_template("v4_regression_detail.html",
                           testsuite_name=g.testsuite_name,
                           regression=regression_info, changes=crs,
                           form=form, analysis=lnt.server.reporting.analysis)

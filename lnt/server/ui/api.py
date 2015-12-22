from flask import current_app, g
from flask import request
from sqlalchemy.orm.exc import NoResultFound
from flask_restful import Resource, reqparse, fields, marshal_with, abort
from lnt.testing import PASS
import json
parser = reqparse.RequestParser()
parser.add_argument('db', type=str)


def in_db(func):
    """Extract the database information off the request and attach to
    particular test suite and database."""
    def wrap(*args, **kwargs):
        db = kwargs.pop('db')
        ts = kwargs.pop('ts')
        g.db_name = db
        g.testsuite_name = ts
        g.db_info = current_app.old_config.databases.get(g.db_name)
        if g.db_info is None:
            abort(404, message="Invalid database.")
        # Compute result.
        result = func(*args, **kwargs)

        # Make sure that any transactions begun by this request are finished.
        request.get_db().rollback()
        return result
    return wrap


def ts_path(path):
    """Make a URL path with a database and test suite embedded in them."""
    return "/api/db_<string:db>/v4/<string:ts>/" + path


def with_ts(obj):
    """For Url type fields to work, the objects we return must have a test-suite
    and database attribute set, the function attempts to set them."""
    if type(obj) == list:
        # For lists, set them on all elements.
        return [with_ts(x) for x in obj]
    if type(obj) == dict:
        # If already a dict, just add the fields.
        new_obj = obj
    else:
        # Sqlalcamey objects are read-only and store their attributes in a
        # sub-dict.  Make a copy so we can edit it.
        new_obj = obj.__dict__.copy()

    new_obj['db'] = g.db_name
    new_obj['ts'] = g.testsuite_name
    return new_obj


# This date format is what the JavaScript in the LNT frontend likes.
DATE_FORMAT = "iso8601"


machines_fields = {
    'id': fields.Integer,
    'name': fields.String,
    'os': fields.String,
    'hardware': fields.String,
}


class Machines(Resource):
    """List all the machines and give summary information."""
    method_decorators = [in_db]

    @marshal_with(machines_fields)
    def get(self):
        ts = request.get_testsuite()
        changes = ts.query(ts.Machine).all()
        return changes


machine_fields = {
    'id': fields.Integer,
    'name': fields.String,
    'os': fields.String,
    'hardware': fields.String,
    'runs': fields.List(fields.Url('runs')),
}


class Machine(Resource):
    """Detailed results about a particular machine, including runs on it."""
    method_decorators = [in_db]

    @marshal_with(machine_fields)
    def get(self, machine_id):

        ts = request.get_testsuite()
        try:
            machine = ts.query(ts.Machine).filter(
                    ts.Machine.id == machine_id).one()
        except NoResultFound:
            abort(404, message="Invalid machine.")

        machine = with_ts(machine)
        machine_runs = ts.query(ts.Run.id).join(ts.Machine).filter(
                ts.Machine.id == machine_id).all()

        machine['runs'] = with_ts([dict(run_id=x[0]) for x in machine_runs])
        print machine['runs']
        return machine


run_fields = {
    'id': fields.Integer,
    'start_time': fields.DateTime(dt_format=DATE_FORMAT),
    'end_time': fields.DateTime(dt_format=DATE_FORMAT),
    'machine_id': fields.Integer,
    'machine': fields.Url("machine"),
    'order_id': fields.Integer,
    'order': fields.Url("order"),
}


class Runs(Resource):
    method_decorators = [in_db]

    @marshal_with(run_fields)
    def get(self, run_id):
        ts = request.get_testsuite()
        try:
            changes = ts.query(ts.Run).join(ts.Machine).filter(
                ts.Run.id == run_id).one()
        except NoResultFound:
            abort(404, message="Invalid run.")

        changes = with_ts(changes)
        return changes


order_fields = {
    'id': fields.Integer,
    'llvm_project_revision': fields.String,
    'next_order_id': fields.Integer,
    'previous_order_id': fields.Integer,
}


class Order(Resource):
    method_decorators = [in_db]

    @marshal_with(order_fields)
    def get(self, order_id):
        ts = request.get_testsuite()
        try:
            changes = ts.query(ts.Order).filter(ts.Order.id == order_id).one()
        except NoResultFound:
            abort(404, message="Invalid order.")
        return changes


class Graph(Resource):
    """List all the machines and give summary information."""
    method_decorators = [in_db]

    def get(self, machine_id, test_id, field_index):
        """Get the data for a particular line in a graph."""
        ts = request.get_testsuite()
        # Maybe we don't need to do this?
        try:
            machine = ts.query(ts.Machine) \
                .filter(ts.Machine.id == machine_id) \
                .one()
            test = ts.query(ts.Test) \
                .filter(ts.Test.id == test_id) \
                .one()
            field = ts.sample_fields[field_index]
        except NoResultFound:
            return abort(404)

        q = ts.query(field.column, ts.Order.llvm_project_revision, ts.Run.start_time, ts.Run.id) \
            .join(ts.Run) \
            .join(ts.Order) \
            .filter(ts.Run.machine_id == machine.id) \
            .filter(ts.Sample.test == test) \
            .filter(field.column != None) \
            .order_by(ts.Order.llvm_project_revision)

        if field.status_field:
            q = q.filter((field.status_field.column == PASS) |
                         (field.status_field.column == None))
        samples = [[rev, val, {'label': rev, 'date': str(time), 'runID': str(rid)}] for val, rev, time, rid in q.all()]

        return samples


class Regression(Resource):
    """List all the machines and give summary information."""
    method_decorators = [in_db]

    def get(self, machine_id, test_id, field_index):
        """Get the regressions for a particular line in a graph."""
        ts = request.get_testsuite()
        field = ts.sample_fields[field_index]
        # Maybe we don't need to do this?
        fcs = ts.query(ts.FieldChange) \
            .filter(ts.FieldChange.machine_id == machine_id) \
            .filter(ts.FieldChange.test_id == test_id) \
            .filter(ts.FieldChange.field_id == field.id) \
            .all()
        fc_ids = [x.id for x in fcs]
        fc_mappings = dict([(x.id, (x.end_order.as_ordered_string(), x.new_value)) for x in fcs])
        if len(fcs) == 0:
            # If we don't find anything, lets see if we are even looking
            # for a valid thing to provide a nice error.
            try:
                machine = ts.query(ts.Machine) \
                    .filter(ts.Machine.id == machine_id) \
                    .one()
                test = ts.query(ts.Test) \
                    .filter(ts.Test.id == test_id) \
                    .one()
                field = ts.sample_fields[field_index]
            except NoResultFound:
                return abort(404)
            # I think we found nothing.
            return []
        regressions = ts.query(ts.Regression.title, ts.Regression.id, ts.RegressionIndicator.field_change_id, ts.Regression.state) \
            .join(ts.RegressionIndicator) \
            .filter(ts.RegressionIndicator.field_change_id.in_(fc_ids)) \
            .all()
        results = [{'title': r.title,
                    'id': r.id, 
                    'state': r.state, 
                    'end_point': fc_mappings[r.field_change_id]} for r in regressions]
        return results


def load_api_resources(api):
    api.add_resource(Machines, ts_path("machines"))
    api.add_resource(Machine, ts_path("machine/<int:machine_id>"))
    api.add_resource(Runs, ts_path("run/<int:run_id>"))
    api.add_resource(Order, ts_path("order/<int:order_id>"))
    graph_url = "graph/<int:machine_id>/<int:test_id>/<int:field_index>"
    api.add_resource(Graph, ts_path(graph_url))
    regression_url = "regression/<int:machine_id>/<int:test_id>/<int:field_index>"
    api.add_resource(Regression, ts_path(regression_url))

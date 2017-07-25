import lnt.util.ImportData
import sqlalchemy
from flask import current_app, g, Response, make_response, stream_with_context
from flask import json, jsonify
from flask import request
from flask_restful import Resource, abort
from sqlalchemy.orm import joinedload
from sqlalchemy.orm.exc import NoResultFound

from lnt.server.ui.util import convert_revision
from lnt.testing import PASS
from lnt.util import logger
from functools import wraps


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


def requires_auth_token(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        token = request.headers.get("AuthToken", None)
        if not current_app.old_config.api_auth_token or \
           token != current_app.old_config.api_auth_token:
            abort(401, msg="Auth Token must be passed in AuthToken header, "
                           "and included in LNT config.")
        return f(*args, **kwargs)

    return decorated


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
        # SQLAlchemy objects are read-only and store their attributes in a
        # sub-dict.  Make a copy so we can edit it.
        new_obj = obj.__dict__.copy()

    new_obj['db'] = g.db_name
    new_obj['ts'] = g.testsuite_name
    for key in ['machine', 'order']:
        if new_obj.get(key):
            new_obj[key] = with_ts(new_obj[key])
    return new_obj


def common_fields_factory():
    """Get a dict with all the common fields filled in."""
    common_data = {
        'generated_by': 'LNT Server v{}'.format(current_app.version),
    }
    return common_data


def add_common_fields(to_update):
    """Update a dict with the common fields."""
    to_update.update(common_fields_factory())


class Machines(Resource):
    """List all the machines and give summary information."""
    method_decorators = [in_db]

    @staticmethod
    def get():
        ts = request.get_testsuite()
        machines = ts.query(ts.Machine).all()

        result = common_fields_factory()
        result['machines'] = machines
        return result


class Machine(Resource):
    """Detailed results about a particular machine, including runs on it."""
    method_decorators = [in_db]

    @staticmethod
    def _get_machine(machine_spec):
        ts = request.get_testsuite()
        # Assume id number if machine_spec is numeric, otherwise a name.
        if machine_spec.isdigit():
            machine = ts.query(ts.Machine) \
                .filter(ts.Machine.id == machine_spec).first()
        else:
            machines = ts.query(ts.Machine) \
                .filter(ts.Machine.name == machine_spec).all()
            if len(machines) == 0:
                machine = None
            elif len(machines) > 1:
                abort(404, msg="Name '%s' is ambiguous; specify machine id" %
                      (machine_spec))
        if machine is None:
            abort(404, msg="Did not find machine '%s'" % (machine_spec,))
        return machine

    @staticmethod
    def get(machine_spec):
        ts = request.get_testsuite()
        machine = Machine._get_machine(machine_spec)
        machine_runs = ts.query(ts.Run) \
            .filter(ts.Run.machine_id == machine.id) \
            .options(joinedload(ts.Run.order)) \
            .all()

        runs = [run.__json__(flatten_order=True) for run in machine_runs]

        result = common_fields_factory()
        result['machine'] = machine
        result['runs'] = runs
        return result

    @staticmethod
    @requires_auth_token
    def delete(machine_spec):
        ts = request.get_testsuite()
        machine = Machine._get_machine(machine_spec)

        # Just saying ts.session.delete(machine) takes a long time and risks
        # running into OOM or timeout situations for machines with a hundreds
        # of runs. So instead remove machine runs in chunks.
        def perform_delete(ts, machine):
            count = ts.query(ts.Run) \
                .filter(ts.Run.machine_id == machine.id).count()
            at = 0
            while True:
                runs = ts.query(ts.Run) \
                    .filter(ts.Run.machine_id == machine.id) \
                    .options(joinedload(ts.Run.samples)) \
                    .options(joinedload(ts.Run.fieldchanges)) \
                    .order_by(ts.Run.id).limit(10).all()
                if len(runs) == 0:
                    break
                at += len(runs)
                msg = "Deleting runs %s (%d/%d)" % \
                    (" ".join([str(run.id) for run in runs]), at, count)
                logger.info(msg)
                yield msg + '\n'
                for run in runs:
                    ts.session.delete(run)
                ts.commit()

            machine_name = "%s:%s" % (machine.name, machine.id)
            ts.session.delete(machine)
            ts.commit()
            msg = "Deleted machine %s" % machine_name
            logger.info(msg)
            yield msg + '\n'

        stream = stream_with_context(perform_delete(ts, machine))
        return Response(stream, mimetype="text/plain")

    @staticmethod
    @requires_auth_token
    def post(machine_spec):
        ts = request.get_testsuite()
        machine = Machine._get_machine(machine_spec)
        machine_name = "%s:%s" % (machine.name, machine.id)

        action = request.values.get('action', None)
        if action is None:
            abort(400, msg="No 'action' specified")
        elif action == 'rename':
            name = request.values.get('name', None)
            if name is None:
                abort(400, msg="Expected 'name' for rename request")
            existing = ts.query(ts.Machine).filter(ts.Machine.name == name) \
                .first()
            if existing is not None:
                abort(400, msg="Machine with name '%s' already exists" % name)
            machine.name = name
            ts.session.commit()
            logger.info("Renamed machine %s to %s" % (machine_name, name))
        elif action == 'merge':
            into_id = request.values.get('into', None)
            if into_id is None:
                abort(400, msg="Expected 'into' for merge request")
            into = Machine._get_machine(into_id)
            into_name = "%s:%s" % (into.name, into.id)
            ts.query(ts.Run) \
                .filter(ts.Run.machine_id == machine.id) \
                .update({ts.Run.machine_id: into.id},
                        synchronize_session=False)
            ts.session.expire_all()  # be safe after synchronize_session==False
            # re-query Machine so we can delete it.
            machine = Machine._get_machine(machine_spec)
            ts.delete(machine)
            ts.session.commit()
            logger.info("Merged machine %s into %s" %
                        (machine_name, into_name))
            logger.info("Deleted machine %s" % machine_name)
        else:
            abort(400, msg="Unknown action '%s'" % action)


class Run(Resource):
    method_decorators = [in_db]

    @staticmethod
    def get(run_id):
        ts = request.get_testsuite()
        full_run = common_fields_factory()

        try:
            run = ts.query(ts.Run) \
                .filter(ts.Run.id == run_id) \
                .options(joinedload(ts.Run.machine)) \
                .options(joinedload(ts.Run.order)) \
                .one()
        except sqlalchemy.orm.exc.NoResultFound:
            abort(404, msg="Did not find run " + str(run_id))

        to_get = [ts.Sample.id, ts.Sample.run_id, ts.Test.name]
        for f in ts.sample_fields:
            to_get.append(f.column)

        sample_query = ts.query(*to_get) \
            .join(ts.Test) \
            .filter(ts.Sample.run_id == run_id) \
            .all()
        # TODO: Handle multiple samples for a single test?

        # noinspection PyProtectedMember
        samples = [row._asdict() for row in sample_query]

        result = common_fields_factory()
        result['run'] = run
        result['machine'] = run.machine
        result['tests'] = samples
        return result

    @staticmethod
    @requires_auth_token
    def delete(run_id):
        ts = request.get_testsuite()
        run = ts.query(ts.Run).filter(ts.Run.id == run_id).first()
        if run is None:
            abort(404, msg="Did not find run " + str(run_id))
        ts.delete(run)
        ts.commit()
        logger.info("Deleted run %s" % (run_id,))


class Runs(Resource):
    """Detailed results about a particular machine, including runs on it."""
    method_decorators = [in_db]

    @staticmethod
    @requires_auth_token
    def post():
        """Add a new run into the lnt database"""
        db = request.get_db()
        data = request.data
        result = lnt.util.ImportData.import_from_string(
            current_app.old_config, g.db_name, db, g.testsuite_name, data)

        new_url = ('%sapi/db_%s/v4/%s/runs/%s' %
                   (request.url_root, g.db_name, g.testsuite_name,
                    result['run_id']))
        result['result_url'] = new_url
        response = jsonify(result)
        response.status = '301'
        response.headers.add('Location', new_url)
        return response


class Order(Resource):
    method_decorators = [in_db]

    @staticmethod
    def get(order_id):
        ts = request.get_testsuite()
        try:
            order = ts.query(ts.Order).filter(ts.Order.id == order_id).one()
        except NoResultFound:
            abort(404, message="Invalid order.")
        result = common_fields_factory()
        result['orders'] = [order]
        return result


class SampleData(Resource):
    method_decorators = [in_db]

    @staticmethod
    def get(sample_id):
        ts = request.get_testsuite()
        try:
            sample = ts.query(ts.Sample) \
                .filter(ts.Sample.id == sample_id) \
                .one()
        except NoResultFound:
            abort(404, message="Invalid order.")
        result = common_fields_factory()
        result['samples'] = [sample]
        return result


class SamplesData(Resource):
    """List all the machines and give summary information."""
    method_decorators = [in_db]

    @staticmethod
    def get():
        """Get the data for a particular line in a graph."""
        ts = request.get_testsuite()
        args = request.args.to_dict(flat=False)
        # Maybe we don't need to do this?
        run_ids = [int(r) for r in args.get('runid', [])]

        if not run_ids:
            abort(400, msg='No runids found in args. '
                           'Should be "samples?runid=1&runid=2" etc.')

        to_get = [ts.Sample.id,
                  ts.Sample.run_id,
                  ts.Test.name,
                  ts.Order.fields[0].column]

        for f in ts.sample_fields:
            to_get.append(f.column)

        q = ts.query(*to_get) \
            .join(ts.Test) \
            .join(ts.Run) \
            .join(ts.Order) \
            .filter(ts.Sample.run_id.in_(run_ids))
        result = common_fields_factory()
        # noinspection PyProtectedMember
        result['samples'] = [{k: v for k, v in sample.items() if v is not None}
                             for sample in [sample._asdict()
                                            for sample in q.all()]]

        return result


class Graph(Resource):
    """List all the machines and give summary information."""
    method_decorators = [in_db]

    @staticmethod
    def get(machine_id, test_id, field_index):
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
            abort(404)

        q = ts.query(field.column, ts.Order.llvm_project_revision,
                     ts.Run.start_time, ts.Run.id) \
            .join(ts.Run) \
            .join(ts.Order) \
            .filter(ts.Run.machine_id == machine.id) \
            .filter(ts.Sample.test == test) \
            .filter(field.column.isnot(None)) \
            .order_by(ts.Order.llvm_project_revision.desc())

        if field.status_field:
            q = q.filter((field.status_field.column == PASS) |
                         (field.status_field.column.is_(None)))

        limit = request.values.get('limit', None)
        if limit:
            limit = int(limit)
            if limit:
                q = q.limit(limit)

        samples = [
            [convert_revision(rev), val,
             {'label': rev, 'date': str(time), 'runID': str(rid)}]
            for val, rev, time, rid in q.all()[::-1]
        ]
        samples.sort(key=lambda x: x[0])
        return samples


class Regression(Resource):
    """List all the machines and give summary information."""
    method_decorators = [in_db]

    @staticmethod
    def get(machine_id, test_id, field_index):
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
        fc_mappings = dict(
            [(x.id, (x.end_order.as_ordered_string(), x.new_value))
             for x in fcs])
        if len(fcs) == 0:
            # If we don't find anything, lets see if we are even looking
            # for a valid thing to provide a nice error.
            try:
                ts.query(ts.Machine) \
                    .filter(ts.Machine.id == machine_id) \
                    .one()
                ts.query(ts.Test) \
                    .filter(ts.Test.id == test_id) \
                    .one()
                _ = ts.sample_fields[field_index]
            except (NoResultFound, IndexError):
                abort(404)
            # I think we found nothing.
            return []
        regressions = ts.query(ts.Regression.title, ts.Regression.id,
                               ts.RegressionIndicator.field_change_id,
                               ts.Regression.state) \
            .join(ts.RegressionIndicator) \
            .filter(ts.RegressionIndicator.field_change_id.in_(fc_ids)) \
            .all()
        results = [
            {
                'title': r.title,
                'id': r.id,
                'state': r.state,
                'end_point': fc_mappings[r.field_change_id]
            }
            for r in regressions
        ]
        return results


def ts_path(path):
    """Make a URL path with a database and test suite embedded in them."""
    return "/api/db_<string:db>/v4/<string:ts>/" + path


def load_api_resources(api):
    @api.representation('application/json')
    def output_json(data, code, headers=None):
        '''Override output_json() to use LNT json encoder'''
        resp = make_response(json.dumps(data), code)
        resp.headers.add('Access-Control-Allow-Origin', '*')
        if headers is not None:
            resp.headers.extend(headers)
        return resp

    api.add_resource(Machines, ts_path("machines"), ts_path("machines/"))
    api.add_resource(Machine, ts_path("machines/<machine_spec>"))
    api.add_resource(Runs, ts_path("runs"), ts_path("runs/"))
    api.add_resource(Run, ts_path("runs/<int:run_id>"))
    api.add_resource(SamplesData, ts_path("samples"), ts_path("samples/"))
    api.add_resource(SampleData, ts_path("samples/<sample_id>"))
    api.add_resource(Order, ts_path("orders/<int:order_id>"))
    graph_url = "graph/<int:machine_id>/<int:test_id>/<int:field_index>"
    api.add_resource(Graph, ts_path(graph_url))
    regression_url = \
        "regression/<int:machine_id>/<int:test_id>/<int:field_index>"
    api.add_resource(Regression, ts_path(regression_url))

"""Machine endpoints for the v5 API.

GET    /api/v5/{ts}/machines                      -- List machines
POST   /api/v5/{ts}/machines                      -- Create machine
GET    /api/v5/{ts}/machines/{machine_name}        -- Machine detail
PATCH  /api/v5/{ts}/machines/{machine_name}        -- Update machine
DELETE /api/v5/{ts}/machines/{machine_name}         -- Delete machine
GET    /api/v5/{ts}/machines/{machine_name}/runs   -- List runs for machine
"""

from flask import g, jsonify, make_response
from flask.views import MethodView
from flask_smorest import Blueprint
from sqlalchemy import or_

from ..auth import require_scope
from ..errors import abort_with_error, reject_unknown_params
from ..etag import add_etag_to_response
from ..helpers import (
    dump_response, escape_like, format_utc, lookup_machine,
    parse_datetime,
)
from ..pagination import (
    cursor_paginate,
    make_paginated_response,
)
from ..schemas.machines import (
    MachineCreateSchema,
    MachineListQuerySchema,
    MachineResponseSchema,
    MachineRunResponseSchema,
    MachineRunsQuerySchema,
    MachineUpdateSchema,
    PaginatedMachineResponseSchema,
    PaginatedMachineRunResponseSchema,
)

_machine_schema = MachineResponseSchema()
_machine_run_schema = MachineRunResponseSchema()

blp = Blueprint(
    'Machines',
    __name__,
    url_prefix='/api/v5/<testsuite>',
    description='List, create, update, and delete machines, and list their runs',
)


def _split_machine_info(info, ts):
    """Split an info dict into (schema_fields, parameters).

    Keys matching schema-defined machine_fields go into schema_fields;
    everything else goes into parameters.
    """
    field_names = ts._machine_field_names
    schema_fields = {}
    params = {}
    for key, value in info.items():
        if key in field_names:
            schema_fields[key] = value
        else:
            params[key] = value
    return schema_fields, params


def _serialize_machine(machine, ts):
    """Serialize a Machine model instance for the API response."""
    info = {}
    for mf in ts.schema.machine_fields:
        val = getattr(machine, mf.name, None)
        if val is not None:
            info[mf.name] = str(val)
    params = machine.parameters
    if params:
        for k, v in params.items():
            info[k] = str(v)
    return dump_response(_machine_schema, {
        'name': machine.name,
        'info': info,
    })


@blp.route('/machines')
class MachineList(MethodView):
    """List and create machines."""

    @require_scope('read')
    @blp.arguments(MachineListQuerySchema, location="query")
    @blp.response(200, PaginatedMachineResponseSchema)
    def get(self, query_args, testsuite):
        """List machines (offset-paginated, filterable)."""
        reject_unknown_params({'search', 'limit', 'offset'})
        ts = g.ts
        session = g.db_session

        query = session.query(ts.Machine)

        search = query_args.get('search')
        if search:
            escaped = escape_like(search)
            conditions = [
                ts.Machine.name.like(escaped + '%', escape='\\')]
            for mf in ts.schema.searchable_machine_fields:
                col = getattr(ts.Machine, mf.name)
                conditions.append(
                    col.like(escaped + '%', escape='\\'))
            query = query.filter(or_(*conditions))

        query = query.order_by(ts.Machine.name.asc())

        total = query.count()

        limit = query_args['limit']
        limit = max(1, min(limit, 500))

        offset = query_args['offset']
        offset = max(0, offset)

        machines = query.offset(offset).limit(limit).all()

        items = [_serialize_machine(m, ts) for m in machines]
        return jsonify(make_paginated_response(items, None, total=total))

    @require_scope('manage')
    @blp.arguments(MachineCreateSchema)
    @blp.response(201, MachineResponseSchema)
    def post(self, body, testsuite):
        """Create a new machine."""
        ts = g.ts
        session = g.db_session

        name = body['name'].strip()

        existing = ts.get_machine(session, name=name)
        if existing:
            abort_with_error(
                409, "A machine named '%s' already exists" % name)

        info = body.get('info') or {}
        schema_fields, params = _split_machine_info(info, ts)

        machine = ts.get_or_create_machine(
            session, name,
            parameters=params if params else None,
            **schema_fields)
        session.flush()

        resp = jsonify(_serialize_machine(machine, ts))
        resp.status_code = 201
        return resp


@blp.route('/machines/<string:machine_name>')
class MachineDetail(MethodView):
    """Machine detail, update, and delete."""

    @require_scope('read')
    @blp.response(200, MachineResponseSchema)
    def get(self, testsuite, machine_name):
        """Get machine detail by name."""
        reject_unknown_params(set())
        ts = g.ts
        session = g.db_session
        machine = lookup_machine(session, ts, machine_name)
        data = _serialize_machine(machine, ts)
        return add_etag_to_response(jsonify(data), data)

    @require_scope('manage')
    @blp.arguments(MachineUpdateSchema)
    @blp.response(200, MachineResponseSchema)
    def patch(self, body, testsuite, machine_name):
        """Update machine name and/or info.

        On rename, returns a Location header with the new URL.
        """
        ts = g.ts
        session = g.db_session
        machine = lookup_machine(session, ts, machine_name)

        new_name = body.get('name')
        renamed = False

        if new_name is not None:
            new_name = new_name.strip()
            if new_name != machine.name:
                existing = ts.get_machine(session, name=new_name)
                if existing:
                    abort_with_error(
                        409,
                        "A machine named '%s' already exists" % new_name)
                ts.update_machine(session, machine, name=new_name)
                renamed = True

        new_info = body.get('info')
        if new_info is not None and isinstance(new_info, dict):
            schema_updates, params = _split_machine_info(new_info, ts)
            ts.update_machine(session, machine,
                              parameters=params, **schema_updates)

        session.flush()

        result = _serialize_machine(machine, ts)
        resp = jsonify(result)

        if renamed:
            new_url = '/api/v5/%s/machines/%s' % (
                testsuite, machine.name)
            resp.headers['Location'] = new_url

        return resp

    @require_scope('manage')
    @blp.response(204)
    def delete(self, testsuite, machine_name):
        """Delete machine and all its associated runs and data."""
        ts = g.ts
        session = g.db_session
        machine = lookup_machine(session, ts, machine_name)

        # RegressionIndicator.machine_id has no CASCADE, so delete them
        # before the machine. The Regression itself remains (it may have
        # other indicators on different machines).
        session.query(ts.RegressionIndicator).filter(
            ts.RegressionIndicator.machine_id == machine.id
        ).delete(synchronize_session='fetch')

        ts.delete_machine(session, machine.id)
        session.flush()

        return make_response('', 204)


@blp.route('/machines/<string:machine_name>/runs')
class MachineRuns(MethodView):
    """List runs for a specific machine."""

    @require_scope('read')
    @blp.arguments(MachineRunsQuerySchema, location="query")
    @blp.response(200, PaginatedMachineRunResponseSchema)
    def get(self, query_args, testsuite, machine_name):
        """List runs for a machine (cursor-paginated)."""
        reject_unknown_params({'after', 'before', 'sort', 'cursor', 'limit'})
        ts = g.ts
        session = g.db_session
        machine = lookup_machine(session, ts, machine_name)

        query = session.query(ts.Run).filter(
            ts.Run.machine_id == machine.id
        )

        after_str = query_args.get('after')
        if after_str:
            after_dt = parse_datetime(after_str)
            if after_dt is None:
                abort_with_error(400, "Invalid 'after' datetime format")
            query = query.filter(ts.Run.submitted_at > after_dt)

        before_str = query_args.get('before')
        if before_str:
            before_dt = parse_datetime(before_str)
            if before_dt is None:
                abort_with_error(400, "Invalid 'before' datetime format")
            query = query.filter(ts.Run.submitted_at < before_dt)

        sort = query_args.get('sort')
        descending = (sort == '-submitted_at')

        cursor_str = query_args.get('cursor')
        limit = query_args['limit']
        items, next_cursor = cursor_paginate(
            query, ts.Run.id, cursor_str, limit, descending=descending)

        serialized = [dump_response(_machine_run_schema, {
            'uuid': run.uuid,
            'commit': run.commit_obj.commit if run.commit_obj else None,
            'submitted_at': format_utc(run.submitted_at),
        }) for run in items]
        return jsonify(make_paginated_response(serialized, next_cursor))

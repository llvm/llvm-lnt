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

from ..auth import require_scope
from ..errors import abort_with_error, reject_unknown_params
from ..etag import add_etag_to_response
from ..helpers import escape_like, lookup_machine, parse_datetime, serialize_run
from ..pagination import (
    cursor_paginate,
    make_paginated_response,
)
from ..schemas.machines import (
    MachineCreateSchema,
    MachineListQuerySchema,
    MachineResponseSchema,
    MachineRunsQuerySchema,
    MachineUpdateSchema,
    PaginatedMachineResponseSchema,
    PaginatedMachineRunResponseSchema,
)

blp = Blueprint(
    'Machines',
    __name__,
    url_prefix='/api/v5/<testsuite>',
    description='List, create, update, and delete machines, and list their runs',
)


def _serialize_machine(machine):
    """Serialize a Machine model instance for the API response."""
    info = {}
    # Add declared machine fields
    for field in machine.fields:
        val = machine.get_field(field)
        if val is not None:
            info[field.name] = str(val)
    # Add parameters blob
    try:
        params = machine.parameters
        for k, v in params.items():
            info[k] = str(v)
    except (TypeError, ValueError):
        pass
    return {
        'name': machine.name,
        'info': info,
    }


@blp.route('/machines')
class MachineList(MethodView):
    """List and create machines."""

    @require_scope('read')
    @blp.arguments(MachineListQuerySchema, location="query")
    @blp.response(200, PaginatedMachineResponseSchema)
    def get(self, query_args, testsuite):
        """List machines (offset-paginated, filterable)."""
        reject_unknown_params({'name_contains', 'name_prefix', 'limit', 'offset'})
        ts = g.ts
        session = g.db_session

        query = session.query(ts.Machine)

        # Apply filters
        name_contains = query_args.get('name_contains')
        if name_contains:
            escaped = escape_like(name_contains)
            query = query.filter(
                ts.Machine.name.like('%' + escaped + '%', escape='\\'))

        name_prefix = query_args.get('name_prefix')
        if name_prefix:
            escaped = escape_like(name_prefix)
            query = query.filter(
                ts.Machine.name.like(escaped + '%', escape='\\'))

        query = query.order_by(ts.Machine.name.asc())

        # Offset pagination for machines (bounded list)
        total = query.count()

        limit = query_args['limit']
        limit = max(1, min(limit, 500))

        offset = query_args['offset']
        offset = max(0, offset)

        machines = query.offset(offset).limit(limit).all()

        items = [_serialize_machine(m) for m in machines]
        return jsonify(make_paginated_response(items, None, total=total))

    @require_scope('manage')
    @blp.arguments(MachineCreateSchema)
    @blp.response(201, MachineResponseSchema)
    def post(self, body, testsuite):
        """Create a new machine."""
        ts = g.ts
        session = g.db_session

        name = body['name'].strip()

        # Check for existing machine with same name
        existing = session.query(ts.Machine).filter(
            ts.Machine.name == name
        ).first()
        if existing:
            abort_with_error(
                409, "A machine named '%s' already exists" % name)

        machine = ts.Machine(name)
        info = body.get('info') or {}
        if info and isinstance(info, dict):
            # Set declared fields and parameters
            declared = {f.name for f in ts.machine_fields}
            params = {}
            for key, value in info.items():
                if key in declared:
                    setattr(machine, key, value)
                else:
                    params[key] = value
            machine.parameters = params
        else:
            machine.parameters = {}

        session.add(machine)
        session.flush()

        resp = jsonify(_serialize_machine(machine))
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
        data = _serialize_machine(machine)
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
                # Check uniqueness of new name
                existing = session.query(ts.Machine).filter(
                    ts.Machine.name == new_name
                ).first()
                if existing:
                    abort_with_error(
                        409,
                        "A machine named '%s' already exists" % new_name)
                machine.name = new_name
                renamed = True

        new_info = body.get('info')
        if new_info is not None and isinstance(new_info, dict):
            declared = {f.name for f in ts.machine_fields}
            params = {}
            for key, value in new_info.items():
                if key in declared:
                    setattr(machine, key, value)
                else:
                    params[key] = value
            machine.parameters = params

        session.flush()

        result = _serialize_machine(machine)
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

        # Step 1: Clean up FK references to this machine's FieldChanges.
        # Both ChangeIgnore and RegressionIndicator have FKs to FieldChange
        # but may not cascade properly on all backends (especially Postgres),
        # so we must delete these manually before the machine cascade deletes
        # FieldChanges.
        field_change_ids = session.query(ts.FieldChange.id).filter(
            ts.FieldChange.machine_id == machine.id
        ).all()
        fc_ids = [fc_id for (fc_id,) in field_change_ids]

        if fc_ids:
            # Delete in batches to avoid large IN clauses
            batch_size = 100
            for i in range(0, len(fc_ids), batch_size):
                batch = fc_ids[i:i + batch_size]
                session.query(ts.RegressionIndicator).filter(
                    ts.RegressionIndicator.field_change_id.in_(batch)
                ).delete(synchronize_session='fetch')
                session.query(ts.ChangeIgnore).filter(
                    ts.ChangeIgnore.field_change_id.in_(batch)
                ).delete(synchronize_session='fetch')
            session.flush()

        # Step 2: Delete runs in chunks (each run cascades to its samples,
        # field changes, etc.)
        batch_size = 50
        while True:
            runs = session.query(ts.Run).filter(
                ts.Run.machine_id == machine.id
            ).limit(batch_size).all()
            if not runs:
                break
            for run in runs:
                session.delete(run)
            session.flush()

        # Step 3: Delete the machine itself
        session.delete(machine)
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

        # Apply datetime filters
        after_str = query_args.get('after')
        if after_str:
            after_dt = parse_datetime(after_str)
            if after_dt is None:
                abort_with_error(400, "Invalid 'after' datetime format")
            query = query.filter(ts.Run.start_time > after_dt)

        before_str = query_args.get('before')
        if before_str:
            before_dt = parse_datetime(before_str)
            if before_dt is None:
                abort_with_error(400, "Invalid 'before' datetime format")
            query = query.filter(ts.Run.start_time < before_dt)

        # Sort: default is ascending by ID (insertion order).
        # If sort=-start_time, order descending by ID (most recent first).
        sort = query_args.get('sort')
        descending = (sort == '-start_time')

        cursor_str = query_args.get('cursor')
        limit = query_args['limit']
        items, next_cursor = cursor_paginate(
            query, ts.Run.id, cursor_str, limit, descending=descending)

        serialized = [serialize_run(run, ts) for run in items]
        return jsonify(make_paginated_response(serialized, next_cursor))

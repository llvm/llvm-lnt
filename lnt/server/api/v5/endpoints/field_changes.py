"""Field change endpoints for the v5 API.

GET    /api/v5/{ts}/field-changes               -- List unassigned
POST   /api/v5/{ts}/field-changes               -- Create a field change
POST   /api/v5/{ts}/field-changes/{uuid}/ignore  -- Ignore a field change
DELETE /api/v5/{ts}/field-changes/{uuid}/ignore  -- Un-ignore a field change
"""

import uuid as uuid_module

from flask import g, jsonify, make_response
from flask.views import MethodView
from flask_smorest import Blueprint

from ..auth import require_scope
from ..errors import abort_with_error, reject_unknown_params
from ..helpers import (
    lookup_fieldchange,
    lookup_machine,
    resolve_metric,
    serialize_fieldchange,
)
from ..pagination import (
    cursor_paginate,
    make_paginated_response,
)
from ..schemas.common import FieldChangeIgnoreResponseSchema
from ..schemas.regressions import (
    FieldChangeCreateSchema,
    FieldChangeListQuerySchema,
    FieldChangeResponseSchema,
    PaginatedFieldChangeResponseSchema,
)

blp = Blueprint(
    'Field Changes',
    __name__,
    url_prefix='/api/v5/<testsuite>',
    description='List, create, and triage significant metric changes between orders',
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _serialize_fieldchange(fc):
    """Serialize a FieldChange for the API response."""
    result = serialize_fieldchange(fc)
    result['uuid'] = fc.uuid
    return result


# ---------------------------------------------------------------------------
# Field Changes List (unassigned)
# ---------------------------------------------------------------------------

@blp.route('/field-changes')
class FieldChangeList(MethodView):
    """List and create field changes."""

    @require_scope('read')
    @blp.arguments(FieldChangeListQuerySchema, location="query")
    @blp.response(200, PaginatedFieldChangeResponseSchema)
    def get(self, query_args, testsuite):
        """List unassigned field changes (cursor-paginated, filterable).

        Returns field changes that have not been assigned to a regression
        and have not been ignored.
        """
        reject_unknown_params({'machine', 'test', 'metric', 'cursor', 'limit'})
        ts = g.ts
        session = g.db_session

        # Build query: unassigned field changes
        # LEFT JOIN ChangeIgnore, filter IS NULL
        # LEFT JOIN RegressionIndicator, filter IS NULL
        query = session.query(ts.FieldChange) \
            .outerjoin(ts.ChangeIgnore) \
            .filter(ts.ChangeIgnore.id.is_(None)) \
            .outerjoin(ts.RegressionIndicator) \
            .filter(ts.RegressionIndicator.id.is_(None))

        # Filter by machine name
        machine_name = query_args.get('machine')
        if machine_name:
            query = query.join(
                ts.Machine,
                ts.FieldChange.machine_id == ts.Machine.id
            ).filter(ts.Machine.name == machine_name)

        # Filter by test name
        test_name = query_args.get('test')
        if test_name:
            query = query.join(
                ts.Test,
                ts.FieldChange.test_id == ts.Test.id
            ).filter(ts.Test.name == test_name)

        # Filter by metric name
        field_name = query_args.get('metric')
        if field_name:
            matching_field = resolve_metric(ts, field_name)
            query = query.filter(
                ts.FieldChange.field_id == matching_field.id)

        # Order by descending ID (most recent first) via cursor_paginate.
        cursor_str = query_args.get('cursor')
        limit = query_args['limit']
        items, next_cursor = cursor_paginate(
            query, ts.FieldChange.id, cursor_str, limit, descending=True)

        serialized = [_serialize_fieldchange(fc) for fc in items]
        return jsonify(make_paginated_response(serialized, next_cursor))

    @require_scope('submit')
    @blp.arguments(FieldChangeCreateSchema)
    @blp.response(201, FieldChangeResponseSchema)
    def post(self, body, testsuite):
        """Create a field change.

        References machine, test, metric, and orders by name.
        """
        ts = g.ts
        session = g.db_session

        # Resolve machine
        machine = lookup_machine(session, ts, body['machine'])

        # Resolve test
        test = session.query(ts.Test).filter(
            ts.Test.name == body['test']
        ).first()
        if test is None:
            abort_with_error(
                404,
                "Test '%s' not found" % body['test'])

        # Resolve field
        matching_field = resolve_metric(ts, body['metric'])

        # Resolve start_order and end_order via primary order field
        primary_field = ts.order_fields[0]

        start_order = session.query(ts.Order).filter(
            primary_field.column == body['start_order']
        ).first()
        if start_order is None:
            abort_with_error(
                404,
                "Start order '%s' not found" % body['start_order'])

        end_order = session.query(ts.Order).filter(
            primary_field.column == body['end_order']
        ).first()
        if end_order is None:
            abort_with_error(
                404,
                "End order '%s' not found" % body['end_order'])

        # Resolve optional run_uuid
        run = None
        if body.get('run_uuid'):
            run = session.query(ts.Run).filter(
                ts.Run.uuid == body['run_uuid']
            ).first()
            if run is None:
                abort_with_error(
                    404,
                    "Run '%s' not found" % body['run_uuid'])

        # Create FieldChange
        fc = ts.FieldChange(
            start_order=start_order,
            end_order=end_order,
            machine=machine,
            test=test,
            field_id=matching_field.id,
        )
        fc.uuid = str(uuid_module.uuid4())
        fc.old_value = body['old_value']
        fc.new_value = body['new_value']
        if run is not None:
            fc.run = run
        session.add(fc)
        session.flush()

        data = _serialize_fieldchange(fc)
        resp = jsonify(data)
        resp.status_code = 201
        return resp


# ---------------------------------------------------------------------------
# Ignore / Un-ignore
# ---------------------------------------------------------------------------

@blp.route('/field-changes/<string:fc_uuid>/ignore')
class FieldChangeIgnore(MethodView):
    """Ignore and un-ignore a field change."""

    @require_scope('triage')
    @blp.response(201, FieldChangeIgnoreResponseSchema)
    def post(self, testsuite, fc_uuid):
        """Ignore a field change. Returns 409 if already ignored."""
        ts = g.ts
        session = g.db_session
        fc = lookup_fieldchange(session, ts, fc_uuid)

        # Check if already ignored
        existing = session.query(ts.ChangeIgnore).filter(
            ts.ChangeIgnore.field_change_id == fc.id
        ).first()
        if existing:
            abort_with_error(
                409, "Field change '%s' is already ignored" % fc_uuid)

        ignore = ts.ChangeIgnore(fc)
        session.add(ignore)
        session.flush()

        resp = jsonify({'status': 'ignored', 'field_change_uuid': fc.uuid})
        resp.status_code = 201
        return resp

    @require_scope('triage')
    @blp.response(204)
    def delete(self, testsuite, fc_uuid):
        """Un-ignore a field change. Returns 404 if not currently ignored."""
        ts = g.ts
        session = g.db_session
        fc = lookup_fieldchange(session, ts, fc_uuid)

        # Find the ChangeIgnore row
        ignore = session.query(ts.ChangeIgnore).filter(
            ts.ChangeIgnore.field_change_id == fc.id
        ).first()
        if ignore is None:
            abort_with_error(
                404, "Field change '%s' is not ignored" % fc_uuid)

        session.delete(ignore)
        session.flush()

        return make_response('', 204)

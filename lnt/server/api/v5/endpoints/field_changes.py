"""Field change endpoints for the v5 API.

GET    /api/v5/{ts}/field-changes               -- List unassigned
POST   /api/v5/{ts}/field-changes               -- Create a field change
"""

from flask import g, jsonify
from flask.views import MethodView
from flask_smorest import Blueprint
from sqlalchemy.orm import joinedload

from ..auth import require_scope
from ..errors import reject_unknown_params
from ..helpers import (
    lookup_commit,
    lookup_machine,
    lookup_test,
    serialize_fieldchange,
    validate_metric_name,
)
from ..pagination import (
    cursor_paginate,
    make_paginated_response,
)
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
    description='List and create significant metric changes between commits',
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

        Returns field changes that have not been assigned to a regression.
        """
        reject_unknown_params({'machine', 'test', 'metric', 'cursor', 'limit'})
        ts = g.ts
        session = g.db_session

        # Unassigned = not linked to any regression via RegressionIndicator.
        query = (
            session.query(ts.FieldChange)
            .options(
                joinedload(ts.FieldChange.test),
                joinedload(ts.FieldChange.machine),
                joinedload(ts.FieldChange.start_commit),
                joinedload(ts.FieldChange.end_commit),
            )
            .outerjoin(ts.RegressionIndicator)
            .filter(ts.RegressionIndicator.id.is_(None))
        )

        machine_name = query_args.get('machine')
        if machine_name:
            machine = lookup_machine(session, ts, machine_name)
            query = query.filter(
                ts.FieldChange.machine_id == machine.id)

        test_name = query_args.get('test')
        if test_name:
            test = lookup_test(session, ts, test_name)
            query = query.filter(
                ts.FieldChange.test_id == test.id)

        field_name = query_args.get('metric')
        if field_name:
            validate_metric_name(ts, field_name)
            query = query.filter(
                ts.FieldChange.field_name == field_name)

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

        References machine, test, metric, and commits by name.
        """
        ts = g.ts
        session = g.db_session

        machine = lookup_machine(session, ts, body['machine'])
        test = lookup_test(session, ts, body['test'])
        validate_metric_name(ts, body['metric'])

        start_commit = lookup_commit(session, ts, body['start_commit'])
        end_commit = lookup_commit(session, ts, body['end_commit'])

        fc = ts.create_field_change(
            session, machine, test, body['metric'],
            start_commit, end_commit,
            body['old_value'], body['new_value'])

        data = _serialize_fieldchange(fc)
        resp = jsonify(data)
        resp.status_code = 201
        return resp

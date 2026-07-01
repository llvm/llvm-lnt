"""Test entity endpoints for the v5 API.

GET /api/v5/{ts}/tests              -- List tests (cursor-paginated, filterable)
"""

from flask import g, jsonify
from flask.views import MethodView
from flask_smorest import Blueprint

from ..auth import require_scope
from ..errors import reject_unknown_params
from ..helpers import (
    dump_response, escape_like, lookup_machine,
    validate_metric_name,
)
from ..pagination import (
    cursor_paginate,
    make_paginated_response,
)
from ..schemas.tests import (
    PaginatedTestResponseSchema,
    TestListQuerySchema,
    TestResponseSchema,
)

_test_schema = TestResponseSchema()

blp = Blueprint(
    'Tests',
    __name__,
    url_prefix='/api/v5/<testsuite>',
    description='List and inspect test definitions',
)


def _serialize_test(test):
    """Serialize a Test model instance for the API response."""
    return dump_response(_test_schema, {'name': test.name})


@blp.route('/tests')
class TestList(MethodView):
    """List tests."""

    @require_scope('read')
    @blp.arguments(TestListQuerySchema, location="query")
    @blp.response(200, PaginatedTestResponseSchema)
    def get(self, query_args, testsuite):
        """List tests (cursor-paginated, filterable)."""
        reject_unknown_params({
            'search', 'machine', 'metric',
            'cursor', 'limit',
        })
        ts = g.ts
        session = g.db_session

        query = session.query(ts.Test)

        # Machine / metric filters require joining through Sample
        # (and additionally through Run when machine= is specified).
        machine_name = query_args.get('machine')
        metric_name = query_args.get('metric')
        if machine_name or metric_name:
            query = query.join(ts.Sample, ts.Sample.test_id == ts.Test.id)
        if machine_name:
            machine = lookup_machine(session, ts, machine_name)
            query = query.join(ts.Run).filter(
                ts.Run.machine_id == machine.id)
        if metric_name:
            validate_metric_name(ts, metric_name)
            metric_col = getattr(ts.Sample, metric_name)
            query = query.filter(metric_col.isnot(None))
        if machine_name or metric_name:
            query = query.distinct()

        search = query_args.get('search')
        if search:
            escaped = escape_like(search)
            query = query.filter(
                ts.Test.name.ilike('%' + escaped + '%', escape='\\'))

        cursor_str = query_args.get('cursor')
        limit = query_args['limit']
        items, next_cursor = cursor_paginate(
            query, ts.Test.id, cursor_str, limit)

        serialized = [_serialize_test(t) for t in items]
        return jsonify(make_paginated_response(serialized, next_cursor))

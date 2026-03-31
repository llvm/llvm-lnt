"""Test entity endpoints for the v5 API.

GET /api/v5/{ts}/tests              -- List tests (cursor-paginated, filterable)
GET /api/v5/{ts}/tests/{test_name}  -- Test detail
"""

from flask import g, jsonify
from flask.views import MethodView
from flask_smorest import Blueprint

from ..auth import require_scope
from ..errors import reject_unknown_params
from ..etag import add_etag_to_response
from ..helpers import escape_like, lookup_test
from ..pagination import (
    cursor_paginate,
    make_paginated_response,
)
from ..schemas.tests import (
    PaginatedTestResponseSchema,
    TestListQuerySchema,
    TestResponseSchema,
)

blp = Blueprint(
    'Tests',
    __name__,
    url_prefix='/api/v5/<testsuite>',
    description='List and inspect test definitions',
)


def _serialize_test(test):
    """Serialize a Test model instance for the API response."""
    return {'name': test.name}


@blp.route('/tests')
class TestList(MethodView):
    """List tests."""

    @require_scope('read')
    @blp.arguments(TestListQuerySchema, location="query")
    @blp.response(200, PaginatedTestResponseSchema)
    def get(self, query_args, testsuite):
        """List tests (cursor-paginated, filterable)."""
        reject_unknown_params({'name_contains', 'name_prefix', 'cursor', 'limit'})
        ts = g.ts
        session = g.db_session

        query = session.query(ts.Test)

        # Apply filters
        name_contains = query_args.get('name_contains')
        if name_contains:
            escaped = escape_like(name_contains)
            query = query.filter(
                ts.Test.name.like('%' + escaped + '%', escape='\\'))

        name_prefix = query_args.get('name_prefix')
        if name_prefix:
            escaped = escape_like(name_prefix)
            query = query.filter(
                ts.Test.name.like(escaped + '%', escape='\\'))

        cursor_str = query_args.get('cursor')
        limit = query_args['limit']
        items, next_cursor = cursor_paginate(
            query, ts.Test.id, cursor_str, limit)

        serialized = [_serialize_test(t) for t in items]
        return jsonify(make_paginated_response(serialized, next_cursor))


@blp.route('/tests/<path:test_name>')
class TestDetail(MethodView):
    """Test detail."""

    @require_scope('read')
    @blp.response(200, TestResponseSchema)
    def get(self, testsuite, test_name):
        """Get test detail by name. Test names may contain slashes."""
        reject_unknown_params(set())
        ts = g.ts
        session = g.db_session

        test = lookup_test(session, ts, test_name)

        data = _serialize_test(test)
        return add_etag_to_response(jsonify(data), data)

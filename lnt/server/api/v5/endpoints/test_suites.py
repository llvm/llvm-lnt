"""Test suite management endpoints for the v5 API.

GET    /api/v5/test-suites              -- List all test suites
POST   /api/v5/test-suites              -- Create a test suite
GET    /api/v5/test-suites/<suite_name> -- Get suite details
DELETE /api/v5/test-suites/<suite_name> -- Delete a test suite
"""

from flask import after_this_request, g
from flask.views import MethodView
from flask_smorest import Blueprint

from lnt.server.db.v5 import V5DB
from lnt.server.db.v5.schema import SchemaError, parse_schema

from ..auth import require_scope
from ..errors import abort_with_error, reject_unknown_params
from ..schemas.test_suites import (
    TestSuiteCreateQuerySchema,
    TestSuiteCreateRequestSchema,
    TestSuiteDeleteQuerySchema,
    TestSuiteDetailQuerySchema,
    TestSuiteDetailResponseSchema,
    TestSuiteListQuerySchema,
    TestSuiteListResponseSchema,
)

blp = Blueprint(
    'Test Suites',
    __name__,
    url_prefix='/api/v5/test-suites',
    description='List, create, and delete test suites and their field definitions',
)


def _suite_links(name):
    """Build the standard per-suite links dict."""
    prefix = '/api/v5/%s' % name
    return {
        'machines': prefix + '/machines',
        'commits': prefix + '/commits',
        'runs': prefix + '/runs',
        'tests': prefix + '/tests',
        'regressions': prefix + '/regressions',
        'query': prefix + '/query',
    }


def _suite_detail(db, name):
    """Build a detail dict for a suite."""
    tsdb = db.testsuite[name]
    return {
        'name': name,
        'schema': V5DB._schema_to_dict(tsdb.schema),
        'links': _suite_links(name),
    }


@blp.route('/')
class TestSuiteCollection(MethodView):
    """List and create test suites."""

    @blp.arguments(TestSuiteListQuerySchema, location='query')
    @blp.response(200, TestSuiteListResponseSchema)
    def get(self, query_args):
        """List all test suites."""
        reject_unknown_params(set())
        db = getattr(g, 'db', None)
        if db is None:
            return {'items': []}

        items = []
        for name in sorted(db.testsuite.keys()):
            items.append(_suite_detail(db, name))
        return {'items': items}

    @require_scope('manage')
    @blp.arguments(TestSuiteCreateQuerySchema, location='query')
    @blp.arguments(TestSuiteCreateRequestSchema)
    @blp.response(201, TestSuiteDetailResponseSchema)
    def post(self, query_args, payload):
        """Create a new test suite."""
        reject_unknown_params(set())
        db = g.db
        session = g.db_session
        name = payload['name']

        # Check the in-memory cache first.
        if name in db.testsuite:
            abort_with_error(409, "Test suite '%s' already exists" % name)

        # Parse the payload into a v5 TestSuiteSchema.
        try:
            schema = parse_schema(payload)
        except SchemaError as exc:
            abort_with_error(400, str(exc))

        # Create the suite (tables, schema row, version bump).
        try:
            db.create_suite(session, schema)
            session.commit()
        except ValueError as exc:
            session.rollback()
            abort_with_error(409, str(exc))
        except Exception as exc:
            session.rollback()
            abort_with_error(400,
                             "Failed to create test suite '%s': %s"
                             % (name, exc))

        @after_this_request
        def add_location_header(response):
            response.headers['Location'] = '/api/v5/test-suites/%s' % name
            return response

        return _suite_detail(db, name)


@blp.route('/<suite_name>')
class TestSuiteDetail(MethodView):
    """Get or delete a test suite."""

    @blp.arguments(TestSuiteDetailQuerySchema, location='query')
    @blp.response(200, TestSuiteDetailResponseSchema)
    def get(self, query_args, suite_name):
        """Get a test suite's field definitions and resource links."""
        reject_unknown_params(set())
        db = getattr(g, 'db', None)
        if db is None or suite_name not in db.testsuite:
            abort_with_error(404, "Test suite '%s' not found" % suite_name)
        return _suite_detail(db, suite_name)

    @require_scope('manage')
    @blp.arguments(TestSuiteDeleteQuerySchema, location='query')
    def delete(self, query_args, suite_name):
        """Delete a test suite and all its data (irreversible).

        Requires ?confirm=true to proceed.
        """
        reject_unknown_params({'confirm'})

        confirm = query_args.get('confirm')
        if confirm != 'true':
            abort_with_error(
                400,
                "Deleting a test suite drops all its tables and data. "
                "Pass ?confirm=true to proceed.")

        db = g.db
        session = g.db_session

        if suite_name not in db.testsuite:
            abort_with_error(404, "Test suite '%s' not found" % suite_name)

        try:
            db.delete_suite(session, suite_name)
            session.commit()
        except Exception as exc:
            session.rollback()
            abort_with_error(
                500,
                "Failed to delete test suite '%s': %s" % (suite_name, exc))

        return '', 204

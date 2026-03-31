"""Test suite management endpoints for the v5 API.

GET    /api/v5/test-suites              -- List all test suites
POST   /api/v5/test-suites              -- Create a test suite
GET    /api/v5/test-suites/<suite_name> -- Get suite details
DELETE /api/v5/test-suites/<suite_name> -- Delete a test suite
"""

from flask import after_this_request, g
from flask.views import MethodView
from flask_smorest import Blueprint

from lnt.server.db import testsuite
import lnt.server.db.testsuitedb

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
        'orders': prefix + '/orders',
        'runs': prefix + '/runs',
        'tests': prefix + '/tests',
        'regressions': prefix + '/regressions',
        'field_changes': prefix + '/field-changes',
        'query': prefix + '/query',
    }


def _suite_detail(db, name):
    """Build a detail dict for a suite."""
    tsdb = db.testsuite[name]
    return {
        'name': name,
        'schema': tsdb.test_suite.__json__(),
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

        # Check the in-memory cache first
        if name in db.testsuite:
            abort_with_error(409, "Test suite '%s' already exists" % name)

        # Also check the DB metatable to guard against races
        existing = session.query(testsuite.TestSuite).filter(
            testsuite.TestSuite.name == name
        ).first()
        if existing is not None:
            abort_with_error(409, "Test suite '%s' already exists" % name)

        # Build the TestSuite object from the payload
        try:
            suite = testsuite.TestSuite.from_json(payload)
        except (ValueError, AssertionError, KeyError) as exc:
            abort_with_error(400, str(exc))

        # All creation steps are wrapped so that if any step fails,
        # metadata is rolled back and any created tables are dropped.
        # This avoids the bug where an early commit persists metadata
        # rows but a later failure (e.g. in create_tables) leaves the
        # database in an inconsistent state with no corresponding tables.
        tsdb = None
        try:
            # Stage metadata rows without committing.  For a brand-new
            # suite we add the JSON schema row directly instead of calling
            # check_testsuite_schema_changes (which commits internally).
            schema = testsuite.TestSuiteJSONSchema(name, suite.jsonschema)
            session.add(schema)
            suite = testsuite.sync_testsuite_with_metatables(session, suite)
            session.flush()

            # Create physical per-suite tables (DDL).  We pass the
            # session's connection instead of the engine so that the
            # CREATE TABLE statements execute within the same transaction
            # (and on the same DB connection) as the flushed metadata
            # inserts.  Using a separate connection would deadlock on
            # PostgreSQL because FieldChange has a FK to SampleField:
            # connection A holds ROW EXCLUSIVE on TestSuiteSampleFields
            # from the flush, while connection B's CREATE TABLE needs
            # SHARE ROW EXCLUSIVE on that same table.
            tsdb = lnt.server.db.testsuitedb.TestSuiteDB(db, name, suite)
            tsdb.create_tables(session.connection())

            # Bump registry version so other workers pick up the change.
            db.increment_registry_version(session)
            session.commit()
        except Exception as exc:
            session.rollback()
            # Best-effort cleanup: drop tables that may have been created
            # before the failure.
            if tsdb is not None:
                try:
                    tsdb.base.metadata.drop_all(db.engine)
                except Exception:
                    pass
            abort_with_error(400,
                             "Failed to create test suite '%s': %s"
                             % (name, exc))

        db.testsuite[name] = tsdb
        db.testsuite = dict(sorted(db.testsuite.items()))

        @after_this_request
        def add_location_header(response):
            response.headers['Location'] = '/api/v5/test-suites/%s' % name
            return response

        return {
            'name': name,
            'schema': suite.__json__(),
            'links': _suite_links(name),
        }


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

        tsdb = db.testsuite[suite_name]

        # Deletion order is chosen for safety: metadata first, then tables,
        # then in-memory dict.  If metadata deletion fails, no tables are
        # dropped and we can roll back cleanly.  If table dropping fails
        # *after* metadata is committed, we end up with orphaned tables
        # (harmless) rather than metadata pointing at missing tables.

        # 1. Delete metadata rows and commit
        try:
            ts_row = session.query(testsuite.TestSuite).filter(
                testsuite.TestSuite.name == suite_name
            ).first()
            if ts_row is not None:
                ts_id = ts_row.id
                # Null out self-referential FK before deleting SampleFields
                session.query(testsuite.SampleField).filter(
                    testsuite.SampleField.test_suite_id == ts_id
                ).update({testsuite.SampleField.status_field_id: None},
                         synchronize_session='fetch')
                session.flush()

                # Delete field rows
                for model in (testsuite.SampleField, testsuite.MachineField,
                              testsuite.OrderField, testsuite.RunField):
                    session.query(model).filter(
                        model.test_suite_id == ts_id
                    ).delete(synchronize_session='fetch')

                # Delete JSON schema row
                session.query(testsuite.TestSuiteJSONSchema).filter(
                    testsuite.TestSuiteJSONSchema.testsuite_name == suite_name
                ).delete(synchronize_session='fetch')

                # Delete the TestSuite row itself
                session.delete(ts_row)

            db.increment_registry_version(session)
            session.commit()
        except Exception as exc:
            session.rollback()
            abort_with_error(
                500,
                "Failed to delete metadata for '%s': %s" % (suite_name, exc))

        # 2. Drop per-suite tables (best-effort after metadata is gone)
        try:
            tsdb.base.metadata.drop_all(db.engine)
        except Exception:
            # Tables are orphaned but metadata is already gone — harmless.
            # A future CREATE of the same suite will recreate them.
            pass

        # 3. Remove from in-memory dict
        del db.testsuite[suite_name]

        return '', 204

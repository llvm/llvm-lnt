"""v5 API middleware: testsuite resolution, DB session lifecycle, CORS,
and access logging."""

import datetime
import logging
import sys

from flask import current_app, g, request

from lnt.server.db.v5 import V5DB
from lnt.server.api.v5.errors import _make_error_response

access_logger = logging.getLogger('lnt.server.api.v5.access')


def register_middleware(app):
    """Register before_request and after_request hooks for /api/v5/ paths."""

    # Configure access logger (once, even if called multiple times in tests).
    if not access_logger.handlers:
        handler = logging.StreamHandler(sys.stderr)
        handler.setLevel(logging.INFO)
        handler.setFormatter(logging.Formatter('%(message)s'))
        access_logger.addHandler(handler)
        access_logger.setLevel(logging.INFO)
    access_logger.propagate = False

    @app.before_request
    def v5_before_request():
        """Open a DB session for v5 API requests and resolve the testsuite."""
        if not request.path.startswith('/api/v5/'):
            return

        # Skip DB setup for OpenAPI spec paths
        if request.path.startswith('/api/v5/openapi'):
            return

        # Always open a DB session for v5 paths (needed for auth, discovery, etc.)
        db = current_app.instance.get_database("default")
        if db is None:
            return _make_error_response(
                'configuration_error',
                "No default database configured.",
                500,
            )
        if not isinstance(db, V5DB):
            return _make_error_response(
                'configuration_error',
                "The v5 API requires a v5 database "
                "(set db_version to '5.0' in lnt.cfg).",
                500,
            )
        g.db = db
        g.db_name = "default"
        g.db_session = db.make_session()

        # Resolve testsuite from view_args if the URL contains one.
        # Discovery (/api/v5/) and admin (/api/v5/admin/) paths have no
        # testsuite in the URL.  get_suite() handles schema version
        # staleness checks transparently.
        view_args = request.view_args or {}
        testsuite = view_args.get('testsuite')
        if testsuite:
            ts = db.get_suite(testsuite, g.db_session)
            if ts is None:
                return _make_error_response(
                    'not_found',
                    "Test suite '%s' not found" % testsuite,
                    404,
                )
            g.ts = ts

    @app.teardown_request
    def v5_teardown_request(exc):
        """Close the DB session after the request."""
        session = g.pop('db_session', None)
        if session is not None:
            try:
                if exc is not None:
                    session.rollback()
                else:
                    session.commit()
            except Exception:
                session.rollback()
            finally:
                session.close()

    @app.after_request
    def v5_cors_headers(response):
        """Add CORS headers to v5 API responses."""
        if not request.path.startswith('/api/v5/'):
            return response

        response.headers['Access-Control-Allow-Origin'] = '*'
        response.headers['Access-Control-Allow-Methods'] = \
            'GET, POST, PATCH, DELETE, OPTIONS'
        response.headers['Access-Control-Allow-Headers'] = \
            'Authorization, Content-Type, If-None-Match'
        response.headers['Access-Control-Expose-Headers'] = 'ETag, Location'
        response.headers['Access-Control-Max-Age'] = '86400'

        return response

    @app.after_request
    def v5_access_log(response):
        """Emit an Apache combined-format access log line for v5 requests."""
        if not request.path.startswith('/api/v5/'):
            return response

        # Determine authenticated user from cached auth context.
        scope, api_key = getattr(g, '_v5_auth', (None, None))
        if api_key is not None:
            user = api_key.name
        elif scope is not None:
            user = 'bootstrap'
        else:
            user = '-'

        now = datetime.datetime.utcnow()
        timestamp = now.strftime('%d/%b/%Y:%H:%M:%S +0000')

        content_length = response.content_length
        size = str(content_length) if content_length is not None else '-'

        referer = request.headers.get('Referer', '-')
        user_agent = request.headers.get('User-Agent', '-')

        path = request.full_path
        if path.endswith('?'):
            path = path[:-1]

        line = '%s - %s [%s] "%s %s %s" %d %s "%s" "%s"' % (
            request.remote_addr or '-',
            user,
            timestamp,
            request.method,
            path,
            request.environ.get('SERVER_PROTOCOL', 'HTTP/1.1'),
            response.status_code,
            size,
            referer,
            user_agent,
        )
        access_logger.info(line)

        return response

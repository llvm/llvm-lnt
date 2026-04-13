# Tests for the v5 access log.
#
# RUN: rm -rf %t.instance %t.pg.log
# RUN: %{utils}/with_postgres.sh %t.pg.log \
# RUN:     %{utils}/with_temporary_instance.py %t.instance \
# RUN:         -- python %s %t.instance
# END.

import logging
import re
import sys
import os
import unittest
import uuid

sys.path.insert(0, os.path.dirname(__file__))
from v5_test_helpers import (
    create_app, create_client, admin_headers, make_scoped_headers,
)

TS = 'nts'
PREFIX = f'/api/v5/{TS}'

# Apache combined log format regex.
# Fields: ip - user [timestamp] "method path protocol" status size "referer" "ua"
COMBINED_RE = re.compile(
    r'^(?P<ip>\S+) - (?P<user>\S+) '
    r'\[(?P<timestamp>[^\]]+)\] '
    r'"(?P<method>\S+) (?P<path>\S+) (?P<protocol>[^"]+)" '
    r'(?P<status>\d+) (?P<size>\S+) '
    r'"(?P<referer>[^"]*)" "(?P<ua>[^"]*)"$'
)


class _LogCapture(logging.Handler):
    """A logging handler that records log lines into a list."""

    def __init__(self):
        super().__init__()
        self.lines = []

    def emit(self, record):
        self.lines.append(self.format(record))

    def clear(self):
        self.lines.clear()


class _AccessLogTestCase(unittest.TestCase):
    """Base class for access log tests.

    Sets up a Flask app, test client, and log capture handler.
    Cleans up the handler on teardown to prevent handler accumulation
    on the singleton logger.
    """

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.app = create_app(sys.argv[1])
        cls.client = create_client(cls.app)
        cls.capture = _LogCapture()
        cls.capture.setFormatter(logging.Formatter('%(message)s'))
        logger = logging.getLogger('lnt.server.api.v5.access')
        logger.addHandler(cls.capture)

    @classmethod
    def tearDownClass(cls):
        logger = logging.getLogger('lnt.server.api.v5.access')
        logger.removeHandler(cls.capture)
        super().tearDownClass()

    def setUp(self):
        self.capture.clear()


class TestAccessLogFormat(_AccessLogTestCase):
    """Verify the access log emits valid Apache combined format."""

    def test_log_line_matches_combined_format(self):
        self.client.get(PREFIX + '/orders')
        self.assertEqual(len(self.capture.lines), 1)
        m = COMBINED_RE.match(self.capture.lines[0])
        self.assertIsNotNone(m, f'Log line does not match combined format: '
                                f'{self.capture.lines[0]!r}')

    def test_method_and_path(self):
        self.client.get(PREFIX + '/orders')
        m = COMBINED_RE.match(self.capture.lines[0])
        self.assertEqual(m.group('method'), 'GET')
        self.assertIn('/api/v5/nts/orders', m.group('path'))

    def test_status_code_200(self):
        self.client.get(PREFIX + '/orders')
        m = COMBINED_RE.match(self.capture.lines[0])
        self.assertEqual(m.group('status'), '200')

    def test_post_status_code_201(self):
        rev = f'log-{uuid.uuid4().hex[:8]}'
        self.client.post(PREFIX + '/orders',
                         json={'llvm_project_revision': rev},
                         headers=admin_headers())
        m = COMBINED_RE.match(self.capture.lines[0])
        self.assertEqual(m.group('status'), '201')
        self.assertEqual(m.group('method'), 'POST')


class TestAccessLogUser(_AccessLogTestCase):
    """Verify the user field reflects authentication state."""

    def test_unauthenticated_request(self):
        self.client.get(PREFIX + '/orders')
        m = COMBINED_RE.match(self.capture.lines[0])
        self.assertEqual(m.group('user'), '-')

    def test_bootstrap_token(self):
        self.client.get(PREFIX + '/orders', headers=admin_headers())
        m = COMBINED_RE.match(self.capture.lines[0])
        self.assertEqual(m.group('user'), 'bootstrap')

    def test_named_api_key(self):
        headers = make_scoped_headers(self.app, 'read')
        self.capture.clear()  # discard log from API key creation
        self.client.get(PREFIX + '/orders', headers=headers)
        m = COMBINED_RE.match(self.capture.lines[0])
        self.assertEqual(m.group('user'), 'test-read')


class TestAccessLogMiddleware404(_AccessLogTestCase):
    """Verify logging for requests that fail at the middleware level."""

    def test_nonexistent_testsuite(self):
        resp = self.client.get('/api/v5/nonexistent/orders')
        self.assertEqual(resp.status_code, 404)
        self.assertEqual(len(self.capture.lines), 1)
        m = COMBINED_RE.match(self.capture.lines[0])
        self.assertEqual(m.group('status'), '404')
        self.assertEqual(m.group('user'), '-')


class TestAccessLogHeaders(_AccessLogTestCase):
    """Verify Referer and User-Agent appear in the log."""

    def test_referer_present(self):
        self.client.get(PREFIX + '/orders',
                        headers={'Referer': 'http://example.com/page'})
        m = COMBINED_RE.match(self.capture.lines[0])
        self.assertEqual(m.group('referer'), 'http://example.com/page')

    def test_referer_absent(self):
        self.client.get(PREFIX + '/orders')
        m = COMBINED_RE.match(self.capture.lines[0])
        self.assertEqual(m.group('referer'), '-')

    def test_user_agent_present(self):
        self.client.get(PREFIX + '/orders',
                        headers={'User-Agent': 'TestBot/1.0'})
        m = COMBINED_RE.match(self.capture.lines[0])
        self.assertEqual(m.group('ua'), 'TestBot/1.0')

    def test_user_agent_absent(self):
        # Werkzeug test client sends a default User-Agent; override to empty.
        self.client.get(PREFIX + '/orders',
                        headers={'User-Agent': ''})
        m = COMBINED_RE.match(self.capture.lines[0])
        # Empty string or '-' are both acceptable for absent user agent.
        self.assertIn(m.group('ua'), ('', '-'))


class TestAccessLogContentLength(_AccessLogTestCase):
    """Verify the size field reflects response content length."""

    def test_response_with_body_has_size(self):
        self.client.get(PREFIX + '/orders')
        m = COMBINED_RE.match(self.capture.lines[0])
        size = m.group('size')
        # Should be a positive integer, not '-'
        self.assertNotEqual(size, '-')
        self.assertGreater(int(size), 0)


if __name__ == '__main__':
    unittest.main(argv=[sys.argv[0]])

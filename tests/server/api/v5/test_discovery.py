# Tests for the v5 discovery endpoint (GET /api/v5/).
#
# RUN: rm -rf %t.instance %t.pg.log
# RUN: %{utils}/with_postgres.sh %t.pg.log \
# RUN:     %{utils}/with_temporary_instance.py --db-version 5.0 %t.instance \
# RUN:         -- python %s %t.instance
# END.

import sys
import os
import unittest

sys.path.insert(0, os.path.dirname(__file__))
from v5_test_helpers import create_app, create_client


class TestDiscovery(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.app = create_app(sys.argv[1])
        cls.client = create_client(cls.app)

    def test_discovery_returns_200(self):
        resp = self.client.get('/api/v5/')
        self.assertEqual(resp.status_code, 200)

    def test_discovery_contains_test_suites(self):
        resp = self.client.get('/api/v5/')
        data = resp.get_json()
        self.assertIn('test_suites', data)
        self.assertIsInstance(data['test_suites'], list)
        self.assertGreater(len(data['test_suites']), 0)

    def test_discovery_suite_has_name_and_links(self):
        resp = self.client.get('/api/v5/')
        data = resp.get_json()
        suite = data['test_suites'][0]
        self.assertIn('name', suite)
        self.assertIn('links', suite)

    def test_discovery_suite_links_are_complete(self):
        resp = self.client.get('/api/v5/')
        data = resp.get_json()
        suite = data['test_suites'][0]
        links = suite['links']
        expected_keys = {
            'machines', 'commits', 'runs', 'tests',
            'regressions', 'field_changes', 'query'
        }
        self.assertEqual(set(links.keys()), expected_keys)

    def test_discovery_links_contain_suite_name(self):
        resp = self.client.get('/api/v5/')
        data = resp.get_json()
        for suite in data['test_suites']:
            name = suite['name']
            for key, url in suite['links'].items():
                self.assertIn(
                    name, url,
                    f"Link {key}={url} does not contain suite name {name}")

    def test_discovery_no_auth_required(self):
        """Discovery should work without any auth headers."""
        resp = self.client.get('/api/v5/')
        self.assertEqual(resp.status_code, 200)

    def test_discovery_has_nts_suite(self):
        """The 'nts' test suite should be present."""
        resp = self.client.get('/api/v5/')
        data = resp.get_json()
        names = [s['name'] for s in data['test_suites']]
        self.assertIn('nts', names)

    def test_discovery_cors_headers(self):
        """CORS headers should be present on v5 responses."""
        resp = self.client.get('/api/v5/')
        self.assertEqual(resp.headers.get('Access-Control-Allow-Origin'), '*')

    def test_discovery_includes_doc_links(self):
        """Discovery should include links to OpenAPI spec and Swagger UI."""
        resp = self.client.get('/api/v5/')
        data = resp.get_json()
        self.assertIn('links', data)
        self.assertIn('openapi', data['links'])
        self.assertIn('swagger_ui', data['links'])
        self.assertIn('test_suites', data['links'])

    def test_swagger_ui_returns_200(self):
        resp = self.client.get('/api/v5/openapi/swagger-ui')
        self.assertEqual(resp.status_code, 200)

    def test_openapi_json_returns_200(self):
        resp = self.client.get('/api/v5/openapi/openapi.json')
        self.assertEqual(resp.status_code, 200)


class TestDiscoveryUnknownParams(unittest.TestCase):
    """Test that unknown query parameters are rejected with 400."""
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.app = create_app(sys.argv[1])
        cls.client = create_client(cls.app)

    def test_discovery_unknown_param_returns_400(self):
        resp = self.client.get('/api/v5/?bogus=1')
        self.assertEqual(resp.status_code, 400)
        data = resp.get_json()
        self.assertIn('bogus', data['error']['message'])


if __name__ == '__main__':
    unittest.main(argv=[sys.argv[0]], exit=True)

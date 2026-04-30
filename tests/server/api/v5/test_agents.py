# Tests for the /llms.txt endpoint (AI agent orientation).
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


class TestLlmsTxt(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.app = create_app(sys.argv[1])
        cls.client = create_client(cls.app)

    def test_returns_200(self):
        resp = self.client.get('/llms.txt')
        self.assertEqual(resp.status_code, 200)

    def test_content_type_is_text_plain(self):
        resp = self.client.get('/llms.txt')
        self.assertTrue(resp.content_type.startswith('text/plain'))

    def test_contains_lnt_description(self):
        resp = self.client.get('/llms.txt')
        text = resp.get_data(as_text=True)
        self.assertIn('LNT', text)
        self.assertIn('performance testing infrastructure', text)

    def test_contains_key_concepts(self):
        resp = self.client.get('/llms.txt')
        text = resp.get_data(as_text=True)
        self.assertIn('Key Concepts', text)
        self.assertIn('Test Suite', text)
        self.assertIn('Machine', text)
        self.assertIn('Regression', text)

    def test_contains_api_links(self):
        resp = self.client.get('/llms.txt')
        text = resp.get_data(as_text=True)
        self.assertIn('/api/v5/openapi/swagger-ui', text)

    def test_contains_endpoint_listing(self):
        resp = self.client.get('/llms.txt')
        text = resp.get_data(as_text=True)
        self.assertIn('/api/v5/{ts}/machines', text)
        self.assertIn('/api/v5/{ts}/runs', text)
        self.assertIn('/api/v5/{ts}/query', text)


if __name__ == '__main__':
    unittest.main(argv=[sys.argv[0]], exit=True)

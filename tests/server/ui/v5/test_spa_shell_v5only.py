# Tests for the v5 SPA shell running on a v5-only instance (no v4 blueprint).
# Verifies that all SPA routes serve correctly without the v4 frontend.
#
# RUN: rm -rf %t.instance %t.pg.log
# RUN: %{utils}/with_postgres.sh %t.pg.log \
# RUN:     %{utils}/with_temporary_instance.py %t.instance --db-version 5.0 \
# RUN:         -- python %s %t.instance
# END.

import sys
import unittest

import lnt.server.ui.app

INSTANCE_PATH = sys.argv.pop(1)


class TestSPAShellV5Only(unittest.TestCase):
    """Test SPA shell on a v5-only instance (v4 blueprint not registered)."""

    @classmethod
    def setUpClass(cls):
        cls.app = lnt.server.ui.app.App.create_standalone(INSTANCE_PATH)
        cls.app.testing = True
        cls.client = cls.app.test_client()

    def test_dashboard_route(self):
        resp = self.client.get('/v5/')
        self.assertEqual(resp.status_code, 200)
        html = resp.get_data(as_text=True)
        self.assertIn('id="v5-app"', html)
        self.assertIn('data-testsuite=""', html)

    def test_graph_route(self):
        resp = self.client.get('/v5/graph')
        self.assertEqual(resp.status_code, 200)
        html = resp.get_data(as_text=True)
        self.assertIn('id="v5-app"', html)

    def test_compare_route(self):
        resp = self.client.get('/v5/compare')
        self.assertEqual(resp.status_code, 200)
        html = resp.get_data(as_text=True)
        self.assertIn('id="v5-app"', html)

    def test_admin_route(self):
        resp = self.client.get('/v5/admin')
        self.assertEqual(resp.status_code, 200)
        html = resp.get_data(as_text=True)
        self.assertIn('id="v5-app"', html)
        self.assertIn('data-testsuite=""', html)

    def test_test_suites_route(self):
        resp = self.client.get('/v5/test-suites')
        self.assertEqual(resp.status_code, 200)
        html = resp.get_data(as_text=True)
        self.assertIn('id="v5-app"', html)

    def test_suite_scoped_route(self):
        resp = self.client.get('/v5/nts/')
        self.assertEqual(resp.status_code, 200)
        html = resp.get_data(as_text=True)
        self.assertIn('id="v5-app"', html)
        self.assertIn('data-testsuite="nts"', html)

    def test_suite_scoped_subpath(self):
        resp = self.client.get('/v5/nts/machines/some-machine')
        self.assertEqual(resp.status_code, 200)

    def test_template_loads_v5_assets(self):
        resp = self.client.get('/v5/')
        html = resp.get_data(as_text=True)
        self.assertIn('v5/v5.js', html)
        self.assertIn('v5/v5.css', html)

    def test_template_has_lnt_url_base(self):
        resp = self.client.get('/v5/')
        html = resp.get_data(as_text=True)
        self.assertIn('var lnt_url_base=', html)

    def test_v4_url_is_empty(self):
        """On a v5-only instance, the v4 link should be empty."""
        resp = self.client.get('/v5/')
        html = resp.get_data(as_text=True)
        self.assertIn('data-v4-url=""', html)


if __name__ == '__main__':
    unittest.main()

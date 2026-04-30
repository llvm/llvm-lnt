# Tests for the v5 SPA shell.
# Verifies that all SPA routes serve correctly, including catch-all routing,
# trailing slashes, template content, and error cases.
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


class TestSPAShell(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = lnt.server.ui.app.App.create_standalone(INSTANCE_PATH)
        cls.app.testing = True
        cls.client = cls.app.test_client()

    # --- Suite-agnostic routes ---

    def test_dashboard_route(self):
        resp = self.client.get('/v5/')
        self.assertEqual(resp.status_code, 200)
        html = resp.get_data(as_text=True)
        self.assertIn('id="v5-app"', html)
        self.assertIn('data-testsuite=""', html)

    def test_dashboard_no_trailing_slash(self):
        """GET /v5 (no trailing slash) redirects or serves the SPA."""
        resp = self.client.get('/v5')
        self.assertIn(resp.status_code, (200, 301, 302, 308))

    def test_graph_route(self):
        resp = self.client.get('/v5/graph')
        self.assertEqual(resp.status_code, 200)
        html = resp.get_data(as_text=True)
        self.assertIn('id="v5-app"', html)
        self.assertIn('data-testsuite=""', html)

    def test_compare_route(self):
        resp = self.client.get('/v5/compare')
        self.assertEqual(resp.status_code, 200)
        html = resp.get_data(as_text=True)
        self.assertIn('id="v5-app"', html)
        self.assertIn('data-testsuite=""', html)

    def test_admin_route(self):
        resp = self.client.get('/v5/admin')
        self.assertEqual(resp.status_code, 200)
        html = resp.get_data(as_text=True)
        self.assertIn('id="v5-app"', html)
        self.assertIn('data-testsuite=""', html)

    def test_admin_route_trailing_slash(self):
        """/v5/admin/ (trailing slash) must hit the admin route, not the catch-all."""
        resp = self.client.get('/v5/admin/')
        self.assertEqual(resp.status_code, 200)
        html = resp.get_data(as_text=True)
        self.assertIn('id="v5-app"', html)
        self.assertIn('data-testsuite=""', html)

    def test_test_suites_route(self):
        resp = self.client.get('/v5/test-suites')
        self.assertEqual(resp.status_code, 200)
        html = resp.get_data(as_text=True)
        self.assertIn('id="v5-app"', html)

    def test_test_suites_trailing_slash(self):
        """/v5/test-suites/ (trailing slash) should work."""
        resp = self.client.get('/v5/test-suites/')
        self.assertIn(resp.status_code, (200, 301, 302, 308))

    # --- Suite-scoped routes ---

    def test_suite_scoped_route(self):
        resp = self.client.get('/v5/nts/')
        self.assertEqual(resp.status_code, 200)
        html = resp.get_data(as_text=True)
        self.assertIn('id="v5-app"', html)
        self.assertIn('data-testsuite="nts"', html)

    def test_machines_route(self):
        resp = self.client.get('/v5/nts/machines')
        self.assertEqual(resp.status_code, 200)
        html = resp.get_data(as_text=True)
        self.assertIn('id="v5-app"', html)

    def test_machine_detail_route(self):
        resp = self.client.get('/v5/nts/machines/some-machine')
        self.assertEqual(resp.status_code, 200)
        html = resp.get_data(as_text=True)
        self.assertIn('id="v5-app"', html)

    def test_runs_route(self):
        resp = self.client.get('/v5/nts/runs/some-uuid')
        self.assertEqual(resp.status_code, 200)
        html = resp.get_data(as_text=True)
        self.assertIn('id="v5-app"', html)

    def test_commits_route(self):
        resp = self.client.get('/v5/nts/commits/some-value')
        self.assertEqual(resp.status_code, 200)
        html = resp.get_data(as_text=True)
        self.assertIn('id="v5-app"', html)

    def test_regressions_route(self):
        resp = self.client.get('/v5/nts/regressions')
        self.assertEqual(resp.status_code, 200)
        html = resp.get_data(as_text=True)
        self.assertIn('id="v5-app"', html)

    def test_field_changes_route(self):
        resp = self.client.get('/v5/nts/field-changes')
        self.assertEqual(resp.status_code, 200)
        html = resp.get_data(as_text=True)
        self.assertIn('id="v5-app"', html)

    def test_admin_subpath_under_testsuite(self):
        resp = self.client.get('/v5/nts/admin')
        self.assertEqual(resp.status_code, 200)
        html = resp.get_data(as_text=True)
        self.assertIn('id="v5-app"', html)

    def test_deeply_nested_route(self):
        """Catch-all should handle deep paths."""
        resp = self.client.get('/v5/nts/regressions/some-uuid')
        self.assertEqual(resp.status_code, 200)
        html = resp.get_data(as_text=True)
        self.assertIn('id="v5-app"', html)

    def test_compare_suite_scoped(self):
        resp = self.client.get('/v5/nts/compare')
        self.assertEqual(resp.status_code, 200)
        html = resp.get_data(as_text=True)
        self.assertIn('id="v5-app"', html)
        self.assertIn('data-testsuite="nts"', html)

    # --- Template content ---

    def test_template_has_testsuites_data(self):
        resp = self.client.get('/v5/nts/')
        html = resp.get_data(as_text=True)
        self.assertIn('data-testsuites=', html)
        self.assertIn('nts', html)

    def test_template_loads_v5_assets(self):
        resp = self.client.get('/v5/')
        html = resp.get_data(as_text=True)
        self.assertIn('v5/v5.js', html)
        self.assertIn('v5/v5.css', html)

    def test_template_has_lnt_url_base(self):
        resp = self.client.get('/v5/')
        html = resp.get_data(as_text=True)
        self.assertIn('var lnt_url_base=', html)

    # --- Error cases ---

    def test_nonexistent_testsuite(self):
        resp = self.client.get('/v5/nonexistent/')
        self.assertEqual(resp.status_code, 404)

    def test_compare_nonexistent_testsuite(self):
        resp = self.client.get('/v5/nonexistent/compare')
        self.assertEqual(resp.status_code, 404)


if __name__ == '__main__':
    unittest.main()

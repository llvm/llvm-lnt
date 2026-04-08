# Tests for the v5 SPA shell (Phase 1).
# Verifies that the catch-all route serves the SPA shell for all v5 routes,
# that the v4 compare route still works, and that the SPA template includes
# the expected elements.
#
# RUN: rm -rf %t.instance %t.pg.log
# RUN: %{utils}/with_postgres.sh %t.pg.log \
# RUN:     %{utils}/with_temporary_instance.py %t.instance \
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

    # --- SPA catch-all route ---

    def test_dashboard_route(self):
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

    def test_orders_route(self):
        resp = self.client.get('/v5/nts/orders/some-value')
        self.assertEqual(resp.status_code, 200)
        html = resp.get_data(as_text=True)
        self.assertIn('id="v5-app"', html)

    def test_graph_route(self):
        resp = self.client.get('/v5/nts/graph')
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

    # --- Global admin route (not testsuite-specific) ---

    def test_root_route(self):
        """The /v5/ route is the suite-agnostic dashboard."""
        resp = self.client.get('/v5/')
        self.assertEqual(resp.status_code, 200)
        html = resp.get_data(as_text=True)
        self.assertIn('id="v5-app"', html)
        self.assertIn('data-testsuite=""', html)

    def test_root_route_no_trailing_slash(self):
        """GET /v5 (no trailing slash) redirects or serves the SPA."""
        resp = self.client.get('/v5')
        # Flask strict_slashes=False means it serves 200 directly
        self.assertIn(resp.status_code, (200, 301, 302, 308))

    def test_test_suites_route(self):
        """The /v5/test-suites route is suite-agnostic."""
        resp = self.client.get('/v5/test-suites')
        self.assertEqual(resp.status_code, 200)
        html = resp.get_data(as_text=True)
        self.assertIn('id="v5-app"', html)
        self.assertIn('data-testsuite=""', html)

    def test_test_suites_route_trailing_slash(self):
        """/v5/test-suites/ (trailing slash) should work."""
        resp = self.client.get('/v5/test-suites/')
        self.assertIn(resp.status_code, (200, 301, 302, 308))

    def test_root_does_not_conflict_with_suite(self):
        """GET /v5/nts/ still works with the new /v5/ route."""
        resp = self.client.get('/v5/nts/')
        self.assertEqual(resp.status_code, 200)
        html = resp.get_data(as_text=True)
        self.assertIn('data-testsuite="nts"', html)

    def test_admin_route(self):
        """The /v5/admin route is global, not under any testsuite."""
        resp = self.client.get('/v5/admin')
        self.assertEqual(resp.status_code, 200)
        html = resp.get_data(as_text=True)
        self.assertIn('id="v5-app"', html)
        # Admin is suite-independent — testsuite should be empty
        self.assertIn('data-testsuite=""', html)
        # Should include the list of available testsuites
        self.assertIn('data-testsuites=', html)

    def test_graph_route_serves_spa(self):
        """The /v5/graph route is global (suite-agnostic)."""
        resp = self.client.get('/v5/graph')
        self.assertEqual(resp.status_code, 200)
        html = resp.get_data(as_text=True)
        self.assertIn('id="v5-app"', html)
        self.assertIn('data-testsuite=""', html)

    def test_compare_route_serves_spa(self):
        """The /v5/compare route is global (suite-agnostic)."""
        resp = self.client.get('/v5/compare')
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

    def test_deeply_nested_route(self):
        """Catch-all should handle deep paths."""
        resp = self.client.get('/v5/nts/regressions/some-uuid')
        self.assertEqual(resp.status_code, 200)
        html = resp.get_data(as_text=True)
        self.assertIn('id="v5-app"', html)

    # --- SPA template content ---

    def test_spa_template_has_testsuites_data(self):
        resp = self.client.get('/v5/nts/')
        html = resp.get_data(as_text=True)
        self.assertIn('data-testsuites=', html)
        # Should contain "nts" in the testsuites JSON
        self.assertIn('nts', html)

    def test_spa_template_has_v4_url(self):
        resp = self.client.get('/v5/nts/')
        html = resp.get_data(as_text=True)
        self.assertIn('data-v4-url=', html)
        # v4 URL should be the root page, not suite-specific
        self.assertNotIn('recent_activity', html)

    def test_spa_template_loads_v5_assets(self):
        resp = self.client.get('/v5/nts/')
        html = resp.get_data(as_text=True)
        self.assertIn('v5/v5.js', html)
        self.assertIn('v5/v5.css', html)
        self.assertIn('plotly', html)

    def test_spa_template_has_lnt_url_base(self):
        resp = self.client.get('/v5/nts/')
        html = resp.get_data(as_text=True)
        self.assertIn('var lnt_url_base=', html)

    def test_spa_template_hides_v4_navbar(self):
        """The v5 SPA uses nonav to suppress the v4 navbar."""
        resp = self.client.get('/v5/nts/')
        html = resp.get_data(as_text=True)
        # The v4 navbar contains "navbar-fixed-top" — should NOT be present
        # when nonav is set (the <div id="header"> is suppressed)
        self.assertNotIn('navbar-fixed-top', html)

    # --- Compare URL serves SPA shell (no separate route) ---

    def test_compare_url_serves_spa(self):
        resp = self.client.get('/v5/nts/compare')
        self.assertEqual(resp.status_code, 200)
        html = resp.get_data(as_text=True)
        self.assertIn('id="v5-app"', html)

    # --- Error cases ---

    def test_nonexistent_testsuite(self):
        resp = self.client.get('/v5/nonexistent/')
        self.assertEqual(resp.status_code, 404)

    # --- v4 layout has v5 UI link ---

    def test_v4_layout_has_v5_link(self):
        resp = self.client.get('/db_default/v4/nts/recent_activity')
        self.assertEqual(resp.status_code, 200)
        html = resp.get_data(as_text=True)
        self.assertIn('v5 UI', html)
        self.assertIn('/v5/nts/', html)


if __name__ == '__main__':
    unittest.main()

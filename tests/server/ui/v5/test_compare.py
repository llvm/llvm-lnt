# Tests for the v5 compare route.
#
# The old standalone compare page (v5_compare.html + comparison.js) was
# replaced by the SPA catch-all in Phase 1.  The /v5/{ts}/compare URL
# now serves the SPA shell, and the client-side router handles the
# compare page module.
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


class TestComparePage(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = lnt.server.ui.app.App.create_standalone(INSTANCE_PATH)
        cls.app.testing = True
        cls.client = cls.app.test_client()

    def test_compare_serves_spa_shell(self):
        resp = self.client.get('/v5/nts/compare')
        self.assertEqual(resp.status_code, 200)
        html = resp.get_data(as_text=True)
        self.assertIn('id="v5-app"', html)
        self.assertIn('data-testsuite="nts"', html)

    def test_compare_nonexistent_testsuite(self):
        resp = self.client.get('/v5/nonexistent/compare')
        self.assertEqual(resp.status_code, 404)


if __name__ == '__main__':
    unittest.main()

# Check that POST to /runs submits a new run.
# RUN: rm -rf %t.instance
# RUN: %{utils}/with_postgres.sh %t.pg.log \
# RUN:     %{utils}/with_temporary_instance.py %t.instance \
# RUN:         %{shared_inputs}/base-reports \
# RUN:         -- python %s %t.instance %{shared_inputs}

import json
import logging
import os
import sys
import unittest

TESTS_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))
UI_DIR = os.path.join(TESTS_DIR, 'ui')
sys.path.insert(0, UI_DIR)

import lnt.server.ui.app

logging.basicConfig(level=logging.INFO)


class PostRunTest(unittest.TestCase):
    """Test POST /runs endpoint."""

    def setUp(self):
        _, instance_path, shared_inputs = sys.argv
        app = lnt.server.ui.app.App.create_standalone(instance_path)
        app.testing = True
        self.client = app.test_client()
        self.shared_inputs = shared_inputs

    def test_00_post_new_run(self):
        """Check POST to /runs creates a new run."""
        client = self.client

        with open('%s/sample-report.json' % self.shared_inputs) as f:
            data = f.read()

        resp = client.post('api/db_default/v4/nts/runs', data=data)
        self.assertEqual(resp.status_code, 401)

        resp = client.post('api/db_default/v4/nts/runs', data=data,
                           headers={'AuthToken': 'test_token'})
        self.assertEqual(resp.status_code, 301)
        self.assertIn('http://localhost/api/db_default/v4/nts/runs/', resp.headers['Location'])
        resp_json = json.loads(resp.data)
        self.assertIsInstance(resp_json['run_id'], int)

    def test_01_post_duplicate_run(self):
        """Check POST to /runs with merge=reject rejects duplicates."""
        client = self.client

        with open('%s/sample-report.json' % self.shared_inputs) as f:
            data = f.read()

        # Ensure the run exists (may already exist from test_00).
        client.post('api/db_default/v4/nts/runs', data=data,
                    headers={'AuthToken': 'test_token'})

        # Now submit again with merge=reject to provoke a failure.
        resp = client.post('api/db_default/v4/nts/runs?merge=reject',
                           data=data,
                           headers={'AuthToken': 'test_token'})
        self.assertEqual(resp.status_code, 400)
        resp_json = json.loads(resp.data)
        self.assertEqual(resp_json['error'],
                         "import failure: Duplicate submission for '1'")
        self.assertEqual(resp_json['success'], False)


if __name__ == '__main__':
    unittest.main(argv=[sys.argv[0], ])

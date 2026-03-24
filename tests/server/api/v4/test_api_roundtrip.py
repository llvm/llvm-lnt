# Check that the LNT REST JSON API is working.
# create temporary instance
# RUN: rm -rf %t.instance
# RUN: %{utils}/with_postgres.sh %t.pg.log \
# RUN:     %{utils}/with_temporary_instance.py %t.instance \
# RUN:         %{shared_inputs}/base-reports \
# RUN:         -- python %s %t.instance %{shared_inputs}

import json
import logging
import os
import sys

TESTS_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
UI_DIR = os.path.join(TESTS_DIR, 'ui')
sys.path.insert(0, UI_DIR)

import unittest

import lnt.server.db.migrate
import lnt.server.ui.app
from V4Pages import check_json

logging.basicConfig(level=logging.DEBUG)


class JSONAPIDeleteTester(unittest.TestCase):
    """Test the REST api."""
    def setUp(self):
        """Bind to the LNT test instance."""
        _, instance_path, shared_inputs = sys.argv
        app = lnt.server.ui.app.App.create_standalone(instance_path)
        app.testing = True
        self.client = app.test_client()
        self.shared_inputs = shared_inputs

    def test_roundtrip(self):
        """Check /runs GET, POST roundtrip"""
        client = self.client

        j = check_json(client, 'api/db_default/v4/nts/machines/')
        machine_id = next(m['id'] for m in j['machines']
                          if m['name'] == 'localhost__clang_DEV__x86_64')
        machine_data = check_json(client, 'api/db_default/v4/nts/machines/{}'.format(machine_id))
        # Pick a run without tests (to avoid sample ID comparison issues)
        run_id = None
        for run_summary in machine_data['runs']:
            run_data = check_json(client, 'api/db_default/v4/nts/runs/{}'.format(run_summary['id']))
            if not run_data['tests']:
                run_id = run_summary['id']
                break
        self.assertIsNotNone(run_id, "Expected a run without tests")

        # Download original
        original = check_json(client, 'api/db_default/v4/nts/runs/{}'.format(run_id))

        # Remove the run
        resp = client.delete('api/db_default/v4/nts/runs/{}'.format(run_id),
                             headers={'AuthToken': 'test_token'})
        self.assertEqual(resp.status_code, 200)

        # Post it back
        resp = client.post('api/db_default/v4/nts/runs',
                           data=json.dumps(original),
                           headers={'AuthToken': 'test_token'})
        self.assertEqual(resp.status_code, 301)
        new_location = resp.headers['Location']

        # Download new data
        reimported = check_json(client, new_location)

        # The 'id' field may be the different, the rest must be the same.
        reimported['run']['id'] = original['run']['id']
        self.assertEqual(original, reimported)


if __name__ == '__main__':
    unittest.main(argv=[sys.argv[0], ])

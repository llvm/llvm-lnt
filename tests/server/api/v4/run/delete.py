# Check that DELETE /runs/n deletes a run and its samples.
# RUN: rm -rf %t.instance
# RUN: %{utils}/with_postgres.sh %t.pg.log \
# RUN:     %{utils}/with_temporary_instance.py %t.instance \
# RUN:         %{shared_inputs}/base-reports \
# RUN:         -- python %s %t.instance

import logging
import os
import sys
import unittest

TESTS_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))
UI_DIR = os.path.join(TESTS_DIR, 'ui')
sys.path.insert(0, UI_DIR)

import lnt.server.ui.app
from V4Pages import check_json

logging.basicConfig(level=logging.INFO)


class DeleteRunTest(unittest.TestCase):
    """Test DELETE /runs/n endpoint."""

    def setUp(self):
        _, instance_path = sys.argv
        app = lnt.server.ui.app.App.create_standalone(instance_path)
        app.testing = True
        self.client = app.test_client()

    def test_delete_run(self):
        """Check /runs/n can be deleted."""
        client = self.client

        j = check_json(client, 'api/db_default/v4/nts/machines/')
        machine_id = next(m['id'] for m in j['machines']
                          if m['name'] == 'localhost__clang_DEV__x86_64')
        machine_data = check_json(client, 'api/db_default/v4/nts/machines/{}'.format(machine_id))
        run_id = machine_data['runs'][0]['id']

        j = check_json(client, 'api/db_default/v4/nts/runs/{}'.format(run_id))
        sample_ids = [s['id'] for s in j['tests']]
        self.assertNotEqual(len(sample_ids), 0)
        for sid in sample_ids:
            resp = client.get('api/db_default/v4/nts/samples/{}'.format(sid))
            self.assertEqual(resp.status_code, 200)

        resp = client.delete('api/db_default/v4/nts/runs/{}'.format(run_id))
        self.assertEqual(resp.status_code, 401)

        resp = client.delete('api/db_default/v4/nts/runs/{}'.format(run_id),
                             headers={'AuthToken': 'wrong token'})
        self.assertEqual(resp.status_code, 401)

        resp = client.delete('api/db_default/v4/nts/runs/{}'.format(run_id),
                             headers={'AuthToken': 'test_token'})
        self.assertEqual(resp.status_code, 200)

        resp = client.get('api/db_default/v4/nts/runs/{}'.format(run_id))
        self.assertEqual(resp.status_code, 404)

        for sid in sample_ids:
            resp = client.get('api/db_default/v4/nts/samples/{}'.format(sid))
            self.assertEqual(resp.status_code, 404)


if __name__ == '__main__':
    unittest.main(argv=[sys.argv[0], ])

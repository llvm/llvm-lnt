# Check that DELETE /machines/n deletes a machine and its runs/samples.
# RUN: rm -rf %t.instance
# RUN: python %{shared_inputs}/create_temp_instance.py \
# RUN:     %s %{shared_inputs}/SmallInstance \
# RUN:     %t.instance %S/../../ui/Inputs/V4Pages_extra_records.sql
#
# RUN: python %s %t.instance

import logging
import os
import sys
import unittest

TESTS_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
UI_DIR = os.path.join(TESTS_DIR, 'ui')
sys.path.insert(0, UI_DIR)

import lnt.server.ui.app
from V4Pages import check_json

logging.basicConfig(level=logging.INFO)


class DeleteMachineTest(unittest.TestCase):
    """Test DELETE /machines/n endpoint."""

    def setUp(self):
        _, instance_path = sys.argv
        app = lnt.server.ui.app.App.create_standalone(instance_path)
        app.testing = True
        self.client = app.test_client()

    def test_delete_machine(self):
        """Check /machines/n can be deleted."""
        client = self.client

        j = check_json(client, 'api/db_default/v4/nts/machines/2')
        run_ids = [s['id'] for s in j['runs']]
        self.assertNotEqual(len(run_ids), 0)
        sample_ids = []
        for run_id in run_ids:
            resp = check_json(client,
                              'api/db_default/v4/nts/runs/{}'.format(run_id))
            sample_ids.extend([s['id'] for s in resp['tests']])
        self.assertNotEqual(len(sample_ids), 0)
        # Verify that sample_ids are individual ints as we expect, and
        # that they exist on the server.
        for sid in sample_ids:
            self.assertIsInstance(sid, int)
            resp = client.get('api/db_default/v4/nts/samples/{}'.format(sid))
            self.assertEqual(resp.status_code, 200)

        resp = client.delete('api/db_default/v4/nts/machines/2')
        self.assertEqual(resp.status_code, 401)

        resp = client.delete('api/db_default/v4/nts/machines/2',
                             headers={'AuthToken': 'wrong token'})
        self.assertEqual(resp.status_code, 401)

        resp = client.delete('api/db_default/v4/nts/machines/2',
                             headers={'AuthToken': 'test_token'})
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.get_data(as_text=True),
                         '''Deleting runs 3 5 6 7 8 9 (6/6)
Deleted machine machine2:2
''')

        resp = client.get('api/db_default/v4/nts/machines/2')
        self.assertEqual(resp.status_code, 404)

        for run_id in run_ids:
            resp = client.get('api/db_default/v4/nts/runs/{}'.format(run_id))
            self.assertEqual(resp.status_code, 404)

        for sid in sample_ids:
            resp = client.get('api/db_default/v4/nts/samples/{}'.format(sid))
            self.assertEqual(resp.status_code, 404)


if __name__ == '__main__':
    unittest.main(argv=[sys.argv[0], ])

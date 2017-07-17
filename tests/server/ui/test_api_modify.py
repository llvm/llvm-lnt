# Check that the LNT REST JSON API is working.
# create temporary instance
# RUN: rm -rf %t.instance
# RUN: python %{shared_inputs}/create_temp_instance.py \
# RUN:     %s %{shared_inputs}/SmallInstance \
# RUN:     %t.instance %S/Inputs/V4Pages_extra_records.sql
#
# RUN: python %s %t.instance

import logging
import sys
import unittest

import lnt.server.db.migrate
import lnt.server.ui.app
from V4Pages import check_json

logging.basicConfig(level=logging.DEBUG)


class JSONAPIDeleteTester(unittest.TestCase):
    """Test the REST api."""

    def setUp(self):
        """Bind to the LNT test instance."""
        _, instance_path = sys.argv
        app = lnt.server.ui.app.App.create_standalone(instance_path)
        app.testing = True
        self.client = app.test_client()

    def test_00_rename_machine(self):
        """Check rename POST request to /machines/n"""
        client = self.client

        # Make sure the environment is as expected.
        j = check_json(client, 'api/db_default/v4/nts/machines/1')
        self.assertEqual(j['machines'][0]['name'], 'localhost__clang_DEV__x86_64')

        data = {
            'action': 'rename',
            'name': 'new_machine_name',
        }
        resp = client.post('api/db_default/v4/nts/machines/1', data=data)
        self.assertEqual(resp.status_code, 401)

        resp = client.post('api/db_default/v4/nts/machines/1', data=data,
                           headers={'AuthToken': 'wrong token'})
        self.assertEqual(resp.status_code, 401)

        resp = client.post('api/db_default/v4/nts/machines/1', data=data,
                           headers={'AuthToken': 'test_token'})
        self.assertEqual(resp.status_code, 200)

        # Machine should be renamed now.
        j = check_json(client, 'api/db_default/v4/nts/machines/1')
        self.assertEqual(j['machines'][0]['name'], 'new_machine_name')

    def test_01_delete_run(self):
        """Check /runs/n can be deleted."""
        client = self.client

        j = check_json(client, 'api/db_default/v4/nts/runs/1')
        sample_ids = [s['id'] for s in j['samples']]
        self.assertNotEqual(len(sample_ids), 0)
        for sid in sample_ids:
            resp = client.get('api/db_default/v4/nts/samples/{}'.format(sid))
            self.assertEqual(resp.status_code, 200)

        resp = client.delete('api/db_default/v4/nts/runs/1')
        self.assertEqual(resp.status_code, 401)

        resp = client.delete('api/db_default/v4/nts/runs/1',
                             headers={'AuthToken': 'wrong token'})
        self.assertEqual(resp.status_code, 401)

        resp = client.delete('api/db_default/v4/nts/runs/1',
                             headers={'AuthToken': 'test_token'})
        self.assertEqual(resp.status_code, 200)

        resp = client.get('api/db_default/v4/nts/runs/1')
        self.assertEqual(resp.status_code, 404)

        for sid in sample_ids:
            resp = client.get('api/db_default/v4/nts/samples/{}'.format(sid))
            self.assertEqual(resp.status_code, 404)

    def test_02_delete_machine(self):
        """Check /machines/n can be deleted."""
        client = self.client

        j = check_json(client, 'api/db_default/v4/nts/machines/2')
        run_ids = [s['id'] for s in j['runs']]
        self.assertNotEqual(len(run_ids), 0)
        sample_ids = []
        for run_id in run_ids:
            resp = check_json(client,
                              'api/db_default/v4/nts/runs/{}'.format(run_id))
            sample_ids.append([s['id'] for s in resp['samples']])
        self.assertNotEqual(len(sample_ids), 0)

        resp = client.delete('api/db_default/v4/nts/machines/2')
        self.assertEqual(resp.status_code, 401)

        resp = client.delete('api/db_default/v4/nts/machines/2',
                             headers={'AuthToken': 'wrong token'})
        self.assertEqual(resp.status_code, 401)

        resp = client.delete('api/db_default/v4/nts/machines/2',
                             headers={'AuthToken': 'test_token'})
        self.assertEqual(resp.status_code, 200)

        resp = client.get('api/db_default/v4/nts/machines/2')
        self.assertEqual(resp.status_code, 404)

        for run_id in run_ids:
            resp = client.get('api/db_default/v4/nts/runs/{}'.format(run_id))
            self.assertEqual(resp.status_code, 404)

        for sid in sample_ids:
            resp = client.get('api/db_default/v4/nts/samples/{}'.format(sid))
            self.assertEqual(resp.status_code, 404)


if __name__ == '__main__':
    unittest.TestLoader.sortTestMethodsUsing = lambda _, x, y: cmp(x, y)
    unittest.main(argv=[sys.argv[0], ])

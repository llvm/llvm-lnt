# Check that the LNT REST JSON API is working.
# create temporary instance
# RUN: rm -rf %t.instance
# RUN: python %{shared_inputs}/create_temp_instance.py \
# RUN:     %s %{shared_inputs}/SmallInstance \
# RUN:     %t.instance %S/Inputs/V4Pages_extra_records.sql
#
# RUN: python %s %t.instance %{shared_inputs}

import json
import logging
import sys
import unittest

import lnt.server.db.migrate
import lnt.server.ui.app
from V4Pages import check_json

logging.basicConfig(level=logging.INFO)


class _hashabledict(dict):
    """See https://stackoverflow.com/questions/1151658."""
    def __hash__(self):
        return hash(tuple(sorted(self.items())))


class JSONAPIDeleteTester(unittest.TestCase):
    """Test the REST api."""

    def setUp(self):
        """Bind to the LNT test instance."""
        _, instance_path, shared_inputs = sys.argv
        app = lnt.server.ui.app.App.create_standalone(instance_path)
        app.testing = True
        self.client = app.test_client()
        self.shared_inputs = shared_inputs

    def test_00_update_machine(self):
        """Check PUT request to /machines/n"""
        client = self.client

        # We are going to set the 'os' field to none, remove the 'uname'
        # parameter and add the 'new_parameter' parameter.
        # Make sure none of those things happened yet:
        machine_before = check_json(client, 'api/db_default/v4/nts/machines/1')
        machine_before = machine_before['machine']
        self.assertIsNotNone(machine_before.get('os', None))
        self.assertIsNone(machine_before.get('new_parameter', None))
        self.assertIsNotNone(machine_before.get('uname', None))

        data = {
            'machine': {
                'hardware': 'hal 9000',
                'os': None,
                'hostname': 'localhost',
                'new_parameter': True,
            },
        }
        json_data = json.dumps(data)
        resp = client.put('api/db_default/v4/nts/machines/1', data=json_data,
                          headers={'AuthToken': 'test_token'})
        self.assertEqual(resp.status_code, 200)

        machine_after = check_json(client, 'api/db_default/v4/nts/machines/1')
        machine_after = machine_after['machine']
        for key in ('hardware', 'os', 'hostname', 'new_parameter', 'uname'):
            self.assertEquals(machine_after.get(key, None),
                              data['machine'].get(key, None))

    def test_00_rename_machine(self):
        """Check rename POST request to /machines/n"""
        client = self.client

        # Make sure the environment is as expected.
        j = check_json(client, 'api/db_default/v4/nts/machines/1')
        self.assertEqual(j['machine']['name'], 'localhost__clang_DEV__x86_64')

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
        self.assertEqual(j['machine']['name'], 'new_machine_name')

    def test_01_delete_run(self):
        """Check /runs/n can be deleted."""
        client = self.client

        j = check_json(client, 'api/db_default/v4/nts/runs/1')
        sample_ids = [s['id'] for s in j['tests']]
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
            sample_ids.append([s['id'] for s in resp['tests']])
        self.assertNotEqual(len(sample_ids), 0)

        resp = client.delete('api/db_default/v4/nts/machines/2')
        self.assertEqual(resp.status_code, 401)

        resp = client.delete('api/db_default/v4/nts/machines/2',
                             headers={'AuthToken': 'wrong token'})
        self.assertEqual(resp.status_code, 401)

        resp = client.delete('api/db_default/v4/nts/machines/2',
                             headers={'AuthToken': 'test_token'})
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.get_data(),
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

    def test_03_post_run(self):
        """Check POST to /runs."""
        client = self.client

        resp = client.get('api/db_default/v4/nts/runs/5')
        self.assertEqual(resp.status_code, 404)

        data = open('%s/sample-report.json' % self.shared_inputs).read()

        resp = client.post('api/db_default/v4/nts/runs', data=data)
        self.assertEqual(resp.status_code, 401)

        resp = client.post('api/db_default/v4/nts/runs', data=data,
                           headers={'AuthToken': 'test_token'})
        self.assertEqual(resp.status_code, 301)
        self.assertIn('http://localhost/api/db_default/v4/nts/runs/', resp.headers['Location'])
        resp_json = json.loads(resp.data)
        self.assertEqual(resp_json['run_id'], 5)

        # Provoke a failing submission.
        resp = client.post('api/db_default/v4/nts/runs?merge=reject',
                           data=data,
                           headers={'AuthToken': 'test_token'})
        self.assertEqual(resp.status_code, 400)
        resp_json = json.loads(resp.data)
        self.assertEqual(resp_json['error'],
                         "import failure: Duplicate submission for '1'")
        self.assertEqual(resp_json['success'], False)

    def test_04_merge_into(self):
        """Check POST/merge into request for /machines."""
        client = self.client

        # Download existing machines.
        machine_1 = check_json(client, 'api/db_default/v4/nts/machines/1')
        machine_3 = check_json(client, 'api/db_default/v4/nts/machines/3')
        # The test is boring if we don't have at least 1 run in each machine.
        self.assertTrue(len(machine_1['runs']) > 0)
        self.assertTrue(len(machine_3['runs']) > 0)

        data = {
            'action': 'merge',
            'into': '3',
        }
        resp = client.post('api/db_default/v4/nts/machines/1', data=data,
                           headers={'AuthToken': 'test_token'})
        self.assertEqual(resp.status_code, 200)

        # Old machine should have disappeared.
        resp_2 = client.get('api/db_default/v4/nts/machines/1')
        self.assertEqual(resp_2.status_code, 404)

        # The other machine should have the union of all runs.
        machine_1['runs'] = [_hashabledict(run) for run in machine_1['runs']]
        machine_3['runs'] = [_hashabledict(run) for run in machine_3['runs']]
        allruns = set(machine_1['runs']).union(machine_3['runs'])
        resp_3 = check_json(client, 'api/db_default/v4/nts/machines/3')
        resp_3['runs'] = [_hashabledict(run) for run in resp_3['runs']]
        self.assertEqual(set(resp_3['runs']), allruns)


if __name__ == '__main__':
    unittest.main(argv=[sys.argv[0], ])

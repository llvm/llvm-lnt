# Check that POST merge into /machines/n merges machines.
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


class _hashabledict(dict):
    """See https://stackoverflow.com/questions/1151658."""
    def __hash__(self):
        return hash(tuple(sorted(self.items())))


class MergeMachineTest(unittest.TestCase):
    """Test POST merge /machines/n endpoint."""

    def setUp(self):
        _, instance_path = sys.argv
        app = lnt.server.ui.app.App.create_standalone(instance_path)
        app.testing = True
        self.client = app.test_client()

    def test_merge_into(self):
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

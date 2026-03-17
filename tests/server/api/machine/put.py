# Check that PUT to /machines/n updates machine fields.
# RUN: rm -rf %t.instance
# RUN: python %{shared_inputs}/create_temp_instance.py \
# RUN:     %s %{shared_inputs}/SmallInstance \
# RUN:     %t.instance %S/../../ui/Inputs/V4Pages_extra_records.sql
#
# RUN: python %s %t.instance

import json
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


class UpdateMachineTest(unittest.TestCase):
    """Test PUT /machines/n endpoint."""

    def setUp(self):
        _, instance_path = sys.argv
        app = lnt.server.ui.app.App.create_standalone(instance_path)
        app.testing = True
        self.client = app.test_client()

    def test_update_machine(self):
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
            self.assertEqual(machine_after.get(key, None),
                             data['machine'].get(key, None))


if __name__ == '__main__':
    unittest.main(argv=[sys.argv[0], ])

# Check that POST rename to /machines/n renames a machine.
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


class RenameMachineTest(unittest.TestCase):
    """Test POST rename /machines/n endpoint."""

    def setUp(self):
        _, instance_path = sys.argv
        app = lnt.server.ui.app.App.create_standalone(instance_path)
        app.testing = True
        self.client = app.test_client()

    def test_rename_machine(self):
        """Check rename POST request to /machines/n"""
        client = self.client

        j = check_json(client, 'api/db_default/v4/nts/machines/')
        machine_id = next(m['id'] for m in j['machines']
                          if m['name'] == 'localhost__clang_DEV__x86_64')

        # Make sure the environment is as expected.
        j = check_json(client, 'api/db_default/v4/nts/machines/{}'.format(machine_id))
        self.assertEqual(j['machine']['name'], 'localhost__clang_DEV__x86_64')

        data = {
            'action': 'rename',
            'name': 'new_machine_name',
        }
        resp = client.post('api/db_default/v4/nts/machines/{}'.format(machine_id), data=data)
        self.assertEqual(resp.status_code, 401)

        resp = client.post('api/db_default/v4/nts/machines/{}'.format(machine_id), data=data,
                           headers={'AuthToken': 'wrong token'})
        self.assertEqual(resp.status_code, 401)

        resp = client.post('api/db_default/v4/nts/machines/{}'.format(machine_id), data=data,
                           headers={'AuthToken': 'test_token'})
        self.assertEqual(resp.status_code, 200)

        # Machine should be renamed now.
        j = check_json(client, 'api/db_default/v4/nts/machines/{}'.format(machine_id))
        self.assertEqual(j['machine']['name'], 'new_machine_name')


if __name__ == '__main__':
    unittest.main(argv=[sys.argv[0], ])

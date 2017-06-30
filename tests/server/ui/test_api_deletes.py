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

    def test_run_api(self):
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

        resp = client.delete('api/db_default/v4/nts/runs/1', headers={'AuthToken': 'wrong token'})
        self.assertEqual(resp.status_code, 401)

        resp = client.delete('api/db_default/v4/nts/runs/1', headers={'AuthToken': 'test_token'})
        self.assertEqual(resp.status_code, 200)

        resp = client.get('api/db_default/v4/nts/runs/1')
        self.assertEqual(resp.status_code, 404)

        for sid in sample_ids:
            resp = client.get('api/db_default/v4/nts/samples/{}'.format(sid))
            self.assertEqual(resp.status_code, 404)


if __name__ == '__main__':
    unittest.main(argv=[sys.argv[0], ])

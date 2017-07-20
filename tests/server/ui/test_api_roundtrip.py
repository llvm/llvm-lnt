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

        # Download originl
        original = check_json(client, 'api/db_default/v4/nts/runs/2')

        # Remove the run
        resp = client.delete('api/db_default/v4/nts/runs/2',
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
    unittest.TestLoader.sortTestMethodsUsing = lambda _, x, y: cmp(x, y)
    unittest.main(argv=[sys.argv[0], ])

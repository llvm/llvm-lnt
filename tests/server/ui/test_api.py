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

machines_expected_response = [{u'hardware': u'x86_64',
                               u'os': u'Darwin 11.3.0',
                               u'id': 1,
                               u'name': u'localhost__clang_DEV__x86_64'},
                              {u'hardware': u'AArch64',
                               u'os': u'linux',
                               u'id': 2,
                               u'name': u'machine2'},
                              {u'hardware': u'AArch64',
                               u'os': u'linux',
                               u'id': 3,
                               u'name': u'machine3'}]

order_expected_response = {u'id': 1,
                           u'name': "154331",
                           u'next_order_id': 0,
                           u'previous_order_id': 2}

graph_data = [[[152292], 1.0,
               {u'date': u'2012-05-01 16:28:23',
                u'label': u'152292',
                u'runID': u'5'}],
              [[152293], 10.0,
               {u'date': u'2012-05-03 16:28:24',
                u'label': u'152293',
                u'runID': u'6'}]]

graph_data2 = [[[152293], 10.0,
                {u'date': u'2012-05-03 16:28:24',
                 u'label': u'152293',
                 u'runID': u'6'}]]


class JSONAPITester(unittest.TestCase):
    """Test the REST api."""

    def setUp(self):
        """Bind to the LNT test instance."""
        _, instance_path = sys.argv
        app = lnt.server.ui.app.App.create_standalone(instance_path)
        app.testing = True
        self.client = app.test_client()

    def test_machine_api(self):
        """Check /machines and /machine/n return expected results from
        testdb.
        """
        client = self.client
        j = check_json(client, 'api/db_default/v4/nts/machines')
        self.assertEquals(j, machines_expected_response)
        j = check_json(client, 'api/db_default/v4/nts/machine/1')
        self.assertEqual(j.keys(), [u'runs', u'name', u'parameters', u'hardware', u'os', u'id'])
        expected = {"hardware": "x86_64", "os": "Darwin 11.3.0", "id": 1}
        self.assertDictContainsSubset(expected, j)

    def test_run_api(self):
        """Check /run/n returns expected run information."""
        client = self.client
        j = check_json(client, 'api/db_default/v4/nts/run/1')
        expected = {"machine": "/api/db_default/v4/nts/machine/1",
                    "order_url": "/api/db_default/v4/nts/order/1",
                    "end_time": "2012-04-11T16:28:58",

                    "order_id": 1,
                    "start_time": "2012-04-11T16:28:23",
                    "machine_id": 1,
                    "id": 1,
                    "order": {
                        "previous_order_id": 2,
                        "next_order_id": 0,
                        "id": 1,
                        "name": "154331"
                    }
                    }
        self.assertDictContainsSubset(expected, j)

    def test_order_api(self):
        """ Check /order/n returns the expected order information."""
        client = self.client
        j = check_json(client, 'api/db_default/v4/nts/order/1')
        self.assertEquals(j, order_expected_response)

    def test_graph_api(self):
        """Check that /graph/x/y/z returns what we expect."""
        client = self.client

        j = check_json(client, 'api/db_default/v4/nts/graph/2/4/3')
        self.assertEqual(graph_data, j)

        # Now check that limit works.
        j2 = check_json(client, 'api/db_default/v4/nts/graph/2/4/3?limit=1')
        self.assertEqual(graph_data2, j2)


if __name__ == '__main__':
    unittest.main(argv=[sys.argv[0], ])

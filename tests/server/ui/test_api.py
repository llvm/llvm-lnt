# Check that the LNT REST JSON API is working.
# create temporary instance
# RUN: rm -rf %t.instance
# RUN: python %{shared_inputs}/create_temp_instance.py \
# RUN:     %s %{shared_inputs}/SmallInstance \
# RUN:     %t.instance %S/Inputs/V4Pages_extra_records.sql
#
# RUN: python %s %t.instance

import unittest
import logging
import sys

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

# Machine add some extra fields, so add them.
machine_expected_response = list(machines_expected_response)
machine_expected_response[0] = machines_expected_response[0].copy()
machine_expected_response[0][u'runs'] = [u'/api/db_default/v4/nts/run/1',
                                         u'/api/db_default/v4/nts/run/2']

machine_expected_response[1] = machines_expected_response[1].copy()
machine_expected_response[1][u'runs'] = [u'/api/db_default/v4/nts/run/3',
                                         u'/api/db_default/v4/nts/run/5',
                                         u'/api/db_default/v4/nts/run/6',
                                         u'/api/db_default/v4/nts/run/7',
                                         u'/api/db_default/v4/nts/run/8',
                                         u'/api/db_default/v4/nts/run/9']

machine_expected_response[2] = machines_expected_response[2].copy()
machine_expected_response[2][u'runs'] = [u'/api/db_default/v4/nts/run/4']


run_expected_response = [{u'end_time': u'2012-04-11T16:28:58',
                          u'id': 1,
                          u'machine_id': 1,
                          u'machine': u'/api/db_default/v4/nts/machine/1',
                          u'order_id': 1,
                          u'order': u'/api/db_default/v4/nts/order/1',
                          u'start_time': u'2012-04-11T16:28:23'}]

order_expected_response = {u'id': 1,
                           u'llvm_project_revision': "154331",
                           u'next_order_id': 0,
                           u'previous_order_id': 2}

graph_data = [[152292, 1.0,
               {u'date': u'2012-05-01 16:28:23', u'label': u'152292'}],
              [152293, 10.0,
               {u'date': u'2012-05-03 16:28:24', u'label': u'152293'}]]


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
        for i in xrange(0, len(machine_expected_response)):
            j = check_json(client, 'api/db_default/v4/nts/machine/' +
                           str(i + 1))
            self.assertEquals(j, machine_expected_response[i])

    def test_run_api(self):
        """Check /run/n returns expected run information."""
        client = self.client
        j = check_json(client, 'api/db_default/v4/nts/run/1')
        self.assertEquals(j, run_expected_response[0])

        for i in xrange(0, len(run_expected_response)):
            j = check_json(client, 'api/db_default/v4/nts/run/' + str(i + 1))
            self.assertEquals(j, run_expected_response[i])

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

if __name__ == '__main__':
    unittest.main(argv=[sys.argv[0], ])

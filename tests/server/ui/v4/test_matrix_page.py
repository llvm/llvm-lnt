# Check that the LNT REST JSON API is working.
# create temporary instance
# RUN: rm -rf %t.instance
# RUN: %{utils}/with_postgres.sh %t.pg.log \
# RUN:     %{utils}/with_temporary_instance.py %t.instance \
# RUN:         %{shared_inputs}/base-reports \
# RUN:         %{shared_inputs}/extra-reports \
# RUN:         -- python %s %t.instance %{tidylib}

import unittest
import logging
import sys

import lnt.server.db.migrate
import lnt.server.ui.app

from V4Pages import check_code, check_html, check_json
from V4Pages import HTTP_REDIRECT, HTTP_BAD_REQUEST, HTTP_NOT_FOUND
logging.basicConfig(level=logging.DEBUG)


class MatrixViewTester(unittest.TestCase):
    """Test the Matrix view."""

    def setUp(self):
        """Bind to the LNT test instance."""
        instance_path = sys.argv[1]
        app = lnt.server.ui.app.App.create_standalone(instance_path)
        app.testing = True
        app.config['WTF_CSRF_ENABLED'] = False
        self.client = app.test_client()

        # Build ID maps.
        client = self.client
        j = check_json(client, 'api/db_default/v4/nts/machines/')
        machines_by_name = {m['name']: m['id'] for m in j['machines']}
        self.machine1_id = machines_by_name['localhost__clang_DEV__x86_64']
        self.machine2_id = machines_by_name['machine2']

        tests_j = check_json(client, 'api/db_default/v4/nts/tests')
        self.tests_by_name = {t['name']: t['id'] for t in tests_j['tests']}

        # Get an order ID from machine2's runs (for baseline promotion).
        m2_data = check_json(
            client, f'api/db_default/v4/nts/machines/{self.machine2_id}')
        first_run = m2_data['runs'][0]
        run_detail = check_json(
            client, f"api/db_default/v4/nts/runs/{first_run['id']}")
        self.order_id = run_detail['run']['order_id']

    def test_config_errors(self):
        """Does passing bad arguments to matrix view error correctly.
        """
        client = self.client
        m1 = self.machine1_id
        t1 = self.tests_by_name['SingleSource/UnitTests/2006-12-01-float_varg']

        reply = check_code(client, '/v4/nts/matrix',
                           expected_code=HTTP_NOT_FOUND)
        self.assertIn("Request requires some plot arguments.",
                      reply.get_data(as_text=True))

        reply = check_code(client,
                           f'/v4/nts/matrix?plot.0={m1}.{t1}.1',
                           expected_code=HTTP_NOT_FOUND)
        self.assertIn("No orders found.", reply.get_data(as_text=True))

        reply = check_code(client, '/v4/nts/matrix?plot.0=a.2.0',
                           expected_code=HTTP_BAD_REQUEST)
        self.assertIn("malformed", reply.get_data(as_text=True))

        reply = check_code(client, '/v4/nts/matrix?plot.0=999.0.0',
                           expected_code=HTTP_NOT_FOUND)
        self.assertIn("Invalid machine", reply.get_data(as_text=True))
        reply = check_code(client,
                           f'/v4/nts/matrix?plot.0={m1}.999.0',
                           expected_code=HTTP_NOT_FOUND)
        self.assertIn("Invalid test", reply.get_data(as_text=True))
        reply = check_code(client,
                           f'/v4/nts/matrix?plot.0={m1}.{t1}.999',
                           expected_code=HTTP_NOT_FOUND)
        self.assertIn("Invalid field", reply.get_data(as_text=True))

    def test_matrix_view(self):
        """Does the page load with the data as expected.
        """
        client = self.client
        m2 = self.machine2_id
        test6 = self.tests_by_name['test6']
        plot_spec = f'{m2}.{test6}.2'

        reply = check_html(client, f'/v4/nts/matrix?plot.0={plot_spec}')
        # Set a baseline and run again.
        form_data = dict(name="foo_baseline",
                         description="foo_description",
                         prmote=True)
        rc = client.post(f'/v4/nts/order/{self.order_id}',
                         data=form_data)
        self.assertEqual(rc.status_code, HTTP_REDIRECT)
        check_code(client, '/v4/nts/set_baseline/1',
                   expected_code=HTTP_REDIRECT)

        reply = check_html(client, f'/v4/nts/matrix?plot.0={plot_spec}')
        # Make sure the data is in the page.
        data = reply.get_data(as_text=True)
        self.assertIn("test6", data)
        self.assertIn("1.0000", data)
        self.assertIn("1.2000", data)

        reply = check_html(client,
                           f'/v4/nts/matrix?plot.0={plot_spec}&limit=1')


if __name__ == '__main__':
    unittest.main(argv=[sys.argv[0], ])

# Check that the LNT REST JSON API is working.
# create temporary instance
# RUN: rm -rf %t.instance
# RUN: python %{shared_inputs}/create_temp_instance.py \
# RUN:     %s %{shared_inputs}/SmallInstance \
# RUN:     %t.instance %S/Inputs/V4Pages_extra_records.sql
#
# RUN: python %s %t.instance %{tidylib}

import unittest
import logging
import sys

import lnt.server.db.migrate
import lnt.server.ui.app

from V4Pages import check_json, check_code, check_html
from V4Pages import HTTP_REDIRECT, HTTP_OK, HTTP_BAD_REQUEST, HTTP_NOT_FOUND
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

    def test_config_errors(self):
        """Does passing bad arguments to matrix view error correctly.
        """
        client = self.client
        reply = check_code(client, '/v4/nts/matrix',
                           expected_code=HTTP_NOT_FOUND)
        self.assertIn("Request requires some data arguments.", reply.data)

        reply = check_code(client, '/v4/nts/matrix?plot.0=1.1.1',
                           expected_code=HTTP_NOT_FOUND)
        self.assertIn("No data found.", reply.data)
        
        reply = check_code(client, '/v4/nts/matrix?plot.0=a.2.0',
                           expected_code=HTTP_BAD_REQUEST)
        self.assertIn("malformed", reply.data)

        reply = check_code(client, '/v4/nts/matrix?plot.0=999.0.0',
                           expected_code=HTTP_NOT_FOUND)
        self.assertIn("Invalid machine", reply.data)
        reply = check_code(client, '/v4/nts/matrix?plot.0=1.999.0',
                           expected_code=HTTP_NOT_FOUND)
        self.assertIn("Invalid test", reply.data)
        reply = check_code(client, '/v4/nts/matrix?plot.0=1.1.999',
                           expected_code=HTTP_NOT_FOUND)
        self.assertIn("Invalid field", reply.data)

    def test_matrix_view(self):
        """Does the page load with the data as expected.
        """
        client = self.client
        reply = check_html(client, '/v4/nts/matrix?plot.0=2.6.2')
        # Set a baseline and run again.
        form_data = dict(name="foo_baseline",
                         description="foo_description",
                         prmote=True)
        rc = client.post('/v4/nts/order/6', data=form_data)
        self.assertEquals(rc.status_code, HTTP_REDIRECT)
        check_code(client, '/v4/nts/set_baseline/1',
                   expected_code=HTTP_REDIRECT)

        reply = check_html(client, '/v4/nts/matrix?plot.0=2.6.2')
        # Make sure the data is in the page.
        self.assertIn("test6", reply.data)
        self.assertIn("1.0000", reply.data)
        self.assertIn("1.2000", reply.data)

        reply = check_html(client, '/v4/nts/matrix?plot.0=2.6.2&limit=1')


if __name__ == '__main__':
    unittest.main(argv=[sys.argv[0], ])

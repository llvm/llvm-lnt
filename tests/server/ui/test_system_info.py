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

from V4Pages import check_html
from V4Pages import HTTP_OK
logging.basicConfig(level=logging.DEBUG)


class SystemInfoTester(unittest.TestCase):
    """Test the system info views."""

    def setUp(self):
        """Bind to the LNT test instance."""
        instance_path = sys.argv[1]
        app = lnt.server.ui.app.App.create_standalone(instance_path)
        app.testing = True
        app.config['WTF_CSRF_ENABLED'] = False
        self.client = app.test_client()

    def test_profile_view(self):
        """Does the page load without crashing the server?
        """
        check_html(self.client, '/profile/admin', expected_code=HTTP_OK)


if __name__ == '__main__':
    unittest.main(argv=[sys.argv[0], ])

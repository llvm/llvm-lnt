# Tests for the v5 API ETag utilities.
#
# RUN: rm -rf %t.instance %t.pg.log
# RUN: %{utils}/with_postgres.sh %t.pg.log \
# RUN:     %{utils}/with_temporary_instance.py --db-version 5.0 %t.instance \
# RUN:         -- python %s %t.instance
# END.

import sys
import os
import unittest

sys.path.insert(0, os.path.dirname(__file__))
from v5_test_helpers import create_app, create_client

from lnt.server.api.v5.etag import compute_etag


class TestComputeETag(unittest.TestCase):
    def test_deterministic(self):
        data = {'key': 'value', 'number': 42}
        self.assertEqual(compute_etag(data), compute_etag(data))

    def test_weak_etag_format(self):
        etag = compute_etag({'a': 1})
        self.assertTrue(etag.startswith('W/"'))
        self.assertTrue(etag.endswith('"'))

    def test_different_data_different_etag(self):
        e1 = compute_etag({'a': 1})
        e2 = compute_etag({'a': 2})
        self.assertNotEqual(e1, e2)

    def test_order_independent(self):
        """Sort keys ensures order independence."""
        e1 = compute_etag({'a': 1, 'b': 2})
        e2 = compute_etag({'b': 2, 'a': 1})
        self.assertEqual(e1, e2)

    def test_empty_dict(self):
        etag = compute_etag({})
        self.assertTrue(etag.startswith('W/"'))

    def test_empty_list(self):
        etag = compute_etag([])
        self.assertTrue(etag.startswith('W/"'))


class TestETagOnEndpoints(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.app = create_app(sys.argv[1])
        cls.client = create_client(cls.app)

    def test_machines_endpoint_returns_200(self):
        """A GET to /machines should succeed (ETags are applied to detail
        endpoints, not lists)."""
        resp = self.client.get('/api/v5/nts/machines')
        self.assertEqual(resp.status_code, 200)

    def test_test_suite_detail_returns_200(self):
        """Test suite detail endpoint returns metadata."""
        resp = self.client.get('/api/v5/test-suites/nts')
        self.assertEqual(resp.status_code, 200)


if __name__ == '__main__':
    unittest.main(argv=[sys.argv[0]], exit=True)

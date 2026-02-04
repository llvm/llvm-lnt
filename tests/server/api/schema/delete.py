# This test checks the /schema DELETE API that allows removing a schema.

# RUN: rm -rf %t.instance
# RUN: python %{shared_inputs}/create_temp_instance.py \
# RUN:     %s %{shared_inputs}/SmallInstance \
# RUN:     %t.instance %S/../../ui/Inputs/V4Pages_extra_records.sql
#
# RUN: python %s %t.instance
# END.

import json
import logging
import sys
import unittest
import lnt.server.ui.app

logging.basicConfig(level=logging.INFO)


class SchemaDeleteApiTest(unittest.TestCase):
    """Test DELETE /schema endpoint for schema removal."""

    def setUp(self):
        _, instance_path = sys.argv
        app = lnt.server.ui.app.App.create_standalone(instance_path)
        app.testing = True
        self.client = app.test_client()

    def _schema_payload(self, name):
        return f"""
format_version: '2'
name: {name}
metrics:
- name: execution_time
  type: Real
  unit: seconds
run_fields:
- name: build_revision
  order: true
machine_fields:
- name: hardware
"""

    def _post_schema(self, name):
        payload = self._schema_payload(name)
        return self.client.post(
            f"api/db_default/v4/{name}/schema",
            data=payload,
            content_type="application/x-yaml",
            headers={"AuthToken": "test_token"},
        )

    def test_delete_requires_auth(self):
        resp = self._post_schema("schema_delete_suite")
        self.assertEqual(resp.status_code, 201, resp.data.decode("utf-8"))

        resp = self.client.delete(
            "api/db_default/v4/schema_delete_suite/schema",
        )
        self.assertEqual(resp.status_code, 401)

    def test_delete_schema_success(self):
        resp = self._post_schema("schema_delete_suite")
        self.assertEqual(resp.status_code, 201, resp.data.decode("utf-8"))

        resp = self.client.delete(
            "api/db_default/v4/schema_delete_suite/schema",
            headers={"AuthToken": "test_token"},
        )
        self.assertEqual(resp.status_code, 200, resp.data.decode("utf-8"))
        result = json.loads(resp.data)
        self.assertEqual(result["testsuite"], "schema_delete_suite")
        self.assertTrue(result.get("deleted"))

        resp = self.client.get("api/db_default/v4/schema_delete_suite/schema")
        self.assertEqual(resp.status_code, 404)

    def test_delete_unknown_suite(self):
        resp = self.client.delete(
            "api/db_default/v4/does_not_exist/schema",
            headers={"AuthToken": "test_token"},
        )
        self.assertEqual(resp.status_code, 404)

    def test_delete_default_nts_suite(self):
        resp = self.client.delete(
            "api/db_default/v4/nts/schema",
            headers={"AuthToken": "test_token"},
        )
        self.assertEqual(resp.status_code, 200, resp.data.decode("utf-8"))
        result = json.loads(resp.data)
        self.assertEqual(result["testsuite"], "nts")
        self.assertTrue(result.get("deleted"))

        resp = self.client.get("api/db_default/v4/nts/schema")
        self.assertEqual(resp.status_code, 404)


if __name__ == "__main__":
    unittest.main(argv=[sys.argv[0], ])

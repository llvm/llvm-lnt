# This test checks the /schema POST API that allows creating a new schema.

# RUN: rm -rf %t.instance
# RUN: python %{shared_inputs}/create_temp_instance.py \
# RUN:     %s %{shared_inputs}/SmallInstance \
# RUN:     %t.instance %S/../../ui/Inputs/V4Pages_extra_records.sql
#
# RUN: python %s %t.instance
# END.

import json
import logging
import os
import sys
import unittest

TESTS_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
UI_DIR = os.path.join(TESTS_DIR, 'ui')
sys.path.insert(0, UI_DIR)

import lnt.server.ui.app
from V4Pages import check_json

logging.basicConfig(level=logging.INFO)


class SchemaApiTest(unittest.TestCase):
    """Test POST /schema endpoint for schema uploads."""

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

    def test_post_requires_auth(self):
        payload = self._schema_payload("schema_test_suite")
        resp = self.client.post(
            "api/db_default/v4/schema_test_suite/schema",
            data=payload,
            content_type="application/x-yaml",
        )
        self.assertEqual(resp.status_code, 401)

    def test_post_schema_success(self):
        payload = self._schema_payload("schema_test_suite")
        resp = self.client.post(
            "api/db_default/v4/schema_test_suite/schema",
            data=payload,
            content_type="application/x-yaml",
            headers={"AuthToken": "test_token"},
        )
        self.assertEqual(resp.status_code, 201, resp.data.decode("utf-8"))
        result = json.loads(resp.data)
        self.assertEqual(result["testsuite"], "schema_test_suite")

        schema = check_json(self.client,
                            "api/db_default/v4/schema_test_suite/schema")
        self.assertEqual(schema["name"], "schema_test_suite")

    def test_post_schema_name_mismatch(self):
        payload = self._schema_payload("mismatch_suite")
        resp = self.client.post(
            "api/db_default/v4/schema_test_suite/schema",
            data=payload,
            content_type="application/x-yaml",
            headers={"AuthToken": "test_token"},
        )
        self.assertEqual(resp.status_code, 400)

    def test_post_schema_invalid_name(self):
        payload = self._schema_payload("bad-name")
        resp = self.client.post(
            "api/db_default/v4/bad-name/schema",
            data=payload,
            content_type="application/x-yaml",
            headers={"AuthToken": "test_token"},
        )
        self.assertEqual(resp.status_code, 400)
        result = json.loads(resp.data)
        self.assertIn("Invalid test suite name", result.get("msg", ""))

    def test_post_schema_invalid_name_prefixes(self):
        for suite_name in ("1test", "_test"):
            payload = self._schema_payload(suite_name)
            resp = self.client.post(
                f"api/db_default/v4/{suite_name}/schema",
                data=payload,
                content_type="application/x-yaml",
                headers={"AuthToken": "test_token"},
            )
            self.assertEqual(resp.status_code, 400)
            result = json.loads(resp.data)
            self.assertIn("Invalid test suite name", result.get("msg", ""))

    def test_post_schema_empty_name(self):
        payload = self._schema_payload("\"\"")
        resp = self.client.post(
            "api/db_default/v4/empty_name/schema",
            data=payload,
            content_type="application/x-yaml",
            headers={"AuthToken": "test_token"},
        )
        self.assertEqual(resp.status_code, 400)
        result = json.loads(resp.data)
        self.assertIn("Schema payload missing 'name'", result.get("msg", ""))

    def test_post_unsupported_content_type(self):
        payload = self._schema_payload("schema_test_suite")
        resp = self.client.post(
            "api/db_default/v4/schema_test_suite/schema",
            data=json.dumps(payload),
            content_type="application/json",
            headers={"AuthToken": "test_token"},
        )
        self.assertEqual(resp.status_code, 415)


if __name__ == "__main__":
    unittest.main(argv=[sys.argv[0], ])

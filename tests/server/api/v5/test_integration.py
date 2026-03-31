# End-to-end integration tests for the v5 REST API.
#
# These tests exercise multi-endpoint workflows to verify that the
# endpoints work together correctly, unlike the per-endpoint unit tests.
#
# RUN: rm -rf %t.instance %t.pg.log
# RUN: %{utils}/with_postgres.sh %t.pg.log \
# RUN:     %{utils}/with_temporary_instance.py %t.instance \
# RUN:         -- python %s %t.instance
# END.

import json
import sys
import os
import unittest
import uuid

sys.path.insert(0, os.path.dirname(__file__))
from v5_test_helpers import create_app, create_client, admin_headers


TS = 'nts'
PREFIX = f'/api/v5/{TS}'


def _make_submission_payload(machine_name=None, revision=None,
                             tests=None):
    """Build a valid v2-format JSON submission payload."""
    if machine_name is None:
        machine_name = f'integ-machine-{uuid.uuid4().hex[:8]}'
    if revision is None:
        revision = f'r{uuid.uuid4().hex[:8]}'
    if tests is None:
        tests = [
            {
                'name': 'test.suite/benchmark1',
                'execution_time': [0.1234, 0.1235],
            },
            {
                'name': 'test.suite/benchmark2',
                'compile_time': 13.12,
                'execution_time': 0.2135,
            },
        ]

    return json.dumps({
        'format_version': '2',
        'machine': {
            'name': machine_name,
        },
        'run': {
            'start_time': '2024-06-15T10:00:00',
            'end_time': '2024-06-15T10:30:00',
            'llvm_project_revision': revision,
        },
        'tests': tests,
    })


# -----------------------------------------------------------------------
# 1. TestRunSubmissionWorkflow
# -----------------------------------------------------------------------

class TestRunSubmissionWorkflow(unittest.TestCase):
    """Submit a run, then verify it via multiple GET endpoints.

    This workflow exercises:
      POST   /runs              (submit)
      GET    /runs              (list)
      GET    /runs/{uuid}       (detail)
      GET    /runs/{uuid}/samples  (samples)
      GET    /machines          (implicit machine creation)
      GET    /tests             (implicit test creation)
    """

    app = None
    client = None

    # Shared state populated by setUpClass
    _machine_name = None
    _revision = None
    _run_uuid = None

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.app = create_app(sys.argv[1])
        cls.client = create_client(cls.app)
        cls._machine_name = f'submit-wf-{uuid.uuid4().hex[:8]}'
        cls._revision = f'r{uuid.uuid4().hex[:8]}'
        payload = _make_submission_payload(
            machine_name=cls._machine_name,
            revision=cls._revision,
        )
        resp = cls.client.post(
            PREFIX + '/runs',
            data=payload,
            content_type='application/json',
            headers=admin_headers(),
        )
        data = resp.get_json()
        cls._run_uuid = data.get('run_uuid')

    def test_01_submission_succeeded(self):
        """The run submission should have returned a valid UUID."""
        self.assertIsNotNone(
            self._run_uuid,
            "Run submission did not return a run_uuid")
        uuid.UUID(self._run_uuid, version=4)

    def test_02_run_appears_in_list(self):
        """The submitted run appears in the run list endpoint."""
        resp = self.client.get(
            PREFIX + f'/runs?machine={self._machine_name}')
        self.assertEqual(resp.status_code, 200,
                         f"GET /runs returned {resp.status_code}")
        data = resp.get_json()
        uuids = [item['uuid'] for item in data['items']]
        self.assertIn(self._run_uuid, uuids,
                      "Submitted run not found in run list")

    def test_03_run_detail_is_correct(self):
        """GET /runs/{uuid} returns the expected detail."""
        resp = self.client.get(PREFIX + f'/runs/{self._run_uuid}')
        self.assertEqual(resp.status_code, 200,
                         f"GET /runs/{uuid} returned {resp.status_code}")
        data = resp.get_json()
        self.assertEqual(data['uuid'], self._run_uuid,
                         "Run detail UUID mismatch")
        self.assertEqual(data['machine'], self._machine_name,
                         "Run detail machine name mismatch")
        self.assertIn('order', data,
                      "Run detail missing 'order'")
        self.assertEqual(
            data['order'].get('llvm_project_revision'), self._revision,
            "Run detail order revision mismatch")
        self.assertIn('start_time', data)
        self.assertIn('end_time', data)

    def test_04_run_samples_returned(self):
        """GET /runs/{uuid}/samples returns the submitted samples."""
        resp = self.client.get(
            PREFIX + f'/runs/{self._run_uuid}/samples')
        self.assertEqual(resp.status_code, 200,
                         f"GET /runs/{uuid}/samples returned {resp.status_code}")
        data = resp.get_json()
        self.assertIn('items', data,
                      "Samples response missing 'items'")
        # We submitted 2 tests, each with samples. The import pipeline
        # creates one Sample row per (run, test, repetition) combination.
        # benchmark1 has 2 execution_time values, benchmark2 has 1.
        self.assertGreater(len(data['items']), 0,
                           "No samples returned for the submitted run")

        test_names = [s['test'] for s in data['items']]
        # The import pipeline may prefix test names with the suite name.
        has_benchmark1 = any('benchmark1' in n for n in test_names)
        has_benchmark2 = any('benchmark2' in n for n in test_names)
        self.assertTrue(has_benchmark1,
                        f"benchmark1 not found in samples: {test_names}")
        self.assertTrue(has_benchmark2,
                        f"benchmark2 not found in samples: {test_names}")

    def test_05_machine_created_implicitly(self):
        """The machine is implicitly created by the run submission."""
        resp = self.client.get(
            PREFIX + f'/machines/{self._machine_name}')
        self.assertEqual(resp.status_code, 200,
                         f"Machine '{self._machine_name}' not found after run submission")
        data = resp.get_json()
        self.assertEqual(data['name'], self._machine_name)

    def test_06_tests_created_implicitly(self):
        """The test entities are implicitly created by the run submission."""
        resp = self.client.get(
            PREFIX + '/tests?name_contains=benchmark1')
        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        names = [t['name'] for t in data['items']]
        has_benchmark1 = any('benchmark1' in n for n in names)
        self.assertTrue(has_benchmark1,
                        f"benchmark1 test not found in tests list: {names}")


# -----------------------------------------------------------------------
# 2. TestAPIKeyLifecycle
# -----------------------------------------------------------------------

class TestAPIKeyLifecycle(unittest.TestCase):
    """Create an API key, use it, revoke it, verify rejection.

    This workflow exercises:
      POST   /admin/api-keys                 (create key)
      GET    /api/v5/                        (read with new key)
      POST   /runs                           (submit with new key)
      DELETE /admin/api-keys/{prefix}        (revoke key)
      GET    /admin/api-keys                 (verify 401 after revocation)
    """

    app = None
    client = None

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.app = create_app(sys.argv[1])
        cls.client = create_client(cls.app)

    def test_api_key_full_lifecycle(self):
        """Create, use, revoke, and verify rejection of an API key."""
        # Step 1: Create a submit-scoped key via admin endpoint
        create_resp = self.client.post(
            '/api/v5/admin/api-keys',
            json={'name': 'lifecycle-key', 'scope': 'submit'},
            headers=admin_headers(),
        )
        self.assertEqual(create_resp.status_code, 201,
                         f"Failed to create API key: {create_resp.get_data(as_text=True)}")
        created = create_resp.get_json()
        raw_token = created['key']
        prefix = created['prefix']
        key_headers = {'Authorization': f'Bearer {raw_token}'}

        # Step 2: Use the new key on a read endpoint -- should succeed
        read_resp = self.client.get('/api/v5/', headers=key_headers)
        self.assertEqual(read_resp.status_code, 200,
                         "New submit key cannot read discovery endpoint")

        # Step 3: Use the new key to submit a run (within its scope)
        payload = _make_submission_payload()
        submit_resp = self.client.post(
            PREFIX + '/runs',
            data=payload,
            content_type='application/json',
            headers=key_headers,
        )
        self.assertIn(submit_resp.status_code, [201, 301],
                      "Submit-scoped key failed to submit a run: %d"
                      % submit_resp.status_code)

        # Step 4: Revoke the key
        revoke_resp = self.client.delete(
            f'/api/v5/admin/api-keys/{prefix}',
            headers=admin_headers(),
        )
        self.assertEqual(revoke_resp.status_code, 204,
                         "Failed to revoke API key")

        # Step 5: Using the revoked key on an admin endpoint yields 401
        # (admin endpoints require auth, revoked key is inactive)
        reject_resp = self.client.get(
            '/api/v5/admin/api-keys', headers=key_headers)
        self.assertEqual(reject_resp.status_code, 401,
                         "Revoked key was not rejected: got %d"
                         % reject_resp.status_code)


# -----------------------------------------------------------------------
# 3. TestMachineCRUDWorkflow
# -----------------------------------------------------------------------

class TestMachineCRUDWorkflow(unittest.TestCase):
    """Create, submit runs, rename, and delete a machine.

    This workflow exercises:
      POST   /machines                      (create)
      POST   /runs                          (submit run to machine)
      GET    /machines/{name}/runs          (list runs)
      PATCH  /machines/{name}               (rename)
      GET    /machines/{old_name}           (verify 404)
      GET    /machines/{new_name}           (verify accessible)
      DELETE /machines/{name}               (delete with cascade)
    """

    app = None
    client = None

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.app = create_app(sys.argv[1])
        cls.client = create_client(cls.app)

    def test_machine_crud_workflow(self):
        """Full create-update-delete lifecycle for a machine."""
        original_name = f'crud-machine-{uuid.uuid4().hex[:8]}'
        new_name = f'crud-renamed-{uuid.uuid4().hex[:8]}'

        # Step 1: Create a machine explicitly
        create_resp = self.client.post(
            PREFIX + '/machines',
            json={'name': original_name, 'info': {'os': 'linux'}},
            headers=admin_headers(),
        )
        self.assertEqual(create_resp.status_code, 201,
                         f"Failed to create machine: {create_resp.get_data(as_text=True)}")
        self.assertEqual(create_resp.get_json()['name'], original_name)

        # Step 2: Submit a run to this machine
        payload = _make_submission_payload(machine_name=original_name)
        submit_resp = self.client.post(
            PREFIX + '/runs',
            data=payload,
            content_type='application/json',
            headers=admin_headers(),
        )
        submit_data = submit_resp.get_json()
        run_uuid = submit_data.get('run_uuid')
        self.assertIsNotNone(run_uuid,
                             "Run submission did not return a run_uuid")

        # Step 3: List the machine's runs
        runs_resp = self.client.get(
            PREFIX + f'/machines/{original_name}/runs')
        self.assertEqual(runs_resp.status_code, 200)
        runs_data = runs_resp.get_json()
        run_uuids = [r['uuid'] for r in runs_data['items']]
        self.assertIn(run_uuid, run_uuids,
                      "Submitted run not in machine runs list")

        # Step 4: Rename the machine
        rename_resp = self.client.patch(
            PREFIX + f'/machines/{original_name}',
            json={'name': new_name},
            headers=admin_headers(),
        )
        self.assertEqual(rename_resp.status_code, 200,
                         f"Rename failed: {rename_resp.get_data(as_text=True)}")
        self.assertEqual(rename_resp.get_json()['name'], new_name)
        location = rename_resp.headers.get('Location')
        self.assertIsNotNone(location,
                             "Rename did not return Location header")
        self.assertIn(new_name, location)

        # Step 5: Old name returns 404
        old_resp = self.client.get(
            PREFIX + f'/machines/{original_name}')
        self.assertEqual(old_resp.status_code, 404,
                         "Old machine name still accessible: %d"
                         % old_resp.status_code)

        # Step 6: New name returns the machine
        new_resp = self.client.get(
            PREFIX + f'/machines/{new_name}')
        self.assertEqual(new_resp.status_code, 200,
                         "New machine name not accessible")
        self.assertEqual(new_resp.get_json()['name'], new_name)

        # Step 7: Runs are still accessible under the renamed machine
        runs_resp2 = self.client.get(
            PREFIX + f'/machines/{new_name}/runs')
        self.assertEqual(runs_resp2.status_code, 200)
        run_uuids2 = [r['uuid'] for r in runs_resp2.get_json()['items']]
        self.assertIn(run_uuid, run_uuids2,
                      "Run missing after machine rename")

        # Step 8: Delete the machine (cascading)
        delete_resp = self.client.delete(
            PREFIX + f'/machines/{new_name}',
            headers=admin_headers(),
        )
        self.assertEqual(delete_resp.status_code, 204,
                         f"Delete failed: {delete_resp.status_code}")

        # Step 9: Machine is gone
        gone_resp = self.client.get(
            PREFIX + f'/machines/{new_name}')
        self.assertEqual(gone_resp.status_code, 404,
                         "Machine still found after deletion")

        # Step 10: The run is also gone (cascading delete)
        run_resp = self.client.get(PREFIX + f'/runs/{run_uuid}')
        self.assertEqual(run_resp.status_code, 404,
                         "Run still exists after machine deletion")


# -----------------------------------------------------------------------
# 4. TestDiscoveryNavigability
# -----------------------------------------------------------------------

class TestDiscoveryNavigability(unittest.TestCase):
    """Follow every link from the discovery endpoint and verify 200.

    This workflow exercises:
      GET    /api/v5/                        (discovery)
      GET    each link in the discovery response
    """

    app = None
    client = None

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.app = create_app(sys.argv[1])
        cls.client = create_client(cls.app)

    def test_all_discovery_links_resolve(self):
        """Every link in the discovery response should return 200."""
        disco_resp = self.client.get('/api/v5/')
        self.assertEqual(disco_resp.status_code, 200,
                         "Discovery endpoint returned %d"
                         % disco_resp.status_code)
        data = disco_resp.get_json()

        self.assertIn('test_suites', data)
        self.assertGreater(len(data['test_suites']), 0,
                           "No test suites in discovery response")

        for suite in data['test_suites']:
            self.assertIn('name', suite)
            self.assertIn('links', suite)
            suite_name = suite['name']

            for link_name, url in suite['links'].items():
                # The /query endpoint requires a mandatory 'metric'
                # parameter, so a bare GET returns 422 by design.
                # Skip it in the navigability check.
                if link_name == 'query':
                    continue
                resp = self.client.get(url)
                self.assertEqual(
                    resp.status_code, 200,
                    f"Link '{link_name}' ({url}) for suite '{suite_name}' "
                    f"returned {resp.status_code}")

    def test_discovery_nts_suite_has_all_expected_links(self):
        """The 'nts' suite should have all the expected resource links."""
        disco_resp = self.client.get('/api/v5/')
        data = disco_resp.get_json()

        nts_suites = [s for s in data['test_suites'] if s['name'] == 'nts']
        self.assertEqual(len(nts_suites), 1,
                         "Expected exactly one 'nts' suite")
        links = nts_suites[0]['links']

        expected_keys = {
            'machines', 'orders', 'runs', 'tests',
            'regressions', 'field_changes', 'query',
        }
        self.assertEqual(set(links.keys()), expected_keys,
                         "Discovery links mismatch")


# -----------------------------------------------------------------------
# 6. TestCORSOnAllEndpoints
# -----------------------------------------------------------------------

class TestCORSOnAllEndpoints(unittest.TestCase):
    """Verify CORS headers are present on various endpoint types.

    This workflow exercises the CORS middleware across:
      GET    /api/v5/                (discovery)
      GET    /api/v5/{ts}/machines   (list)
      GET    /api/v5/{ts}/runs       (list)
      POST   /api/v5/{ts}/runs       (write)
      DELETE /api/v5/{ts}/machines/nonexistent (error response)
    """

    app = None
    client = None

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.app = create_app(sys.argv[1])
        cls.client = create_client(cls.app)

    def _assert_cors(self, resp, context):
        """Assert that the CORS allow-origin header is present."""
        self.assertEqual(
            resp.headers.get('Access-Control-Allow-Origin'), '*',
            f"Missing CORS header on {context} (status {resp.status_code})")

    def test_cors_on_discovery(self):
        """CORS header on GET /api/v5/."""
        resp = self.client.get('/api/v5/')
        self._assert_cors(resp, 'GET /api/v5/')

    def test_cors_on_machine_list(self):
        """CORS header on GET /machines."""
        resp = self.client.get(PREFIX + '/machines')
        self._assert_cors(resp, 'GET /machines')

    def test_cors_on_run_list(self):
        """CORS header on GET /runs."""
        resp = self.client.get(PREFIX + '/runs')
        self._assert_cors(resp, 'GET /runs')

    def test_cors_on_run_submit(self):
        """CORS header on POST /runs."""
        payload = _make_submission_payload()
        resp = self.client.post(
            PREFIX + '/runs',
            data=payload,
            content_type='application/json',
            headers=admin_headers(),
        )
        self._assert_cors(resp, 'POST /runs')

    def test_cors_on_error_response(self):
        """CORS header present even on 404 error responses."""
        resp = self.client.get(
            PREFIX + '/machines/nonexistent-cors-test-xyz')
        self.assertEqual(resp.status_code, 404)
        self._assert_cors(resp, 'GET /machines/nonexistent (404)')

    def test_cors_on_delete_error(self):
        """CORS header present on 401 (unauthenticated DELETE)."""
        resp = self.client.delete(
            PREFIX + '/machines/nonexistent-cors-del')
        # Should be 401 (no auth) -- but we care about the header
        self._assert_cors(resp, 'DELETE /machines/nonexistent (no auth)')

    def test_cors_on_options_preflight(self):
        """OPTIONS preflight request returns proper CORS headers."""
        resp = self.client.options(
            PREFIX + '/machines',
            headers={
                'Origin': 'https://example.com',
                'Access-Control-Request-Method': 'GET',
            },
        )
        self._assert_cors(resp, 'OPTIONS /machines')
        # Verify the Allow-Methods and Allow-Headers are present
        self.assertIn(
            'GET',
            resp.headers.get('Access-Control-Allow-Methods', ''),
            "OPTIONS response missing GET in Allow-Methods")
        self.assertIn(
            'Authorization',
            resp.headers.get('Access-Control-Allow-Headers', ''),
            "OPTIONS response missing Authorization in Allow-Headers")


if __name__ == '__main__':
    unittest.main(argv=[sys.argv[0]], exit=True)

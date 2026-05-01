# Tests for the v5 profile endpoints.
#
# RUN: rm -rf %t.instance %t.pg.log
# RUN: %{utils}/with_postgres.sh %t.pg.log \
# RUN:     %{utils}/with_temporary_instance.py --db-version 5.0 %t.instance \
# RUN:         -- python %s %t.instance
# END.

import os
import sys
import unittest
import uuid

sys.path.insert(0, os.path.dirname(__file__))
from v5_test_helpers import (  # noqa: E402
    create_app, create_client, admin_headers, make_scoped_headers,
    submit_run, make_profile_base64,
)

TS = 'nts'
PREFIX = f'/api/v5/{TS}'


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _submit_run_with_profile(client, tag=None):
    """Submit a run with a profiled test.  Returns (run_uuid, test_name)."""
    suffix = tag or uuid.uuid4().hex[:8]
    machine_name = f'prof-machine-{suffix}'
    commit = f'prof-commit-{suffix}'
    test_name = f'test.suite/profiled-{suffix}'
    profile_b64 = make_profile_base64()

    data = submit_run(client, machine_name, commit, [
        {
            'name': test_name,
            'execution_time': 1.23,
            'profile': profile_b64,
        },
    ])
    return data['run_uuid'], test_name


# ---------------------------------------------------------------------------
# Profile listing
# ---------------------------------------------------------------------------

class TestProfileListing(unittest.TestCase):
    """Tests for GET /api/v5/{ts}/runs/{uuid}/profiles."""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.app = create_app(sys.argv[1])
        cls.client = create_client(cls.app)
        cls._run_uuid, cls._test_name = _submit_run_with_profile(
            cls.client, tag='listing')

    def test_list_profiles(self):
        """Run with profile -> listing returns [{test, uuid}]."""
        resp = self.client.get(
            PREFIX + f'/runs/{self._run_uuid}/profiles')
        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        self.assertIsInstance(data, list)
        self.assertEqual(len(data), 1)
        self.assertEqual(data[0]['test'], self._test_name)
        self.assertIn('uuid', data[0])

    def test_list_profiles_empty(self):
        """Run with no profiles -> empty list."""
        data = submit_run(self.client, 'no-prof-machine', 'no-prof-commit', [
            {'name': 'test.suite/no-profile', 'execution_time': 1.0},
        ])
        resp = self.client.get(
            PREFIX + f'/runs/{data["run_uuid"]}/profiles')
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.get_json(), [])

    def test_list_profiles_nonexistent_run(self):
        """Nonexistent run UUID -> 404."""
        resp = self.client.get(
            PREFIX + f'/runs/{uuid.uuid4()}/profiles')
        self.assertEqual(resp.status_code, 404)


# ---------------------------------------------------------------------------
# Profile submission via POST /runs
# ---------------------------------------------------------------------------

class TestProfileSubmission(unittest.TestCase):
    """Tests for profile submission as part of run submission."""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.app = create_app(sys.argv[1])
        cls.client = create_client(cls.app)

    def test_submit_with_profile(self):
        """Profile field in test entry creates a Profile row."""
        run_uuid, test_name = _submit_run_with_profile(
            self.client, tag='submit-ok')
        resp = self.client.get(
            PREFIX + f'/runs/{run_uuid}/profiles')
        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        self.assertEqual(len(data), 1)
        self.assertEqual(data[0]['test'], test_name)

    def test_submit_without_profile(self):
        """No profile field -> no profiles created."""
        data = submit_run(self.client, 'no-prof-m2', 'no-prof-c2', [
            {'name': 'test.suite/noprof2', 'execution_time': 2.0},
        ])
        resp = self.client.get(
            PREFIX + f'/runs/{data["run_uuid"]}/profiles')
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.get_json(), [])

    def test_submit_invalid_base64(self):
        """Invalid base64 in profile -> 400."""
        resp = self.client.post(
            f'/api/v5/{TS}/runs',
            json={
                'format_version': '5',
                'machine': {'name': 'bad-b64-machine'},
                'commit': 'bad-b64-commit',
                'tests': [
                    {'name': 'test.suite/bad-b64', 'profile': '!!!not-base64!!!'},
                ],
            },
            headers=admin_headers(),
        )
        self.assertIn(resp.status_code, (400, 422))

    def test_profile_not_in_sample_metrics(self):
        """The 'profile' key should not appear as a metric in samples."""
        run_uuid, test_name = _submit_run_with_profile(
            self.client, tag='not-in-metric')
        resp = self.client.get(
            PREFIX + f'/runs/{run_uuid}/samples')
        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        for sample in data['items']:
            self.assertNotIn('profile', sample.get('metrics', {}))

    def test_duplicate_profile_for_same_run_test(self):
        """Submitting a second run with the same commit+machine but a
        different profile for the same test should create a separate profile
        (different run).  The unique constraint is per (run_id, test_id),
        not per (commit, test)."""
        suffix = uuid.uuid4().hex[:8]
        machine = f'dup-machine-{suffix}'
        commit = f'dup-commit-{suffix}'
        test_name = f'test.suite/dup-{suffix}'
        profile_b64 = make_profile_base64()

        # Two separate run submissions for the same machine+commit+test
        r1 = submit_run(self.client, machine, commit, [
            {'name': test_name, 'execution_time': 1.0, 'profile': profile_b64},
        ])
        r2 = submit_run(self.client, machine, commit, [
            {'name': test_name, 'execution_time': 2.0, 'profile': profile_b64},
        ])

        # Each run should have its own profile
        resp1 = self.client.get(PREFIX + f'/runs/{r1["run_uuid"]}/profiles')
        resp2 = self.client.get(PREFIX + f'/runs/{r2["run_uuid"]}/profiles')
        self.assertEqual(len(resp1.get_json()), 1)
        self.assertEqual(len(resp2.get_json()), 1)
        # Different profile UUIDs
        self.assertNotEqual(
            resp1.get_json()[0]['uuid'], resp2.get_json()[0]['uuid'])


# ---------------------------------------------------------------------------
# Profile metadata
# ---------------------------------------------------------------------------

class TestProfileMetadata(unittest.TestCase):
    """Tests for GET /api/v5/{ts}/profiles/{uuid}."""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.app = create_app(sys.argv[1])
        cls.client = create_client(cls.app)
        run_uuid, cls._test_name = _submit_run_with_profile(
            cls.client, tag='metadata')
        # Get the profile UUID from the listing
        resp = cls.client.get(PREFIX + f'/runs/{run_uuid}/profiles')
        cls._profile_uuid = resp.get_json()[0]['uuid']
        cls._run_uuid = run_uuid

    def test_metadata(self):
        """Get profile metadata with correct fields."""
        resp = self.client.get(
            PREFIX + f'/profiles/{self._profile_uuid}')
        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        self.assertEqual(data['uuid'], self._profile_uuid)
        self.assertEqual(data['test'], self._test_name)
        self.assertEqual(data['run_uuid'], self._run_uuid)
        self.assertIn('counters', data)
        self.assertEqual(data['counters']['cycles'], 1000)
        self.assertEqual(data['counters']['branch-misses'], 50)
        self.assertEqual(data['disassembly_format'], 'raw')

    def test_metadata_nonexistent_uuid(self):
        """Nonexistent profile UUID -> 404."""
        resp = self.client.get(
            PREFIX + f'/profiles/{uuid.uuid4()}')
        self.assertEqual(resp.status_code, 404)


# ---------------------------------------------------------------------------
# Profile functions
# ---------------------------------------------------------------------------

class TestProfileFunctions(unittest.TestCase):
    """Tests for GET /api/v5/{ts}/profiles/{uuid}/functions."""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.app = create_app(sys.argv[1])
        cls.client = create_client(cls.app)
        run_uuid, _ = _submit_run_with_profile(cls.client, tag='functions')
        resp = cls.client.get(PREFIX + f'/runs/{run_uuid}/profiles')
        cls._profile_uuid = resp.get_json()[0]['uuid']

    def test_function_list(self):
        """Functions endpoint returns sorted list."""
        resp = self.client.get(
            PREFIX + f'/profiles/{self._profile_uuid}/functions')
        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        self.assertIn('functions', data)
        funcs = data['functions']
        self.assertEqual(len(funcs), 2)

        fn_names = [f['name'] for f in funcs]
        self.assertIn('main', fn_names)
        self.assertIn('helper', fn_names)

        # Sorted by total counter value descending (main > helper)
        self.assertEqual(funcs[0]['name'], 'main')

        for fn in funcs:
            self.assertIn('counters', fn)
            self.assertIn('length', fn)
            self.assertIsInstance(fn['counters'], dict)


# ---------------------------------------------------------------------------
# Profile function detail
# ---------------------------------------------------------------------------

class TestProfileFunctionDetail(unittest.TestCase):
    """Tests for GET /api/v5/{ts}/profiles/{uuid}/functions/{fn_name}."""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.app = create_app(sys.argv[1])
        cls.client = create_client(cls.app)
        run_uuid, _ = _submit_run_with_profile(cls.client, tag='fndetail')
        resp = cls.client.get(PREFIX + f'/runs/{run_uuid}/profiles')
        cls._profile_uuid = resp.get_json()[0]['uuid']

    def test_function_detail(self):
        """Get disassembly for a specific function."""
        resp = self.client.get(
            PREFIX + f'/profiles/{self._profile_uuid}/functions/main')
        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        self.assertEqual(data['name'], 'main')
        self.assertIn('counters', data)
        self.assertEqual(data['disassembly_format'], 'raw')
        self.assertIn('instructions', data)
        self.assertEqual(len(data['instructions']), 2)

        inst = data['instructions'][0]
        self.assertIn('address', inst)
        self.assertIn('counters', inst)
        self.assertIn('text', inst)
        self.assertEqual(inst['address'], 0x1000)
        self.assertEqual(inst['text'], 'push rbp')

    def test_function_detail_nonexistent(self):
        """404 for a function not in the profile."""
        resp = self.client.get(
            PREFIX + f'/profiles/{self._profile_uuid}/functions/no_such_fn')
        self.assertEqual(resp.status_code, 404)


# ---------------------------------------------------------------------------
# Auth
# ---------------------------------------------------------------------------

class TestProfileAuth(unittest.TestCase):
    """Auth tests for profile endpoints (all require read scope)."""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.app = create_app(sys.argv[1])
        cls.client = create_client(cls.app)
        run_uuid, _ = _submit_run_with_profile(cls.client, tag='auth')
        resp = cls.client.get(PREFIX + f'/runs/{run_uuid}/profiles')
        cls._profile_uuid = resp.get_json()[0]['uuid']
        cls._run_uuid = run_uuid

    def test_listing_no_auth_allowed(self):
        resp = self.client.get(
            PREFIX + f'/runs/{self._run_uuid}/profiles')
        self.assertEqual(resp.status_code, 200)

    def test_metadata_read_scope(self):
        headers = make_scoped_headers(self.app, 'read')
        resp = self.client.get(
            PREFIX + f'/profiles/{self._profile_uuid}',
            headers=headers)
        self.assertEqual(resp.status_code, 200)

    def test_functions_no_auth_allowed(self):
        resp = self.client.get(
            PREFIX + f'/profiles/{self._profile_uuid}/functions')
        self.assertEqual(resp.status_code, 200)

    def test_function_detail_no_auth_allowed(self):
        resp = self.client.get(
            PREFIX + f'/profiles/{self._profile_uuid}/functions/main')
        self.assertEqual(resp.status_code, 200)


# ---------------------------------------------------------------------------
# Unknown params
# ---------------------------------------------------------------------------

class TestProfileUnknownParams(unittest.TestCase):
    """Unknown query parameters are rejected with 400."""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.app = create_app(sys.argv[1])
        cls.client = create_client(cls.app)
        run_uuid, _ = _submit_run_with_profile(cls.client, tag='unkparams')
        resp = cls.client.get(PREFIX + f'/runs/{run_uuid}/profiles')
        cls._profile_uuid = resp.get_json()[0]['uuid']
        cls._run_uuid = run_uuid

    def test_listing_unknown_param(self):
        resp = self.client.get(
            PREFIX + f'/runs/{self._run_uuid}/profiles?bogus=1')
        self.assertEqual(resp.status_code, 400)

    def test_metadata_unknown_param(self):
        resp = self.client.get(
            PREFIX + f'/profiles/{self._profile_uuid}?bogus=1')
        self.assertEqual(resp.status_code, 400)

    def test_functions_unknown_param(self):
        resp = self.client.get(
            PREFIX + f'/profiles/{self._profile_uuid}/functions?bogus=1')
        self.assertEqual(resp.status_code, 400)

    def test_function_detail_unknown_param(self):
        resp = self.client.get(
            PREFIX + f'/profiles/{self._profile_uuid}/functions/main?bogus=1')
        self.assertEqual(resp.status_code, 400)


# ---------------------------------------------------------------------------
# Cascade delete
# ---------------------------------------------------------------------------

class TestProfileCascadeDelete(unittest.TestCase):
    """Deleting a run should cascade to its profiles."""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.app = create_app(sys.argv[1])
        cls.client = create_client(cls.app)

    def test_delete_run_cascades_to_profiles(self):
        run_uuid, _ = _submit_run_with_profile(self.client, tag='cascade')

        # Verify profile exists
        resp = self.client.get(PREFIX + f'/runs/{run_uuid}/profiles')
        self.assertEqual(len(resp.get_json()), 1)
        profile_uuid = resp.get_json()[0]['uuid']

        # Delete the run
        resp = self.client.delete(
            PREFIX + f'/runs/{run_uuid}', headers=admin_headers())
        self.assertEqual(resp.status_code, 204)

        # Profile should be gone
        resp = self.client.get(
            PREFIX + f'/profiles/{profile_uuid}')
        self.assertEqual(resp.status_code, 404)


if __name__ == '__main__':
    unittest.main(argv=[sys.argv[0]], exit=True)

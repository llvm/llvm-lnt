# Tests for the v5 API authentication system.
#
# RUN: rm -rf %t.instance %t.pg.log
# RUN: %{utils}/with_postgres.sh %t.pg.log \
# RUN:     %{utils}/with_temporary_instance.py --db-version 5.0 %t.instance \
# RUN:         -- python %s %t.instance
# END.

import datetime
import sys
import os
import unittest

sys.path.insert(0, os.path.dirname(__file__))
from v5_test_helpers import (
    create_app, create_client, admin_headers, make_api_key, make_scoped_headers,
)

from lnt.server.api.v5.auth import (
    SCOPE_LEVELS, _get_scope_level, _hash_token,
)
from lnt.server.db.v5.models import APIKey, utcnow


class TestScopeHierarchy(unittest.TestCase):
    def test_scope_levels_ordering(self):
        self.assertLess(SCOPE_LEVELS['read'], SCOPE_LEVELS['submit'])
        self.assertLess(SCOPE_LEVELS['submit'], SCOPE_LEVELS['triage'])
        self.assertLess(SCOPE_LEVELS['triage'], SCOPE_LEVELS['manage'])
        self.assertLess(SCOPE_LEVELS['manage'], SCOPE_LEVELS['admin'])

    def test_get_scope_level_valid(self):
        self.assertEqual(_get_scope_level('read'), 0)
        self.assertEqual(_get_scope_level('admin'), 4)

    def test_get_scope_level_invalid(self):
        self.assertEqual(_get_scope_level('nonexistent'), -1)

    def test_all_scopes_present(self):
        expected = {'read', 'submit', 'triage', 'manage', 'admin'}
        self.assertEqual(set(SCOPE_LEVELS.keys()), expected)


class TestTokenHashing(unittest.TestCase):
    def test_hash_deterministic(self):
        token = 'test_token_abc123'
        self.assertEqual(_hash_token(token), _hash_token(token))

    def test_hash_different_for_different_tokens(self):
        self.assertNotEqual(_hash_token('token_a'), _hash_token('token_b'))

    def test_hash_is_hex_string(self):
        h = _hash_token('some_token')
        self.assertEqual(len(h), 64)  # SHA-256 hex
        int(h, 16)  # Should not raise


class TestBootstrapToken(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.app = create_app(sys.argv[1])
        cls.client = create_client(cls.app)
        cls._admin_headers = admin_headers()

    def test_bootstrap_token_allows_read(self):
        resp = self.client.get('/api/v5/', headers=self._admin_headers)
        self.assertEqual(resp.status_code, 200)

    def test_bootstrap_token_allows_admin_paths(self):
        """Admin token should not get 401 or 403 on discovery."""
        resp = self.client.get('/api/v5/', headers=self._admin_headers)
        self.assertEqual(resp.status_code, 200)

    def test_bootstrap_token_grants_admin_scope(self):
        """Bootstrap token should resolve to admin scope via constant-time
        comparison (hmac.compare_digest)."""
        with self.app.test_request_context(
                headers=self._admin_headers):
            from lnt.server.api.v5.auth import _resolve_bearer_token
            scope, api_key = _resolve_bearer_token()
            self.assertEqual(scope, 'admin')
            self.assertIsNone(api_key)

    def test_wrong_bootstrap_token_returns_401(self):
        """A token that does not match the bootstrap token (and has no
        matching DB key) should abort with 401 on a read-scoped endpoint."""
        wrong_headers = {'Authorization': 'Bearer wrong_token_value'}
        resp = self.client.get('/api/v5/nts/machines', headers=wrong_headers)
        self.assertEqual(resp.status_code, 401)


class TestUnauthenticatedAccess(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.app = create_app(sys.argv[1])
        cls.client = create_client(cls.app)

    def test_discovery_no_auth(self):
        resp = self.client.get('/api/v5/')
        self.assertEqual(resp.status_code, 200)

    def test_fields_no_auth(self):
        resp = self.client.get('/api/v5/nts/machines')
        self.assertEqual(resp.status_code, 200)

    def test_schema_no_auth(self):
        resp = self.client.get('/api/v5/test-suites/nts')
        self.assertEqual(resp.status_code, 200)


class TestInvalidToken(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.app = create_app(sys.argv[1])
        cls.client = create_client(cls.app)

    def test_invalid_bearer_token_on_read_endpoint_returns_401(self):
        """An invalid Bearer token must return 401, not silently succeed."""
        headers = {'Authorization': 'Bearer totally_invalid_token_xyz'}
        resp = self.client.get('/api/v5/nts/machines', headers=headers)
        self.assertEqual(resp.status_code, 401)

    def test_invalid_bearer_token_on_testsuite_read_returns_401(self):
        """An invalid Bearer token on a testsuite read endpoint returns 401."""
        headers = {'Authorization': 'Bearer bogus_token_abc123'}
        resp = self.client.get('/api/v5/nts/tests', headers=headers)
        self.assertEqual(resp.status_code, 401)

    def test_empty_bearer_token_returns_401(self):
        """'Bearer ' with no actual token value returns 401."""
        headers = {'Authorization': 'Bearer '}
        resp = self.client.get('/api/v5/nts/machines', headers=headers)
        self.assertEqual(resp.status_code, 401)

    def test_invalid_token_on_unprotected_discovery_passes(self):
        """Discovery endpoint has no auth decorator, so invalid tokens
        do not cause 401 there — it is truly public."""
        headers = {'Authorization': 'Bearer totally_invalid_token_xyz'}
        resp = self.client.get('/api/v5/', headers=headers)
        self.assertEqual(resp.status_code, 200)

    def test_malformed_auth_header_allows_unauthenticated_read(self):
        """Non-Bearer Authorization header is treated as no-auth (not 401),
        preserving backward compatibility with proxies/middleware that may
        inject other schemes."""
        headers = {'Authorization': 'NotBearer sometoken'}
        resp = self.client.get('/api/v5/nts/machines', headers=headers)
        self.assertEqual(resp.status_code, 200)


class TestScopedAPIKeys(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.app = create_app(sys.argv[1])
        cls.client = create_client(cls.app)
        cls._read_headers = make_scoped_headers(cls.app, 'read')

    def test_read_key_can_access_discovery(self):
        resp = self.client.get('/api/v5/', headers=self._read_headers)
        self.assertEqual(resp.status_code, 200)

    def test_read_key_can_access_fields(self):
        resp = self.client.get(
            '/api/v5/nts/machines', headers=self._read_headers)
        self.assertEqual(resp.status_code, 200)


class TestRequireAuthForReads(unittest.TestCase):
    """Tests for the require_auth_for_reads config flag.

    When require_auth_for_reads is True, unauthenticated GET requests to
    read-scoped endpoints must return 401, while authenticated requests
    succeed.
    """
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.app = create_app(sys.argv[1])
        # Enable require_auth_for_reads on this app instance
        cls.app.old_config.require_auth_for_reads = True
        cls.client = create_client(cls.app)
        cls._read_headers = make_scoped_headers(cls.app, 'read')

    @classmethod
    def tearDownClass(cls):
        # Restore default to avoid affecting other tests
        cls.app.old_config.require_auth_for_reads = False
        super().tearDownClass()

    def test_unauthenticated_read_returns_401(self):
        """Unauthenticated GET to a read-scoped endpoint returns 401."""
        resp = self.client.get('/api/v5/nts/machines')
        self.assertEqual(resp.status_code, 401)

    def test_unauthenticated_fields_returns_401(self):
        """Unauthenticated GET to /tests returns 401."""
        resp = self.client.get('/api/v5/nts/tests')
        self.assertEqual(resp.status_code, 401)

    def test_authenticated_read_returns_200(self):
        """Authenticated GET with read scope returns 200."""
        resp = self.client.get(
            '/api/v5/nts/machines', headers=self._read_headers)
        self.assertEqual(resp.status_code, 200)

    def test_authenticated_fields_returns_200(self):
        """Authenticated GET to /tests with read scope returns 200."""
        resp = self.client.get(
            '/api/v5/nts/tests', headers=self._read_headers)
        self.assertEqual(resp.status_code, 200)

    def test_admin_token_still_works(self):
        """Admin bootstrap token still works when reads require auth."""
        resp = self.client.get(
            '/api/v5/nts/machines', headers=admin_headers())
        self.assertEqual(resp.status_code, 200)


class TestLastUsedAtThrottling(unittest.TestCase):
    """Tests for last_used_at update throttling.

    The auth system only updates last_used_at once per hour to avoid
    dirtying the DB session (and triggering a COMMIT) on every read.
    """
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.app = create_app(sys.argv[1])
        cls.client = create_client(cls.app)

    def _get_api_key(self, token):
        """Look up an APIKey row by raw token."""
        from lnt.server.api.v5.auth import _hash_token
        db = self.app.instance.get_database("default")
        session = db.make_session()
        key_hash = _hash_token(token)
        api_key = session.query(APIKey).filter(
            APIKey.key_hash == key_hash).first()
        session.close()
        return api_key

    def _set_last_used_at(self, token, value):
        """Set last_used_at to a specific value for an API key."""
        from lnt.server.api.v5.auth import _hash_token
        db = self.app.instance.get_database("default")
        session = db.make_session()
        key_hash = _hash_token(token)
        api_key = session.query(APIKey).filter(
            APIKey.key_hash == key_hash).first()
        api_key.last_used_at = value
        session.commit()
        session.close()

    def test_first_use_sets_last_used_at(self):
        """When last_used_at is None, it should be set on first use."""
        raw_token = 'throttle_first_use_token_00001'
        db = self.app.instance.get_database("default")
        session = db.make_session()
        make_api_key(session, 'throttle-first', 'read', raw_token)

        # Verify it starts as None
        api_key = self._get_api_key(raw_token)
        self.assertIsNone(api_key.last_used_at)

        # Make a request
        headers = {'Authorization': f'Bearer {raw_token}'}
        resp = self.client.get('/api/v5/nts/machines', headers=headers)
        self.assertEqual(resp.status_code, 200)

        # Verify last_used_at is now set
        api_key = self._get_api_key(raw_token)
        self.assertIsNotNone(api_key.last_used_at)

    def test_recent_use_does_not_update(self):
        """When last_used_at is recent (< 1 hour), it should NOT be updated."""
        raw_token = 'throttle_recent_use_token_0002'
        db = self.app.instance.get_database("default")
        session = db.make_session()
        make_api_key(session, 'throttle-recent', 'read', raw_token)

        # Set last_used_at to 30 minutes ago
        thirty_min_ago = utcnow() - datetime.timedelta(minutes=30)
        self._set_last_used_at(raw_token, thirty_min_ago)

        # Make a request
        headers = {'Authorization': f'Bearer {raw_token}'}
        resp = self.client.get('/api/v5/nts/machines', headers=headers)
        self.assertEqual(resp.status_code, 200)

        # Verify last_used_at was NOT updated (still ~30 min ago)
        api_key = self._get_api_key(raw_token)
        self.assertEqual(api_key.last_used_at, thirty_min_ago)

    def test_stale_use_does_update(self):
        """When last_used_at is stale (> 1 hour), it should be updated."""
        raw_token = 'throttle_stale_use_token_00003'
        db = self.app.instance.get_database("default")
        session = db.make_session()
        make_api_key(session, 'throttle-stale', 'read', raw_token)

        # Set last_used_at to 2 hours ago
        two_hours_ago = utcnow() - datetime.timedelta(hours=2)
        self._set_last_used_at(raw_token, two_hours_ago)

        # Make a request
        headers = {'Authorization': f'Bearer {raw_token}'}
        resp = self.client.get('/api/v5/nts/machines', headers=headers)
        self.assertEqual(resp.status_code, 200)

        # Verify last_used_at was updated (no longer 2 hours ago)
        api_key = self._get_api_key(raw_token)
        self.assertNotEqual(api_key.last_used_at, two_hours_ago)
        self.assertGreater(api_key.last_used_at, two_hours_ago)


if __name__ == '__main__':
    unittest.main(argv=[sys.argv[0]], exit=True)

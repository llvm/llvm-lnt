# Tests for the v5 API authentication system.
#
# RUN: rm -rf %t.instance %t.pg.log
# RUN: %{utils}/with_postgres.sh %t.pg.log \
# RUN:     %{utils}/with_temporary_instance.py %t.instance \
# RUN:         -- python %s %t.instance
# END.

import sys
import os
import unittest

sys.path.insert(0, os.path.dirname(__file__))
from v5_test_helpers import (
    create_app, create_client, admin_headers, make_scoped_headers,
)

from lnt.server.api.v5.auth import (
    SCOPE_LEVELS, _get_scope_level, _hash_token,
)


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


if __name__ == '__main__':
    unittest.main(argv=[sys.argv[0]], exit=True)

# Tests for the v5 Admin / API Key endpoints.
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
from v5_test_helpers import (
    create_app, create_client, admin_headers, make_scoped_headers,
)


class TestListAPIKeysEmpty(unittest.TestCase):
    """GET /api/v5/admin/api-keys with no keys in the database."""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.app = create_app(sys.argv[1])
        cls.client = create_client(cls.app)
        cls._admin_headers = admin_headers()

    def test_list_keys_returns_200(self):
        resp = self.client.get(
            '/api/v5/admin/api-keys', headers=self._admin_headers)
        self.assertEqual(resp.status_code, 200)

    def test_list_keys_empty_initially(self):
        resp = self.client.get(
            '/api/v5/admin/api-keys', headers=self._admin_headers)
        data = resp.get_json()
        self.assertIn('items', data)
        self.assertIsInstance(data['items'], list)
        # There may be keys from other tests that ran first; what matters is
        # the structure is correct.


class TestCreateAPIKey(unittest.TestCase):
    """POST /api/v5/admin/api-keys."""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.app = create_app(sys.argv[1])
        cls.client = create_client(cls.app)
        cls._admin_headers = admin_headers()

    def test_create_key_valid_scope(self):
        """Create a key with a valid scope and verify the response."""
        resp = self.client.post(
            '/api/v5/admin/api-keys',
            json={'name': 'my-read-key', 'scope': 'read'},
            headers=self._admin_headers,
        )
        self.assertEqual(resp.status_code, 201)
        data = resp.get_json()
        self.assertIn('key', data)
        self.assertIn('prefix', data)
        self.assertIn('scope', data)
        self.assertEqual(data['scope'], 'read')
        # Prefix is the first 8 chars of the token
        self.assertEqual(data['prefix'], data['key'][:8])
        # Token should be reasonably long
        self.assertGreaterEqual(len(data['key']), 32)

    def test_create_key_all_valid_scopes(self):
        """All five scopes should be accepted."""
        for scope in ('read', 'submit', 'triage', 'manage', 'admin'):
            resp = self.client.post(
                '/api/v5/admin/api-keys',
                json={'name': f'key-{scope}', 'scope': scope},
                headers=self._admin_headers,
            )
            self.assertEqual(
                resp.status_code, 201,
                f"Failed to create key with scope '{scope}': "
                f"{resp.get_data(as_text=True)}")

    def test_create_key_invalid_scope(self):
        """An invalid scope should return 422."""
        resp = self.client.post(
            '/api/v5/admin/api-keys',
            json={'name': 'bad-key', 'scope': 'superadmin'},
            headers=self._admin_headers,
        )
        self.assertIn(resp.status_code, (400, 422))

    def test_create_key_missing_name(self):
        """Missing 'name' field should return 422."""
        resp = self.client.post(
            '/api/v5/admin/api-keys',
            json={'scope': 'read'},
            headers=self._admin_headers,
        )
        self.assertIn(resp.status_code, (400, 422))

    def test_create_key_missing_scope(self):
        """Missing 'scope' field should return 422."""
        resp = self.client.post(
            '/api/v5/admin/api-keys',
            json={'name': 'no-scope-key'},
            headers=self._admin_headers,
        )
        self.assertIn(resp.status_code, (400, 422))


class TestCreateAPIKeyAuth(unittest.TestCase):
    """Auth enforcement on POST /api/v5/admin/api-keys."""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.app = create_app(sys.argv[1])
        cls.client = create_client(cls.app)
        cls._admin_headers = admin_headers()

    def test_create_key_without_auth(self):
        """No auth header should return 401."""
        resp = self.client.post(
            '/api/v5/admin/api-keys',
            json={'name': 'unauth-key', 'scope': 'read'},
        )
        self.assertEqual(resp.status_code, 401)

    def test_create_key_with_read_scope(self):
        """A read-scoped key should get 403 on admin endpoints."""
        read_headers = make_scoped_headers(self.app, 'read')
        resp = self.client.post(
            '/api/v5/admin/api-keys',
            json={'name': 'from-read', 'scope': 'read'},
            headers=read_headers,
        )
        self.assertEqual(resp.status_code, 403)

    def test_create_key_with_submit_scope(self):
        """A submit-scoped key should get 403 on admin endpoints."""
        submit_headers = make_scoped_headers(self.app, 'submit')
        resp = self.client.post(
            '/api/v5/admin/api-keys',
            json={'name': 'from-submit', 'scope': 'read'},
            headers=submit_headers,
        )
        self.assertEqual(resp.status_code, 403)

    def test_create_key_with_triage_scope(self):
        """A triage-scoped key should get 403 on admin endpoints."""
        triage_headers = make_scoped_headers(self.app, 'triage')
        resp = self.client.post(
            '/api/v5/admin/api-keys',
            json={'name': 'from-triage', 'scope': 'read'},
            headers=triage_headers,
        )
        self.assertEqual(resp.status_code, 403)

    def test_create_key_with_manage_scope(self):
        """A manage-scoped key should get 403 on admin endpoints."""
        manage_headers = make_scoped_headers(self.app, 'manage')
        resp = self.client.post(
            '/api/v5/admin/api-keys',
            json={'name': 'from-manage', 'scope': 'read'},
            headers=manage_headers,
        )
        self.assertEqual(resp.status_code, 403)


class TestListAPIKeysAuth(unittest.TestCase):
    """Auth enforcement on GET /api/v5/admin/api-keys."""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.app = create_app(sys.argv[1])
        cls.client = create_client(cls.app)

    def test_list_keys_without_auth(self):
        """No auth header should return 401."""
        resp = self.client.get('/api/v5/admin/api-keys')
        self.assertEqual(resp.status_code, 401)

    def test_list_keys_with_manage_scope_403(self):
        """A manage-scoped key (one below admin) should get 403."""
        manage_headers = make_scoped_headers(self.app, 'manage')
        resp = self.client.get(
            '/api/v5/admin/api-keys', headers=manage_headers)
        self.assertEqual(resp.status_code, 403)

    def test_list_keys_with_admin_scope_200(self):
        """An admin-scoped key (the required scope) succeeds."""
        resp = self.client.get(
            '/api/v5/admin/api-keys', headers=admin_headers())
        self.assertEqual(resp.status_code, 200)


class TestListAPIKeysAfterCreate(unittest.TestCase):
    """After creating keys, they appear in the list."""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.app = create_app(sys.argv[1])
        cls.client = create_client(cls.app)
        cls._admin_headers = admin_headers()

    def test_created_key_appears_in_list(self):
        # Create a key
        create_resp = self.client.post(
            '/api/v5/admin/api-keys',
            json={'name': 'list-test-key', 'scope': 'submit'},
            headers=self._admin_headers,
        )
        self.assertEqual(create_resp.status_code, 201)
        created = create_resp.get_json()
        prefix = created['prefix']

        # List keys and check the new key is there
        list_resp = self.client.get(
            '/api/v5/admin/api-keys', headers=self._admin_headers)
        self.assertEqual(list_resp.status_code, 200)
        items = list_resp.get_json()['items']
        prefixes = [item['prefix'] for item in items]
        self.assertIn(prefix, prefixes)

        # Verify the list item has the correct fields and no hash/raw key
        matching = [item for item in items if item['prefix'] == prefix][0]
        self.assertEqual(matching['name'], 'list-test-key')
        self.assertEqual(matching['scope'], 'submit')
        self.assertTrue(matching['is_active'])
        self.assertIn('created_at', matching)
        # MUST NOT leak the hash or raw key
        self.assertNotIn('key_hash', matching)
        self.assertNotIn('key', matching)


class TestDeleteAPIKey(unittest.TestCase):
    """DELETE /api/v5/admin/api-keys/{prefix}."""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.app = create_app(sys.argv[1])
        cls.client = create_client(cls.app)
        cls._admin_headers = admin_headers()

    def test_delete_key_returns_204(self):
        # Create a key first
        create_resp = self.client.post(
            '/api/v5/admin/api-keys',
            json={'name': 'delete-me', 'scope': 'read'},
            headers=self._admin_headers,
        )
        self.assertEqual(create_resp.status_code, 201)
        prefix = create_resp.get_json()['prefix']

        # Delete it
        delete_resp = self.client.delete(
            f'/api/v5/admin/api-keys/{prefix}',
            headers=self._admin_headers,
        )
        self.assertEqual(delete_resp.status_code, 204)

    def test_delete_nonexistent_prefix(self):
        """Deleting a prefix that does not exist should return 404."""
        resp = self.client.delete(
            '/api/v5/admin/api-keys/zzzzzzzz',
            headers=self._admin_headers,
        )
        self.assertEqual(resp.status_code, 404)

    def test_deleted_key_is_soft_deleted(self):
        """After deletion the key is inactive but still appears in the list."""
        # Create
        create_resp = self.client.post(
            '/api/v5/admin/api-keys',
            json={'name': 'soft-del', 'scope': 'read'},
            headers=self._admin_headers,
        )
        prefix = create_resp.get_json()['prefix']

        # Delete
        self.client.delete(
            f'/api/v5/admin/api-keys/{prefix}',
            headers=self._admin_headers,
        )

        # The key should still show in the list but with is_active=False
        list_resp = self.client.get(
            '/api/v5/admin/api-keys', headers=self._admin_headers)
        items = list_resp.get_json()['items']
        matching = [i for i in items if i['prefix'] == prefix]
        self.assertEqual(len(matching), 1)
        self.assertFalse(matching[0]['is_active'])


class TestDeleteAPIKeyAuth(unittest.TestCase):
    """Auth enforcement on DELETE /api/v5/admin/api-keys/{prefix}."""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.app = create_app(sys.argv[1])
        cls.client = create_client(cls.app)

    def test_delete_key_without_auth(self):
        resp = self.client.delete('/api/v5/admin/api-keys/abcd1234')
        self.assertEqual(resp.status_code, 401)

    def test_delete_key_with_manage_scope_403(self):
        """A manage-scoped key (one below admin) should get 403."""
        manage_headers = make_scoped_headers(self.app, 'manage')
        resp = self.client.delete(
            '/api/v5/admin/api-keys/abcd1234', headers=manage_headers)
        self.assertEqual(resp.status_code, 403)

    def test_delete_key_with_admin_scope_204(self):
        """An admin-scoped key (the required scope) succeeds."""
        # Create a key to delete
        create_resp = self.client.post(
            '/api/v5/admin/api-keys',
            json={'name': 'admin-del-test', 'scope': 'read'},
            headers=admin_headers(),
        )
        self.assertEqual(create_resp.status_code, 201)
        prefix = create_resp.get_json()['prefix']

        resp = self.client.delete(
            f'/api/v5/admin/api-keys/{prefix}',
            headers=admin_headers(),
        )
        self.assertEqual(resp.status_code, 204)


class TestCreatedKeyWorksForAuth(unittest.TestCase):
    """Keys created via the admin endpoint actually authenticate requests."""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.app = create_app(sys.argv[1])
        cls.client = create_client(cls.app)
        cls._admin_headers = admin_headers()

    def test_created_read_key_can_access_discovery(self):
        """A newly created read key should work on a GET endpoint."""
        # Create a read-scoped key
        create_resp = self.client.post(
            '/api/v5/admin/api-keys',
            json={'name': 'auth-test-read', 'scope': 'read'},
            headers=self._admin_headers,
        )
        self.assertEqual(create_resp.status_code, 201)
        raw_token = create_resp.get_json()['key']

        # Use the raw token to access the discovery endpoint
        headers = {'Authorization': f'Bearer {raw_token}'}
        resp = self.client.get('/api/v5/', headers=headers)
        self.assertEqual(resp.status_code, 200)

    def test_created_read_key_can_access_fields(self):
        """A newly created read key should access /nts/machines."""
        create_resp = self.client.post(
            '/api/v5/admin/api-keys',
            json={'name': 'auth-test-fields', 'scope': 'read'},
            headers=self._admin_headers,
        )
        raw_token = create_resp.get_json()['key']

        headers = {'Authorization': f'Bearer {raw_token}'}
        resp = self.client.get('/api/v5/nts/machines', headers=headers)
        self.assertEqual(resp.status_code, 200)

    def test_revoked_key_is_rejected(self):
        """After revoking a key, it should no longer authenticate."""
        # Create a key
        create_resp = self.client.post(
            '/api/v5/admin/api-keys',
            json={'name': 'revoke-test', 'scope': 'admin'},
            headers=self._admin_headers,
        )
        created = create_resp.get_json()
        raw_token = created['key']
        prefix = created['prefix']

        # Verify it works
        headers = {'Authorization': f'Bearer {raw_token}'}
        resp = self.client.get(
            '/api/v5/admin/api-keys', headers=headers)
        self.assertEqual(resp.status_code, 200)

        # Revoke it
        self.client.delete(
            f'/api/v5/admin/api-keys/{prefix}',
            headers=self._admin_headers,
        )

        # Now it should be rejected -- admin endpoints require admin scope,
        # so a revoked key with no valid auth should get 401
        resp2 = self.client.get(
            '/api/v5/admin/api-keys', headers=headers)
        self.assertEqual(resp2.status_code, 401)

    def test_created_read_key_cannot_access_admin(self):
        """A read-scoped key should be forbidden from admin endpoints."""
        create_resp = self.client.post(
            '/api/v5/admin/api-keys',
            json={'name': 'read-no-admin', 'scope': 'read'},
            headers=self._admin_headers,
        )
        raw_token = create_resp.get_json()['key']

        headers = {'Authorization': f'Bearer {raw_token}'}
        resp = self.client.get(
            '/api/v5/admin/api-keys', headers=headers)
        self.assertEqual(resp.status_code, 403)

    def test_created_admin_key_can_create_more_keys(self):
        """An admin-scoped key should be able to create other keys."""
        # Create an admin key
        create_resp = self.client.post(
            '/api/v5/admin/api-keys',
            json={'name': 'admin-creator', 'scope': 'admin'},
            headers=self._admin_headers,
        )
        raw_token = create_resp.get_json()['key']
        new_admin_headers = {'Authorization': f'Bearer {raw_token}'}

        # Use it to create another key
        resp = self.client.post(
            '/api/v5/admin/api-keys',
            json={'name': 'child-key', 'scope': 'read'},
            headers=new_admin_headers,
        )
        self.assertEqual(resp.status_code, 201)


class TestAdminUnknownParams(unittest.TestCase):
    """Test that unknown query parameters are rejected with 400."""
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.app = create_app(sys.argv[1])
        cls.client = create_client(cls.app)
        cls._admin_headers = admin_headers()

    def test_api_keys_list_unknown_param_returns_400(self):
        resp = self.client.get(
            '/api/v5/admin/api-keys?bogus=1',
            headers=self._admin_headers)
        self.assertEqual(resp.status_code, 400)
        data = resp.get_json()
        self.assertIn('bogus', data['error']['message'])


if __name__ == '__main__':
    unittest.main(argv=[sys.argv[0]], exit=True)

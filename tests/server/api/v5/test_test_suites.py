# Tests for the v5 test-suites endpoints.
#
# RUN: rm -rf %t.instance %t.pg.log
# RUN: %{utils}/with_postgres.sh %t.pg.log \
# RUN:     %{utils}/with_temporary_instance.py %t.instance \
# RUN:         -- python %s %t.instance
# END.

import sys
import os
import unittest
from unittest.mock import patch

import lnt.server.db.testsuitedb

sys.path.insert(0, os.path.dirname(__file__))
from v5_test_helpers import (
    create_app, create_client, admin_headers, make_scoped_headers,
)


MINIMAL_SUITE = {
    'format_version': '2',
    'name': 'newsuite',
    'machine_fields': [{'name': 'hostname'}],
    'run_fields': [
        {'name': 'llvm_project_revision', 'order': True},
    ],
    'metrics': [
        {'name': 'compile_time', 'type': 'Real', 'bigger_is_better': False},
    ],
}


class TestListTestSuites(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.app = create_app(sys.argv[1])
        cls.client = create_client(cls.app)

    def test_list_returns_200(self):
        resp = self.client.get('/api/v5/test-suites/')
        self.assertEqual(resp.status_code, 200)

    def test_list_contains_nts(self):
        resp = self.client.get('/api/v5/test-suites/')
        data = resp.get_json()
        self.assertIn('items', data)
        names = [item['name'] for item in data['items']]
        self.assertIn('nts', names)

    def test_list_items_have_name_schema_links(self):
        resp = self.client.get('/api/v5/test-suites/')
        data = resp.get_json()
        for item in data['items']:
            self.assertIn('name', item)
            self.assertIn('schema', item)
            self.assertIn('links', item)

    def test_list_no_auth_required(self):
        resp = self.client.get('/api/v5/test-suites/')
        self.assertEqual(resp.status_code, 200)

    def test_list_unknown_params_returns_400(self):
        resp = self.client.get('/api/v5/test-suites/?bogus=1')
        self.assertEqual(resp.status_code, 400)
        data = resp.get_json()
        self.assertIn('bogus', data['error']['message'])


class TestGetTestSuite(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.app = create_app(sys.argv[1])
        cls.client = create_client(cls.app)

    def test_get_nts_returns_200(self):
        resp = self.client.get('/api/v5/test-suites/nts')
        self.assertEqual(resp.status_code, 200)

    def test_get_nts_has_schema_and_links(self):
        resp = self.client.get('/api/v5/test-suites/nts')
        data = resp.get_json()
        self.assertIn('schema', data)
        self.assertIn('links', data)
        self.assertEqual(data['name'], 'nts')

    def test_get_nts_schema_has_name(self):
        resp = self.client.get('/api/v5/test-suites/nts')
        data = resp.get_json()
        self.assertEqual(data['schema']['name'], 'nts')

    def test_get_nonexistent_returns_404(self):
        resp = self.client.get('/api/v5/test-suites/nonexistent')
        self.assertEqual(resp.status_code, 404)

    def test_get_unknown_params_returns_400(self):
        resp = self.client.get('/api/v5/test-suites/nts?bogus=1')
        self.assertEqual(resp.status_code, 400)


class TestCreateTestSuite(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.app = create_app(sys.argv[1])
        cls.client = create_client(cls.app)
        cls._manage_headers = make_scoped_headers(cls.app, 'manage')

    def _create_suite(self, payload=None, headers=None):
        if payload is None:
            payload = dict(MINIMAL_SUITE)
        if headers is None:
            headers = self._manage_headers
        return self.client.post(
            '/api/v5/test-suites/',
            json=payload,
            headers=headers,
        )

    def test_create_returns_201(self):
        payload = dict(MINIMAL_SUITE, name='createsuite1')
        resp = self._create_suite(payload)
        self.assertEqual(resp.status_code, 201)

    def test_create_returns_location_header(self):
        payload = dict(MINIMAL_SUITE, name='createsuite2')
        resp = self._create_suite(payload)
        self.assertEqual(resp.status_code, 201)
        self.assertIn('Location', resp.headers)
        self.assertIn('createsuite2', resp.headers['Location'])

    def test_created_suite_appears_in_list(self):
        payload = dict(MINIMAL_SUITE, name='createsuite3')
        resp = self._create_suite(payload)
        self.assertEqual(resp.status_code, 201)

        list_resp = self.client.get('/api/v5/test-suites/')
        data = list_resp.get_json()
        names = [item['name'] for item in data['items']]
        self.assertIn('createsuite3', names)

    def test_schema_roundtrips(self):
        payload = dict(MINIMAL_SUITE, name='createsuite4')
        resp = self._create_suite(payload)
        self.assertEqual(resp.status_code, 201)

        detail_resp = self.client.get('/api/v5/test-suites/createsuite4')
        self.assertEqual(detail_resp.status_code, 200)
        data = detail_resp.get_json()
        self.assertEqual(data['schema']['name'], 'createsuite4')

    def test_per_suite_endpoints_work(self):
        payload = dict(MINIMAL_SUITE, name='createsuite5')
        resp = self._create_suite(payload)
        self.assertEqual(resp.status_code, 201)

        # Machines list should work
        machines_resp = self.client.get('/api/v5/createsuite5/machines')
        self.assertEqual(machines_resp.status_code, 200)

    def test_duplicate_returns_409(self):
        payload = dict(MINIMAL_SUITE, name='createsuite6')
        resp1 = self._create_suite(payload)
        self.assertEqual(resp1.status_code, 201)

        resp2 = self._create_suite(payload)
        self.assertEqual(resp2.status_code, 409)

    def test_invalid_name_returns_422(self):
        payload = dict(MINIMAL_SUITE, name='123invalid')
        resp = self._create_suite(payload)
        self.assertIn(resp.status_code, (400, 422))

    def test_name_with_spaces_returns_422(self):
        payload = dict(MINIMAL_SUITE, name='has space')
        resp = self._create_suite(payload)
        self.assertIn(resp.status_code, (400, 422))

    def test_missing_format_version_returns_422(self):
        payload = dict(MINIMAL_SUITE, name='createsuite_nofv')
        del payload['format_version']
        resp = self._create_suite(payload)
        self.assertIn(resp.status_code, (400, 422))

    def test_wrong_format_version_returns_422(self):
        payload = dict(MINIMAL_SUITE, name='createsuite_wrongfv')
        payload['format_version'] = '1'
        resp = self._create_suite(payload)
        self.assertIn(resp.status_code, (400, 422))

    def test_no_order_field_returns_400(self):
        payload = dict(MINIMAL_SUITE, name='createsuite_noorder')
        payload['run_fields'] = [{'name': 'tag'}]  # no order field
        resp = self._create_suite(payload)
        self.assertEqual(resp.status_code, 400)

    def test_invalid_metric_type_returns_400(self):
        payload = dict(MINIMAL_SUITE, name='createsuite_badmetric')
        payload['metrics'] = [{'name': 'x', 'type': 'BadType'}]
        resp = self._create_suite(payload)
        self.assertEqual(resp.status_code, 400)

    def test_empty_body_returns_422(self):
        resp = self.client.post(
            '/api/v5/test-suites/',
            json={},
            headers=self._manage_headers,
        )
        self.assertIn(resp.status_code, (400, 422))


class TestCreateTestSuiteAuth(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.app = create_app(sys.argv[1])
        cls.client = create_client(cls.app)

    def test_no_auth_returns_401(self):
        payload = dict(MINIMAL_SUITE, name='authtest1')
        resp = self.client.post('/api/v5/test-suites/', json=payload)
        self.assertEqual(resp.status_code, 401)

    def test_read_scope_returns_403(self):
        headers = make_scoped_headers(self.app, 'read')
        payload = dict(MINIMAL_SUITE, name='authtest2')
        resp = self.client.post(
            '/api/v5/test-suites/', json=payload, headers=headers)
        self.assertEqual(resp.status_code, 403)

    def test_submit_scope_returns_403(self):
        headers = make_scoped_headers(self.app, 'submit')
        payload = dict(MINIMAL_SUITE, name='authtest3')
        resp = self.client.post(
            '/api/v5/test-suites/', json=payload, headers=headers)
        self.assertEqual(resp.status_code, 403)

    def test_triage_scope_returns_403(self):
        headers = make_scoped_headers(self.app, 'triage')
        payload = dict(MINIMAL_SUITE, name='authtest4')
        resp = self.client.post(
            '/api/v5/test-suites/', json=payload, headers=headers)
        self.assertEqual(resp.status_code, 403)

    def test_manage_scope_returns_201(self):
        headers = make_scoped_headers(self.app, 'manage')
        payload = dict(MINIMAL_SUITE, name='authtest5')
        resp = self.client.post(
            '/api/v5/test-suites/', json=payload, headers=headers)
        self.assertEqual(resp.status_code, 201)

    def test_admin_scope_returns_201(self):
        payload = dict(MINIMAL_SUITE, name='authtest6')
        resp = self.client.post(
            '/api/v5/test-suites/', json=payload,
            headers=admin_headers())
        self.assertEqual(resp.status_code, 201)


class TestDeleteTestSuite(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.app = create_app(sys.argv[1])
        cls.client = create_client(cls.app)
        cls._manage_headers = make_scoped_headers(cls.app, 'manage')

    def _create_and_return_name(self, name):
        payload = dict(MINIMAL_SUITE, name=name)
        resp = self.client.post(
            '/api/v5/test-suites/', json=payload,
            headers=self._manage_headers)
        self.assertEqual(resp.status_code, 201)
        return name

    def test_delete_with_confirm_returns_204(self):
        name = self._create_and_return_name('deletesuite1')
        resp = self.client.delete(
            f'/api/v5/test-suites/{name}?confirm=true',
            headers=self._manage_headers)
        self.assertEqual(resp.status_code, 204)

    def test_delete_without_confirm_returns_400(self):
        name = self._create_and_return_name('deletesuite2')
        resp = self.client.delete(
            f'/api/v5/test-suites/{name}',
            headers=self._manage_headers)
        self.assertEqual(resp.status_code, 400)

    def test_delete_with_confirm_false_returns_400(self):
        name = self._create_and_return_name('deletesuite3')
        resp = self.client.delete(
            f'/api/v5/test-suites/{name}?confirm=false',
            headers=self._manage_headers)
        self.assertEqual(resp.status_code, 400)

    def test_delete_nonexistent_returns_404(self):
        resp = self.client.delete(
            '/api/v5/test-suites/nonexistent?confirm=true',
            headers=self._manage_headers)
        self.assertEqual(resp.status_code, 404)

    def test_deleted_suite_removed_from_list(self):
        name = self._create_and_return_name('deletesuite4')
        self.client.delete(
            f'/api/v5/test-suites/{name}?confirm=true',
            headers=self._manage_headers)

        list_resp = self.client.get('/api/v5/test-suites/')
        data = list_resp.get_json()
        names = [item['name'] for item in data['items']]
        self.assertNotIn(name, names)

    def test_deleted_suite_per_suite_endpoints_404(self):
        name = self._create_and_return_name('deletesuite5')
        self.client.delete(
            f'/api/v5/test-suites/{name}?confirm=true',
            headers=self._manage_headers)

        resp = self.client.get(f'/api/v5/{name}/machines')
        self.assertEqual(resp.status_code, 404)

    def test_recreate_after_delete(self):
        name = self._create_and_return_name('deletesuite6')
        self.client.delete(
            f'/api/v5/test-suites/{name}?confirm=true',
            headers=self._manage_headers)

        # Recreate with the same name
        payload = dict(MINIMAL_SUITE, name=name)
        resp = self.client.post(
            '/api/v5/test-suites/', json=payload,
            headers=self._manage_headers)
        self.assertEqual(resp.status_code, 201)

    def test_delete_suite_with_data(self):
        """Create a suite, add some data, then delete it."""
        name = self._create_and_return_name('deletesuite7')

        # Submit a machine to create some data via direct DB access
        db = self.app.instance.get_database("default")
        ts = db.testsuite[name]
        session = db.make_session()
        machine = ts.Machine('test-machine')
        session.add(machine)
        session.commit()
        session.close()

        # Now delete
        resp = self.client.delete(
            f'/api/v5/test-suites/{name}?confirm=true',
            headers=self._manage_headers)
        self.assertEqual(resp.status_code, 204)


class TestDeleteTestSuiteErrorRecovery(unittest.TestCase):
    """Test that the delete endpoint recovers from partial failures."""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.app = create_app(sys.argv[1])
        cls.client = create_client(cls.app)
        cls._manage_headers = make_scoped_headers(cls.app, 'manage')

    def _create_and_return_name(self, name):
        payload = dict(MINIMAL_SUITE, name=name)
        resp = self.client.post(
            '/api/v5/test-suites/', json=payload,
            headers=self._manage_headers)
        self.assertEqual(resp.status_code, 201)
        return name

    def test_metadata_failure_preserves_suite(self):
        """If metadata deletion fails, tables and in-memory state survive."""
        name = self._create_and_return_name('delfail1')

        # Verify suite exists
        resp = self.client.get(f'/api/v5/test-suites/{name}')
        self.assertEqual(resp.status_code, 200)

        db = self.app.instance.get_database("default")

        # Patch increment_registry_version to raise, simulating a failure
        # during the metadata-commit step (step 1).  Since the exception
        # occurs inside the try block, the session is rolled back and the
        # suite should remain fully intact.
        with patch.object(
            db, 'increment_registry_version',
            side_effect=RuntimeError("simulated version increment failure"),
        ):
            resp = self.client.delete(
                f'/api/v5/test-suites/{name}?confirm=true',
                headers=self._manage_headers)
            self.assertEqual(resp.status_code, 500)

        # The suite should still be accessible (metadata was rolled back)
        self.assertIn(name, db.testsuite)

        # The suite should still appear in the list
        list_resp = self.client.get('/api/v5/test-suites/')
        data = list_resp.get_json()
        names = [item['name'] for item in data['items']]
        self.assertIn(name, names)

        # The suite's per-suite endpoints should still work
        resp = self.client.get(f'/api/v5/{name}/machines')
        self.assertEqual(resp.status_code, 200)

        # Now verify we can still successfully delete it (no corrupted state)
        resp = self.client.delete(
            f'/api/v5/test-suites/{name}?confirm=true',
            headers=self._manage_headers)
        self.assertEqual(resp.status_code, 204)

    def test_table_drop_failure_still_removes_suite(self):
        """If table dropping fails after metadata commit, suite is still
        removed from the in-memory dict (orphaned tables are harmless)."""
        name = self._create_and_return_name('delfail2')
        db = self.app.instance.get_database("default")
        tsdb = db.testsuite[name]

        # Patch drop_all to fail
        with patch.object(
            tsdb.base.metadata, 'drop_all',
            side_effect=RuntimeError("simulated table drop failure"),
        ):
            resp = self.client.delete(
                f'/api/v5/test-suites/{name}?confirm=true',
                headers=self._manage_headers)
            # Should still succeed — table drop failure is non-fatal
            self.assertEqual(resp.status_code, 204)

        # Suite should be gone from the in-memory dict
        self.assertNotIn(name, db.testsuite)

        # Suite should be gone from the list endpoint
        list_resp = self.client.get('/api/v5/test-suites/')
        data = list_resp.get_json()
        names = [item['name'] for item in data['items']]
        self.assertNotIn(name, names)


class TestDeleteTestSuiteAuth(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.app = create_app(sys.argv[1])
        cls.client = create_client(cls.app)
        cls._manage_headers = make_scoped_headers(cls.app, 'manage')
        # Create a suite to test against
        payload = dict(MINIMAL_SUITE, name='delauth')
        cls.client.post(
            '/api/v5/test-suites/', json=payload,
            headers=cls._manage_headers)

    def test_no_auth_returns_401(self):
        resp = self.client.delete(
            '/api/v5/test-suites/delauth?confirm=true')
        self.assertEqual(resp.status_code, 401)

    def test_read_scope_returns_403(self):
        headers = make_scoped_headers(self.app, 'read')
        resp = self.client.delete(
            '/api/v5/test-suites/delauth?confirm=true', headers=headers)
        self.assertEqual(resp.status_code, 403)

    def test_submit_scope_returns_403(self):
        headers = make_scoped_headers(self.app, 'submit')
        resp = self.client.delete(
            '/api/v5/test-suites/delauth?confirm=true', headers=headers)
        self.assertEqual(resp.status_code, 403)

    def test_triage_scope_returns_403(self):
        headers = make_scoped_headers(self.app, 'triage')
        resp = self.client.delete(
            '/api/v5/test-suites/delauth?confirm=true', headers=headers)
        self.assertEqual(resp.status_code, 403)

    def test_manage_scope_returns_204(self):
        # Create a fresh suite for this test
        payload = dict(MINIMAL_SUITE, name='delauth_manage')
        self.client.post(
            '/api/v5/test-suites/', json=payload,
            headers=self._manage_headers)

        resp = self.client.delete(
            '/api/v5/test-suites/delauth_manage?confirm=true',
            headers=self._manage_headers)
        self.assertEqual(resp.status_code, 204)


class TestDiscoveryAfterCreate(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.app = create_app(sys.argv[1])
        cls.client = create_client(cls.app)
        cls._manage_headers = make_scoped_headers(cls.app, 'manage')

    def test_new_suite_appears_in_discovery(self):
        payload = dict(MINIMAL_SUITE, name='discoversuite')
        resp = self.client.post(
            '/api/v5/test-suites/', json=payload,
            headers=self._manage_headers)
        self.assertEqual(resp.status_code, 201)

        disc_resp = self.client.get('/api/v5/')
        data = disc_resp.get_json()
        names = [s['name'] for s in data['test_suites']]
        self.assertIn('discoversuite', names)


class TestUnknownParamsOnMutations(unittest.TestCase):
    """Unknown query params on POST and DELETE should be rejected."""
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.app = create_app(sys.argv[1])
        cls.client = create_client(cls.app)
        cls._manage_headers = make_scoped_headers(cls.app, 'manage')

    def test_post_unknown_param_returns_400(self):
        payload = dict(MINIMAL_SUITE, name='unknownparam_post')
        resp = self.client.post(
            '/api/v5/test-suites/?bogus=1',
            json=payload,
            headers=self._manage_headers)
        self.assertEqual(resp.status_code, 400)
        data = resp.get_json()
        self.assertIn('bogus', data['error']['message'])

    def test_delete_unknown_param_returns_400(self):
        # Create suite first
        payload = dict(MINIMAL_SUITE, name='unknownparam_del')
        self.client.post(
            '/api/v5/test-suites/', json=payload,
            headers=self._manage_headers)

        resp = self.client.delete(
            '/api/v5/test-suites/unknownparam_del?confirm=true&bogus=1',
            headers=self._manage_headers)
        self.assertEqual(resp.status_code, 400)
        data = resp.get_json()
        self.assertIn('bogus', data['error']['message'])


class TestCreateRaceCondition(unittest.TestCase):
    """Test the DB-level duplicate guard (race condition path)."""
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.app = create_app(sys.argv[1])
        cls.client = create_client(cls.app)
        cls._manage_headers = make_scoped_headers(cls.app, 'manage')

    def test_db_row_exists_but_not_in_memory_returns_409(self):
        """If a TestSuite row exists in the DB but is not in the in-memory
        cache, POST should still return 409 (race-condition guard)."""
        # First create a suite normally so the DB row exists
        payload = dict(MINIMAL_SUITE, name='racesuite')
        resp = self.client.post(
            '/api/v5/test-suites/', json=payload,
            headers=self._manage_headers)
        self.assertEqual(resp.status_code, 201)

        # Remove it from the in-memory cache only (simulating another
        # worker that hasn't reloaded yet)
        db = self.app.instance.get_database("default")
        saved_tsdb = db.testsuite.pop('racesuite', None)
        self.assertIsNotNone(saved_tsdb)

        try:
            # POST should hit the DB-level check and return 409
            resp = self.client.post(
                '/api/v5/test-suites/', json=payload,
                headers=self._manage_headers)
            self.assertEqual(resp.status_code, 409)
        finally:
            # Restore the in-memory entry to avoid side-effects
            if saved_tsdb is not None:
                db.testsuite['racesuite'] = saved_tsdb
                db.testsuite = dict(sorted(db.testsuite.items()))


class TestCreateTestSuiteErrorRecovery(unittest.TestCase):
    """Test that the create endpoint recovers from partial failures."""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.app = create_app(sys.argv[1])
        cls.client = create_client(cls.app)
        cls._manage_headers = make_scoped_headers(cls.app, 'manage')

    def _create_suite(self, payload=None, headers=None):
        if payload is None:
            payload = dict(MINIMAL_SUITE)
        if headers is None:
            headers = self._manage_headers
        return self.client.post(
            '/api/v5/test-suites/',
            json=payload,
            headers=headers,
        )

    def test_table_creation_failure_rolls_back_metadata(self):
        """If create_tables fails, metadata rows are rolled back and no
        suite appears in the in-memory dict or the list endpoint."""
        name = 'createfail1'
        payload = dict(MINIMAL_SUITE, name=name)

        db = self.app.instance.get_database("default")

        # Patch create_tables on TestSuiteDB instances to raise.
        with patch.object(
            lnt.server.db.testsuitedb.TestSuiteDB, 'create_tables',
            side_effect=RuntimeError("simulated table creation failure"),
        ):
            resp = self._create_suite(payload)
            self.assertIn(resp.status_code, (400, 500))

        # Suite must NOT be in the in-memory dict.
        self.assertNotIn(name, db.testsuite)

        # Suite must NOT appear in the list endpoint.
        list_resp = self.client.get('/api/v5/test-suites/')
        data = list_resp.get_json()
        names = [item['name'] for item in data['items']]
        self.assertNotIn(name, names)

        # Metadata rows must have been rolled back -- we can create the
        # same suite successfully now.
        resp = self._create_suite(payload)
        self.assertEqual(resp.status_code, 201)

    def test_registry_version_failure_rolls_back_metadata(self):
        """If increment_registry_version fails, metadata and tables are
        cleaned up and the suite can be retried."""
        name = 'createfail2'
        payload = dict(MINIMAL_SUITE, name=name)

        db = self.app.instance.get_database("default")

        with patch.object(
            db, 'increment_registry_version',
            side_effect=RuntimeError("simulated version increment failure"),
        ):
            resp = self._create_suite(payload)
            self.assertIn(resp.status_code, (400, 500))

        # Suite must NOT be in the in-memory dict.
        self.assertNotIn(name, db.testsuite)

        # Suite must NOT appear in the list endpoint.
        list_resp = self.client.get('/api/v5/test-suites/')
        data = list_resp.get_json()
        names = [item['name'] for item in data['items']]
        self.assertNotIn(name, names)

        # The suite can be created successfully on retry.
        resp = self._create_suite(payload)
        self.assertEqual(resp.status_code, 201)

    def test_successful_create_still_works(self):
        """Sanity check: normal creation still succeeds after the refactor."""
        name = 'createfail3'
        payload = dict(MINIMAL_SUITE, name=name)
        resp = self._create_suite(payload)
        self.assertEqual(resp.status_code, 201)

        # Suite is in-memory and reachable via the API.
        db = self.app.instance.get_database("default")
        self.assertIn(name, db.testsuite)

        detail_resp = self.client.get(f'/api/v5/test-suites/{name}')
        self.assertEqual(detail_resp.status_code, 200)

        # Per-suite endpoints work.
        machines_resp = self.client.get(f'/api/v5/{name}/machines')
        self.assertEqual(machines_resp.status_code, 200)


class TestRegistryVersionPropagation(unittest.TestCase):
    """Test that the registry version mechanism detects changes."""
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.app = create_app(sys.argv[1])
        cls.client = create_client(cls.app)
        cls._manage_headers = make_scoped_headers(cls.app, 'manage')

    def test_version_increments_on_create(self):
        """Creating a suite should increment the registry version."""
        from lnt.server.db.testsuite import TestSuiteRegistryVersion

        db = self.app.instance.get_database("default")
        session = db.make_session()
        row = session.query(TestSuiteRegistryVersion).first()
        version_before = row.version if row else 0
        session.close()

        payload = dict(MINIMAL_SUITE, name='regversuite1')
        resp = self.client.post(
            '/api/v5/test-suites/', json=payload,
            headers=self._manage_headers)
        self.assertEqual(resp.status_code, 201)

        session = db.make_session()
        row = session.query(TestSuiteRegistryVersion).first()
        version_after = row.version
        session.close()

        self.assertGreater(version_after, version_before)

    def test_version_increments_on_delete(self):
        """Deleting a suite should increment the registry version."""
        from lnt.server.db.testsuite import TestSuiteRegistryVersion

        # Create
        payload = dict(MINIMAL_SUITE, name='regversuite2')
        self.client.post(
            '/api/v5/test-suites/', json=payload,
            headers=self._manage_headers)

        db = self.app.instance.get_database("default")
        session = db.make_session()
        row = session.query(TestSuiteRegistryVersion).first()
        version_before = row.version
        session.close()

        # Delete
        self.client.delete(
            '/api/v5/test-suites/regversuite2?confirm=true',
            headers=self._manage_headers)

        session = db.make_session()
        row = session.query(TestSuiteRegistryVersion).first()
        version_after = row.version
        session.close()

        self.assertGreater(version_after, version_before)

    def test_stale_version_triggers_reload(self):
        """Simulate another worker bumping the version; verify reload."""
        from lnt.server.db.testsuite import TestSuiteRegistryVersion

        db = self.app.instance.get_database("default")
        suites_before = set(db.testsuite.keys())

        # Artificially bump the DB version to simulate another worker
        session = db.make_session()
        row = session.query(TestSuiteRegistryVersion).first()
        if row is not None:
            row.version = row.version + 100
            session.commit()
        bumped_version = row.version
        session.close()

        # The next API request should detect the stale version and reload
        resp = self.client.get('/api/v5/test-suites/')
        self.assertEqual(resp.status_code, 200)

        # After reload, the cached version should match the DB
        self.assertEqual(db._registry_version, bumped_version)

        # Suites should still be present (reload reconstructs them)
        suites_after = set(db.testsuite.keys())
        self.assertTrue(suites_before.issubset(suites_after))


if __name__ == '__main__':
    unittest.main(argv=[sys.argv[0]], exit=True)

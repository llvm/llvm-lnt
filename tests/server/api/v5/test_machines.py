# Tests for the v5 machine endpoints.
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
import uuid

sys.path.insert(0, os.path.dirname(__file__))
from v5_test_helpers import (
    create_app, create_client, admin_headers, make_scoped_headers,
    create_machine, create_commit, create_run,
    create_test, create_regression,
    collect_all_pages, submit_run,
)


TS = 'nts'
PREFIX = f'/api/v5/{TS}'


class TestMachineList(unittest.TestCase):
    """Tests for GET /api/v5/{ts}/machines."""
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.app = create_app(sys.argv[1])
        cls.client = create_client(cls.app)

    def test_list_empty(self):
        """Empty list when no machines exist initially (or just returns 200)."""
        resp = self.client.get(PREFIX + '/machines')
        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        self.assertIn('items', data)
        self.assertIsInstance(data['items'], list)

    def test_list_has_pagination_envelope(self):
        resp = self.client.get(PREFIX + '/machines')
        data = resp.get_json()
        self.assertIn('cursor', data)
        self.assertIn('next', data['cursor'])
        self.assertIn('previous', data['cursor'])

    def test_list_with_total(self):
        """Offset-paginated lists include a total count."""
        resp = self.client.get(PREFIX + '/machines')
        data = resp.get_json()
        self.assertIn('total', data)
        self.assertIsInstance(data['total'], int)


class TestMachineCreate(unittest.TestCase):
    """Tests for POST /api/v5/{ts}/machines."""
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.app = create_app(sys.argv[1])
        cls.client = create_client(cls.app)

    def test_create_machine(self):
        """Create a machine and verify 201 response."""
        name = f'create-test-{uuid.uuid4().hex[:8]}'
        resp = self.client.post(
            PREFIX + '/machines',
            json={'name': name},
            headers=admin_headers(),
        )
        self.assertEqual(resp.status_code, 201)
        data = resp.get_json()
        self.assertEqual(data['name'], name)

    def test_create_machine_with_info(self):
        """Create a machine with metadata."""
        name = f'create-info-{uuid.uuid4().hex[:8]}'
        resp = self.client.post(
            PREFIX + '/machines',
            json={'name': name, 'info': {'arch': 'x86_64', 'os': 'linux'}},
            headers=admin_headers(),
        )
        self.assertEqual(resp.status_code, 201)
        data = resp.get_json()
        self.assertEqual(data['name'], name)
        self.assertIn('info', data)
        self.assertEqual(data['info'].get('arch'), 'x86_64')

    def test_create_machine_appears_in_list(self):
        """Newly created machine appears in the list."""
        name = f'create-list-{uuid.uuid4().hex[:8]}'
        self.client.post(
            PREFIX + '/machines',
            json={'name': name},
            headers=admin_headers(),
        )
        resp = self.client.get(PREFIX + '/machines')
        data = resp.get_json()
        names = [m['name'] for m in data['items']]
        self.assertIn(name, names)

    def test_create_machine_no_auth_401(self):
        """Creating without auth should return 401."""
        resp = self.client.post(
            PREFIX + '/machines',
            json={'name': 'no-auth-test'},
        )
        self.assertEqual(resp.status_code, 401)

    def test_create_machine_triage_scope_403(self):
        """Creating with triage scope (one below manage) returns 403."""
        headers = make_scoped_headers(self.app, 'triage')
        resp = self.client.post(
            PREFIX + '/machines',
            json={'name': 'triage-only-test'},
            headers=headers,
        )
        self.assertEqual(resp.status_code, 403)

    def test_create_machine_manage_scope_201(self):
        """Creating with manage scope (the required scope) succeeds."""
        name = f'manage-create-{uuid.uuid4().hex[:8]}'
        headers = make_scoped_headers(self.app, 'manage')
        resp = self.client.post(
            PREFIX + '/machines',
            json={'name': name},
            headers=headers,
        )
        self.assertEqual(resp.status_code, 201)

    def test_create_machine_missing_name_422(self):
        """Creating without name should return 422 (schema validation)."""
        resp = self.client.post(
            PREFIX + '/machines',
            json={},
            headers=admin_headers(),
        )
        self.assertEqual(resp.status_code, 422)

    def test_create_duplicate_409(self):
        """Creating a machine with a duplicate name should return 409."""
        name = f'dup-test-{uuid.uuid4().hex[:8]}'
        self.client.post(
            PREFIX + '/machines',
            json={'name': name},
            headers=admin_headers(),
        )
        resp = self.client.post(
            PREFIX + '/machines',
            json={'name': name},
            headers=admin_headers(),
        )
        self.assertEqual(resp.status_code, 409)


class TestMachineDetail(unittest.TestCase):
    """Tests for GET /api/v5/{ts}/machines/{machine_name}."""
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.app = create_app(sys.argv[1])
        cls.client = create_client(cls.app)

    def test_get_machine_detail(self):
        """Get machine detail by name."""
        name = f'detail-test-{uuid.uuid4().hex[:8]}'
        self.client.post(
            PREFIX + '/machines',
            json={'name': name, 'info': {'foo': 'bar'}},
            headers=admin_headers(),
        )
        resp = self.client.get(PREFIX + f'/machines/{name}')
        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        self.assertEqual(data['name'], name)
        self.assertIn('info', data)

    def test_get_nonexistent_404(self):
        """Getting a nonexistent machine should return 404."""
        resp = self.client.get(
            PREFIX + '/machines/nonexistent-machine-xyz')
        self.assertEqual(resp.status_code, 404)


class TestMachineDetailETag(unittest.TestCase):
    """ETag tests for GET /api/v5/{ts}/machines/{machine_name}."""
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.app = create_app(sys.argv[1])
        cls.client = create_client(cls.app)

    def test_etag_present_on_detail(self):
        """Machine detail response should include an ETag header."""
        name = f'etag-present-{uuid.uuid4().hex[:8]}'
        self.client.post(
            PREFIX + '/machines',
            json={'name': name},
            headers=admin_headers(),
        )
        resp = self.client.get(PREFIX + f'/machines/{name}')
        self.assertEqual(resp.status_code, 200)
        etag = resp.headers.get('ETag')
        self.assertIsNotNone(etag)
        self.assertTrue(etag.startswith('W/"'))

    def test_etag_304_on_match(self):
        """Sending If-None-Match with the same ETag returns 304."""
        name = f'etag-304-{uuid.uuid4().hex[:8]}'
        self.client.post(
            PREFIX + '/machines',
            json={'name': name},
            headers=admin_headers(),
        )
        resp = self.client.get(PREFIX + f'/machines/{name}')
        etag = resp.headers.get('ETag')

        resp2 = self.client.get(
            PREFIX + f'/machines/{name}',
            headers={'If-None-Match': etag},
        )
        self.assertEqual(resp2.status_code, 304)

    def test_etag_200_on_mismatch(self):
        """Sending If-None-Match with a different ETag returns 200."""
        name = f'etag-200-{uuid.uuid4().hex[:8]}'
        self.client.post(
            PREFIX + '/machines',
            json={'name': name},
            headers=admin_headers(),
        )
        resp = self.client.get(
            PREFIX + f'/machines/{name}',
            headers={'If-None-Match': 'W/"stale-etag-value"'},
        )
        self.assertEqual(resp.status_code, 200)
        self.assertIsNotNone(resp.get_json())


class TestMachineUpdate(unittest.TestCase):
    """Tests for PATCH /api/v5/{ts}/machines/{machine_name}."""
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.app = create_app(sys.argv[1])
        cls.client = create_client(cls.app)

    def test_rename_machine(self):
        """Rename a machine and verify Location header."""
        old_name = f'rename-old-{uuid.uuid4().hex[:8]}'
        new_name = f'rename-new-{uuid.uuid4().hex[:8]}'
        self.client.post(
            PREFIX + '/machines',
            json={'name': old_name},
            headers=admin_headers(),
        )
        resp = self.client.patch(
            PREFIX + f'/machines/{old_name}',
            json={'name': new_name},
            headers=admin_headers(),
        )
        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        self.assertEqual(data['name'], new_name)
        location = resp.headers.get('Location')
        self.assertIsNotNone(location)
        self.assertIn(new_name, location)

    def test_update_info(self):
        """Update machine info without rename."""
        name = f'update-info-{uuid.uuid4().hex[:8]}'
        self.client.post(
            PREFIX + '/machines',
            json={'name': name},
            headers=admin_headers(),
        )
        resp = self.client.patch(
            PREFIX + f'/machines/{name}',
            json={'info': {'key': 'value'}},
            headers=admin_headers(),
        )
        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        self.assertEqual(data['info'].get('key'), 'value')

    def test_rename_to_existing_409(self):
        """Renaming to an existing name should return 409."""
        name1 = f'rename-dup-a-{uuid.uuid4().hex[:8]}'
        name2 = f'rename-dup-b-{uuid.uuid4().hex[:8]}'
        self.client.post(
            PREFIX + '/machines', json={'name': name1},
            headers=admin_headers(),
        )
        self.client.post(
            PREFIX + '/machines', json={'name': name2},
            headers=admin_headers(),
        )
        resp = self.client.patch(
            PREFIX + f'/machines/{name1}',
            json={'name': name2},
            headers=admin_headers(),
        )
        self.assertEqual(resp.status_code, 409)

    def test_update_no_auth_401(self):
        """PATCH without auth returns 401."""
        name = f'upd-noauth-{uuid.uuid4().hex[:8]}'
        self.client.post(
            PREFIX + '/machines',
            json={'name': name},
            headers=admin_headers(),
        )
        resp = self.client.patch(
            PREFIX + f'/machines/{name}',
            json={'info': {'k': 'v'}},
        )
        self.assertEqual(resp.status_code, 401)

    def test_update_triage_scope_403(self):
        """PATCH with triage scope (one below manage) returns 403."""
        name = f'upd-triage-{uuid.uuid4().hex[:8]}'
        self.client.post(
            PREFIX + '/machines',
            json={'name': name},
            headers=admin_headers(),
        )
        headers = make_scoped_headers(self.app, 'triage')
        resp = self.client.patch(
            PREFIX + f'/machines/{name}',
            json={'info': {'k': 'v'}},
            headers=headers,
        )
        self.assertEqual(resp.status_code, 403)

    def test_update_manage_scope_200(self):
        """PATCH with manage scope (the required scope) succeeds."""
        name = f'upd-manage-{uuid.uuid4().hex[:8]}'
        self.client.post(
            PREFIX + '/machines',
            json={'name': name},
            headers=admin_headers(),
        )
        headers = make_scoped_headers(self.app, 'manage')
        resp = self.client.patch(
            PREFIX + f'/machines/{name}',
            json={'info': {'k': 'v'}},
            headers=headers,
        )
        self.assertEqual(resp.status_code, 200)


class TestMachineDelete(unittest.TestCase):
    """Tests for DELETE /api/v5/{ts}/machines/{machine_name}."""
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.app = create_app(sys.argv[1])
        cls.client = create_client(cls.app)

    def test_delete_machine(self):
        """Delete machine and verify 204, then verify it's gone."""
        name = f'delete-test-{uuid.uuid4().hex[:8]}'
        self.client.post(
            PREFIX + '/machines',
            json={'name': name},
            headers=admin_headers(),
        )
        resp = self.client.delete(
            PREFIX + f'/machines/{name}',
            headers=admin_headers(),
        )
        self.assertEqual(resp.status_code, 204)

        # Verify it's gone
        resp = self.client.get(PREFIX + f'/machines/{name}')
        self.assertEqual(resp.status_code, 404)

    def test_delete_machine_with_runs(self):
        """Delete machine that has runs -- verify cascading deletion works."""
        name = f'delete-runs-{uuid.uuid4().hex[:8]}'
        submit_run(self.client, name, f'rev-{uuid.uuid4().hex[:6]}',
                   [{'name': 'p/test', 'execution_time': [0.0]}])

        resp = self.client.delete(
            PREFIX + f'/machines/{name}',
            headers=admin_headers(),
        )
        self.assertEqual(resp.status_code, 204)

        # Verify machine is gone
        resp = self.client.get(PREFIX + f'/machines/{name}')
        self.assertEqual(resp.status_code, 404)

    def test_delete_machine_with_regression_indicators(self):
        """Delete machine whose RegressionIndicators reference it.

        Verifies the delete handler cleans up RegressionIndicators (which
        have no CASCADE from machine_id) before deleting the machine.
        The Regression itself remains (it may have other indicators on
        different machines).
        """
        name = f'delete-ri-{uuid.uuid4().hex[:8]}'
        db = self.app.instance.get_database("default")
        session = db.make_session()
        ts = db.testsuite[TS]

        machine = create_machine(session, ts, name=name)
        test = create_test(
            session, ts, name=f'ri/test/{uuid.uuid4().hex[:8]}')
        create_regression(
            session, ts, title=f'Reg for {name}',
            indicators=[{'machine_id': machine.id, 'test_id': test.id,
                         'metric': 'execution_time'}])
        session.commit()
        session.close()

        # Delete the machine via the API.
        resp = self.client.delete(
            PREFIX + f'/machines/{name}',
            headers=admin_headers(),
        )
        self.assertEqual(resp.status_code, 204)

        # Verify machine is gone.
        resp = self.client.get(PREFIX + f'/machines/{name}')
        self.assertEqual(resp.status_code, 404)

    def test_delete_nonexistent_404(self):
        """Deleting a nonexistent machine should return 404."""
        resp = self.client.delete(
            PREFIX + '/machines/nonexistent-del-xyz',
            headers=admin_headers(),
        )
        self.assertEqual(resp.status_code, 404)

    def test_delete_no_auth_401(self):
        """DELETE without auth returns 401."""
        name = f'del-noauth-{uuid.uuid4().hex[:8]}'
        self.client.post(
            PREFIX + '/machines',
            json={'name': name},
            headers=admin_headers(),
        )
        resp = self.client.delete(PREFIX + f'/machines/{name}')
        self.assertEqual(resp.status_code, 401)

    def test_delete_triage_scope_403(self):
        """DELETE with triage scope (one below manage) returns 403."""
        name = f'del-triage-{uuid.uuid4().hex[:8]}'
        self.client.post(
            PREFIX + '/machines',
            json={'name': name},
            headers=admin_headers(),
        )
        headers = make_scoped_headers(self.app, 'triage')
        resp = self.client.delete(
            PREFIX + f'/machines/{name}',
            headers=headers,
        )
        self.assertEqual(resp.status_code, 403)

    def test_delete_manage_scope_204(self):
        """DELETE with manage scope (the required scope) succeeds."""
        name = f'del-manage-{uuid.uuid4().hex[:8]}'
        self.client.post(
            PREFIX + '/machines',
            json={'name': name},
            headers=admin_headers(),
        )
        headers = make_scoped_headers(self.app, 'manage')
        resp = self.client.delete(
            PREFIX + f'/machines/{name}',
            headers=headers,
        )
        self.assertEqual(resp.status_code, 204)


class TestMachineRuns(unittest.TestCase):
    """Tests for GET /api/v5/{ts}/machines/{machine_name}/runs."""
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.app = create_app(sys.argv[1])
        cls.client = create_client(cls.app)

    def test_list_runs_for_machine(self):
        """List runs for a machine."""
        name = f'runs-list-{uuid.uuid4().hex[:8]}'
        submit_run(self.client, name, f'rev-{uuid.uuid4().hex[:6]}',
                   [{'name': 'p/test', 'execution_time': [0.0]}])

        resp = self.client.get(PREFIX + f'/machines/{name}/runs')
        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        self.assertIn('items', data)
        self.assertGreater(len(data['items']), 0)
        # Verify run fields
        item = data['items'][0]
        self.assertIn('uuid', item)
        self.assertIn('commit', item)
        self.assertIn('submitted_at', item)

    def test_list_runs_empty(self):
        """Machine with no runs returns empty list."""
        name = f'runs-empty-{uuid.uuid4().hex[:8]}'
        self.client.post(
            PREFIX + '/machines',
            json={'name': name},
            headers=admin_headers(),
        )
        resp = self.client.get(PREFIX + f'/machines/{name}/runs')
        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        self.assertEqual(len(data['items']), 0)

    def test_list_runs_pagination(self):
        """Test pagination of runs for a machine."""
        name = f'runs-page-{uuid.uuid4().hex[:8]}'
        db = self.app.instance.get_database("default")
        session = db.make_session()
        ts = db.testsuite[TS]
        machine = create_machine(session, ts, name=name)
        # Create 3 runs with distinct timestamps
        for i in range(3):
            commit = create_commit(
                session, ts,
                commit=f'page-rev-{uuid.uuid4().hex[:8]}')
            create_run(session, ts, machine, commit,
                       submitted_at=datetime.datetime(
                           2024, 1, 1 + i, 12, 0, 0))
        session.commit()
        session.close()

        # Request with limit=2
        resp = self.client.get(
            PREFIX + f'/machines/{name}/runs?limit=2')
        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        self.assertEqual(len(data['items']), 2)
        self.assertIsNotNone(data['cursor']['next'])

        # Follow the cursor
        cursor = data['cursor']['next']
        resp2 = self.client.get(
            PREFIX + f'/machines/{name}/runs?limit=2&cursor={cursor}')
        self.assertEqual(resp2.status_code, 200)
        data2 = resp2.get_json()
        self.assertEqual(len(data2['items']), 1)
        self.assertIsNone(data2['cursor']['next'])

    def test_list_runs_after_filter(self):
        """Filter runs by after datetime."""
        name = f'runs-after-{uuid.uuid4().hex[:8]}'
        db = self.app.instance.get_database("default")
        session = db.make_session()
        ts = db.testsuite[TS]
        machine = create_machine(session, ts, name=name)
        c1 = create_commit(
            session, ts, commit=f'after-1-{uuid.uuid4().hex[:8]}')
        create_run(session, ts, machine, c1,
                   submitted_at=datetime.datetime(2024, 1, 1, 12, 0, 0))
        c2 = create_commit(
            session, ts, commit=f'after-2-{uuid.uuid4().hex[:8]}')
        create_run(session, ts, machine, c2,
                   submitted_at=datetime.datetime(2024, 6, 1, 12, 0, 0))
        session.commit()
        session.close()

        resp = self.client.get(
            PREFIX + f'/machines/{name}/runs?after=2024-03-01T00:00:00')
        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        self.assertEqual(len(data['items']), 1)

    def test_list_runs_sort_descending(self):
        """Sort runs by -submitted_at returns newest first."""
        name = f'runs-sort-{uuid.uuid4().hex[:8]}'
        db = self.app.instance.get_database("default")
        session = db.make_session()
        ts = db.testsuite[TS]
        machine = create_machine(session, ts, name=name)
        for month in (1, 4, 7):
            c = create_commit(
                session, ts,
                commit=f'sort-{month}-{uuid.uuid4().hex[:8]}')
            create_run(session, ts, machine, c,
                       submitted_at=datetime.datetime(
                           2024, month, 1, 12, 0, 0))
        session.commit()
        session.close()

        # Default order (ascending by ID)
        resp_default = self.client.get(
            PREFIX + f'/machines/{name}/runs')
        default_times = [
            item['submitted_at']
            for item in resp_default.get_json()['items']]

        # Descending by submitted_at
        resp_sorted = self.client.get(
            PREFIX + f'/machines/{name}/runs?sort=-submitted_at')
        sorted_times = [
            item['submitted_at']
            for item in resp_sorted.get_json()['items']]

        self.assertEqual(len(sorted_times), 3)
        self.assertEqual(sorted_times, list(reversed(default_times)))

    def test_list_runs_nonexistent_machine_404(self):
        """Listing runs for a nonexistent machine should return 404."""
        resp = self.client.get(
            PREFIX + '/machines/nonexistent-machine-runs/runs')
        self.assertEqual(resp.status_code, 404)

    def test_list_runs_before_filter(self):
        """Filter runs by before datetime."""
        name = f'runs-before-{uuid.uuid4().hex[:8]}'
        db = self.app.instance.get_database("default")
        session = db.make_session()
        ts = db.testsuite[TS]
        machine = create_machine(session, ts, name=name)
        c1 = create_commit(
            session, ts, commit=f'before-1-{uuid.uuid4().hex[:8]}')
        create_run(session, ts, machine, c1,
                   submitted_at=datetime.datetime(2024, 1, 1, 12, 0, 0))
        c2 = create_commit(
            session, ts, commit=f'before-2-{uuid.uuid4().hex[:8]}')
        create_run(session, ts, machine, c2,
                   submitted_at=datetime.datetime(2024, 6, 1, 12, 0, 0))
        session.commit()
        session.close()

        resp = self.client.get(
            PREFIX + f'/machines/{name}/runs?before=2024-03-01T00:00:00')
        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        self.assertEqual(len(data['items']), 1)

    def test_invalid_cursor_returns_400(self):
        """An invalid cursor string on machine runs should return 400."""
        name = f'cursor-bad-{uuid.uuid4().hex[:8]}'
        self.client.post(
            PREFIX + '/machines',
            json={'name': name},
            headers=admin_headers(),
        )
        resp = self.client.get(
            PREFIX + f'/machines/{name}/runs?cursor=not-a-valid-cursor!!!')
        self.assertEqual(resp.status_code, 400)

    def test_machine_runs_pagination(self):
        """Paginating through machine runs collects all items."""
        name = f'pag-mruns-{uuid.uuid4().hex[:8]}'
        db = self.app.instance.get_database("default")
        session = db.make_session()
        ts = db.testsuite[TS]
        machine = create_machine(session, ts, name=name)
        for i in range(5):
            c = create_commit(
                session, ts,
                commit=f'pag-mr-{i}-{uuid.uuid4().hex[:8]}')
            create_run(session, ts, machine, c,
                       submitted_at=datetime.datetime(2024, 1, 1 + i, 12, 0, 0))
        session.commit()
        session.close()

        url = PREFIX + f'/machines/{name}/runs?limit=2'
        all_items = collect_all_pages(self, self.client, url)
        self.assertEqual(len(all_items), 5)
        uuids = [item['uuid'] for item in all_items]
        self.assertEqual(len(set(uuids)), 5)


class TestMachineSearch(unittest.TestCase):
    """Test machine list search parameter."""
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.app = create_app(sys.argv[1])
        cls.client = create_client(cls.app)

    def test_search_by_name_prefix(self):
        """Search machines by name prefix."""
        unique = uuid.uuid4().hex[:8]
        prefix = f'search-{unique}'
        name = f'{prefix}-machine'
        self.client.post(
            PREFIX + '/machines',
            json={'name': name},
            headers=admin_headers(),
        )
        resp = self.client.get(
            PREFIX + f'/machines?search={prefix}')
        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        self.assertGreater(len(data['items']), 0)
        for m in data['items']:
            self.assertTrue(m['name'].startswith(prefix))

    def test_search_by_machine_field(self):
        """Search matches against searchable machine fields, not just name."""
        unique = uuid.uuid4().hex[:8]
        name = f'field-search-{unique}'
        os_value = f'SpecialOS-{unique}'
        self.client.post(
            PREFIX + '/machines',
            json={'name': name, 'info': {'os': os_value}},
            headers=admin_headers(),
        )
        # Search by the os field value prefix — should find the machine
        # even though the name doesn't match the search term.
        resp = self.client.get(
            PREFIX + f'/machines?search=SpecialOS-{unique}')
        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        names = [m['name'] for m in data['items']]
        self.assertIn(name, names)


class TestMachineUnknownParams(unittest.TestCase):
    """Test that unknown query parameters are rejected with 400."""
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.app = create_app(sys.argv[1])
        cls.client = create_client(cls.app)

    def test_machines_list_unknown_param_returns_400(self):
        resp = self.client.get(PREFIX + '/machines?bogus=1')
        self.assertEqual(resp.status_code, 400)
        data = resp.get_json()
        self.assertIn('bogus', data['error']['message'])

    def test_machine_detail_unknown_param_returns_400(self):
        name = f'unk-det-{uuid.uuid4().hex[:8]}'
        self.client.post(
            PREFIX + '/machines',
            json={'name': name},
            headers=admin_headers(),
        )
        resp = self.client.get(PREFIX + f'/machines/{name}?bogus=1')
        self.assertEqual(resp.status_code, 400)

    def test_machine_runs_unknown_param_returns_400(self):
        name = f'unk-runs-{uuid.uuid4().hex[:8]}'
        self.client.post(
            PREFIX + '/machines',
            json={'name': name},
            headers=admin_headers(),
        )
        resp = self.client.get(
            PREFIX + f'/machines/{name}/runs?bogus=1')
        self.assertEqual(resp.status_code, 400)


if __name__ == '__main__':
    unittest.main(argv=[sys.argv[0]], exit=True)

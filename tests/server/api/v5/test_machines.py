# Tests for the v5 machine endpoints.
#
# RUN: rm -rf %t.instance %t.pg.log
# RUN: %{utils}/with_postgres.sh %t.pg.log \
# RUN:     %{utils}/with_temporary_instance.py %t.instance \
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
    create_machine, create_order, create_run, collect_all_pages,
    create_test, create_fieldchange, create_regression,
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

    def test_create_machine_read_scope_403(self):
        """Creating with read scope should return 403."""
        headers = make_scoped_headers(self.app, 'read')
        resp = self.client.post(
            PREFIX + '/machines',
            json={'name': 'read-only-test'},
            headers=headers,
        )
        self.assertEqual(resp.status_code, 403)

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
        # Check Location header
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
        db = self.app.instance.get_database("default")
        session = db.make_session()
        ts = db.testsuite[TS]
        machine = create_machine(session, ts, name=name)
        order = create_order(session, ts, revision='del-rev-1')
        create_run(session, ts, machine, order)
        session.commit()
        session.close()

        resp = self.client.delete(
            PREFIX + f'/machines/{name}',
            headers=admin_headers(),
        )
        self.assertEqual(resp.status_code, 204)

        # Verify machine is gone
        resp = self.client.get(PREFIX + f'/machines/{name}')
        self.assertEqual(resp.status_code, 404)

    def test_delete_machine_with_regression_indicators(self):
        """Delete machine whose FieldChanges are linked to RegressionIndicators.

        This verifies that the delete handler cleans up RegressionIndicator
        rows (which have an FK to FieldChange) before cascading deletion of
        the machine's runs and field changes.  Without the cleanup, Postgres
        would raise an FK violation.
        """
        name = f'delete-ri-{uuid.uuid4().hex[:8]}'
        db = self.app.instance.get_database("default")
        session = db.make_session()
        ts = db.testsuite[TS]

        # Create machine, two orders, a run, a test, a field change,
        # and a regression with an indicator pointing to that field change.
        machine = create_machine(session, ts, name=name)
        order1 = create_order(session, ts, revision=f'ri-rev1-{name}')
        order2 = create_order(session, ts, revision=f'ri-rev2-{name}')
        run = create_run(session, ts, machine, order2)
        test = create_test(
            session, ts, name=f'ri/test/{uuid.uuid4().hex[:8]}')
        field = ts.sample_fields[0]
        fc = create_fieldchange(session, ts, order1, order2, machine, test,
                                field, old_value=1.0, new_value=2.0, run=run)
        create_regression(
            session, ts, title=f'Reg for {name}', field_changes=[fc])

        # Verify the indicator exists.
        ri_count = session.query(ts.RegressionIndicator).filter(
            ts.RegressionIndicator.field_change_id == fc.id
        ).count()
        self.assertEqual(ri_count, 1)

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
        db = self.app.instance.get_database("default")
        session = db.make_session()
        ts = db.testsuite[TS]
        machine = create_machine(session, ts, name=name)
        order = create_order(session, ts, revision='run-rev-1')
        create_run(session, ts, machine, order,
                   start_time=datetime.datetime(2024, 6, 1, 12, 0, 0),
                   end_time=datetime.datetime(2024, 6, 1, 12, 30, 0))
        session.commit()
        session.close()

        resp = self.client.get(PREFIX + f'/machines/{name}/runs')
        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        self.assertIn('items', data)
        self.assertGreater(len(data['items']), 0)
        # Verify run fields
        item = data['items'][0]
        self.assertIn('uuid', item)
        self.assertIn('order', item)
        self.assertIn('start_time', item)
        self.assertIn('end_time', item)

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
        # Create 3 runs
        for i in range(3):
            order = create_order(session, ts, revision=f'page-rev-{i}')
            create_run(session, ts, machine, order,
                       start_time=datetime.datetime(2024, 1, 1 + i, 12, 0, 0))
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
        order1 = create_order(session, ts, revision='after-rev-1')
        create_run(session, ts, machine, order1,
                   start_time=datetime.datetime(2024, 1, 1, 12, 0, 0))
        order2 = create_order(session, ts, revision='after-rev-2')
        create_run(session, ts, machine, order2,
                   start_time=datetime.datetime(2024, 6, 1, 12, 0, 0))
        session.commit()
        session.close()

        resp = self.client.get(
            PREFIX + f'/machines/{name}/runs?after=2024-03-01T00:00:00')
        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        self.assertEqual(len(data['items']), 1)

    def test_list_runs_before_filter(self):
        """Filter runs by before datetime."""
        name = f'runs-before-{uuid.uuid4().hex[:8]}'
        db = self.app.instance.get_database("default")
        session = db.make_session()
        ts = db.testsuite[TS]
        machine = create_machine(session, ts, name=name)
        order1 = create_order(session, ts, revision='before-rev-1')
        create_run(session, ts, machine, order1,
                   start_time=datetime.datetime(2024, 1, 1, 12, 0, 0))
        order2 = create_order(session, ts, revision='before-rev-2')
        create_run(session, ts, machine, order2,
                   start_time=datetime.datetime(2024, 6, 1, 12, 0, 0))
        session.commit()
        session.close()

        resp = self.client.get(
            PREFIX + f'/machines/{name}/runs?before=2024-03-01T00:00:00')
        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        self.assertEqual(len(data['items']), 1)

    def test_list_runs_sort_descending(self):
        """Sort runs by -start_time returns newest first."""
        name = f'runs-sort-{uuid.uuid4().hex[:8]}'
        db = self.app.instance.get_database("default")
        session = db.make_session()
        ts = db.testsuite[TS]
        machine = create_machine(session, ts, name=name)
        for month in (1, 4, 7):
            order = create_order(
                session, ts,
                revision=f'sort-rev-{month}-{uuid.uuid4().hex[:6]}')
            create_run(session, ts, machine, order,
                       start_time=datetime.datetime(2024, month, 1, 12, 0, 0))
        session.commit()
        session.close()

        # Default order (ascending by ID)
        resp_default = self.client.get(
            PREFIX + f'/machines/{name}/runs')
        self.assertEqual(resp_default.status_code, 200)
        default_times = [
            item['start_time'] for item in resp_default.get_json()['items']]

        # Descending by start_time
        resp_sorted = self.client.get(
            PREFIX + f'/machines/{name}/runs?sort=-start_time')
        self.assertEqual(resp_sorted.status_code, 200)
        sorted_times = [
            item['start_time'] for item in resp_sorted.get_json()['items']]

        self.assertEqual(len(sorted_times), 3)
        self.assertEqual(sorted_times, list(reversed(default_times)))

    def test_list_runs_nonexistent_machine_404(self):
        """Listing runs for a nonexistent machine should return 404."""
        resp = self.client.get(
            PREFIX + '/machines/nonexistent-machine-runs/runs')
        self.assertEqual(resp.status_code, 404)

    def test_invalid_cursor_returns_400(self):
        """An invalid cursor string should return 400."""
        name = f'cursor-bad-{uuid.uuid4().hex[:8]}'
        db = self.app.instance.get_database("default")
        session = db.make_session()
        ts = db.testsuite[TS]
        create_machine(session, ts, name=name)
        session.commit()
        session.close()

        resp = self.client.get(
            PREFIX + f'/machines/{name}/runs?cursor=not-a-valid-cursor!!!')
        self.assertEqual(resp.status_code, 400)


class TestMachineRunsPagination(unittest.TestCase):
    """Exhaustive cursor pagination tests for GET /api/v5/{ts}/machines/{name}/runs."""
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.app = create_app(sys.argv[1])
        cls.client = create_client(cls.app)
        cls._machine_name = f'pag-mruns-{uuid.uuid4().hex[:8]}'
        db = cls.app.instance.get_database("default")
        session = db.make_session()
        ts = db.testsuite[TS]
        machine = create_machine(session, ts, name=cls._machine_name)
        for i in range(5):
            order = create_order(
                session, ts,
                revision=f'pag-mr-rev-{uuid.uuid4().hex[:6]}-{i}')
            create_run(session, ts, machine, order,
                       start_time=datetime.datetime(2024, 1, 1 + i, 12, 0, 0))
        session.commit()
        session.close()

    def _collect_all_pages(self):
        url = PREFIX + f'/machines/{self._machine_name}/runs?limit=2'
        return collect_all_pages(self, self.client, url)

    def test_pagination_collects_all_items(self):
        """Paginating through all pages collects all 5 runs."""
        all_items = self._collect_all_pages()
        self.assertEqual(len(all_items), 5)

    def test_no_duplicate_items_across_pages(self):
        """No duplicate run UUIDs across pages."""
        all_items = self._collect_all_pages()
        uuids = [item['uuid'] for item in all_items]
        self.assertEqual(len(uuids), len(set(uuids)))


class TestMachineFilter(unittest.TestCase):
    """Test machine list filtering."""
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.app = create_app(sys.argv[1])
        cls.client = create_client(cls.app)

    def test_filter_name_contains(self):
        """Filter machines by name_contains."""
        unique = uuid.uuid4().hex[:8]
        name = f'filter-contains-{unique}'
        self.client.post(
            PREFIX + '/machines',
            json={'name': name},
            headers=admin_headers(),
        )
        resp = self.client.get(
            PREFIX + f'/machines?name_contains={unique}')
        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        self.assertGreater(len(data['items']), 0)
        for m in data['items']:
            self.assertIn(unique, m['name'])

    def test_filter_name_prefix(self):
        """Filter machines by name_prefix."""
        unique = uuid.uuid4().hex[:8]
        prefix = f'prefix-{unique}'
        name = f'{prefix}-machine'
        self.client.post(
            PREFIX + '/machines',
            json={'name': name},
            headers=admin_headers(),
        )
        resp = self.client.get(
            PREFIX + f'/machines?name_prefix={prefix}')
        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        self.assertGreater(len(data['items']), 0)
        for m in data['items']:
            self.assertTrue(m['name'].startswith(prefix))


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

    def test_machines_list_typo_param_returns_400(self):
        resp = self.client.get(PREFIX + '/machines?name_contain=foo')
        self.assertEqual(resp.status_code, 400)
        data = resp.get_json()
        self.assertIn('name_contain', data['error']['message'])

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


class TestDuplicateMachineNames(unittest.TestCase):
    """Tests that duplicate machine names produce 409 Conflict.

    Machine names are NOT unique in the DB.  When a lookup-by-name finds
    more than one row the API must return 409 (not silently pick one).
    """
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.app = create_app(sys.argv[1])
        cls.client = create_client(cls.app)
        # Insert two machines with the same name directly in the DB
        cls.dup_name = f'dup-machine-{uuid.uuid4().hex[:8]}'
        db = cls.app.instance.get_database("default")
        session = db.make_session()
        ts = db.testsuite[TS]
        create_machine(session, ts, name=cls.dup_name)
        create_machine(session, ts, name=cls.dup_name)
        session.commit()
        session.close()

    def test_get_detail_returns_409(self):
        """GET /machines/{name} returns 409 when name is ambiguous."""
        resp = self.client.get(PREFIX + f'/machines/{self.dup_name}')
        self.assertEqual(resp.status_code, 409)
        data = resp.get_json()
        self.assertIn('Multiple machines', data['error']['message'])

    def test_patch_returns_409(self):
        """PATCH /machines/{name} returns 409 when name is ambiguous."""
        resp = self.client.patch(
            PREFIX + f'/machines/{self.dup_name}',
            json={'info': {'key': 'value'}},
            headers=admin_headers(),
        )
        self.assertEqual(resp.status_code, 409)
        data = resp.get_json()
        self.assertIn('Multiple machines', data['error']['message'])

    def test_delete_returns_409(self):
        """DELETE /machines/{name} returns 409 when name is ambiguous."""
        resp = self.client.delete(
            PREFIX + f'/machines/{self.dup_name}',
            headers=admin_headers(),
        )
        self.assertEqual(resp.status_code, 409)
        data = resp.get_json()
        self.assertIn('Multiple machines', data['error']['message'])

    def test_get_runs_returns_409(self):
        """GET /machines/{name}/runs returns 409 when name is ambiguous."""
        resp = self.client.get(
            PREFIX + f'/machines/{self.dup_name}/runs')
        self.assertEqual(resp.status_code, 409)
        data = resp.get_json()
        self.assertIn('Multiple machines', data['error']['message'])


if __name__ == '__main__':
    unittest.main(argv=[sys.argv[0]], exit=True)

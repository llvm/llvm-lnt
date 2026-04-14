# Tests for the v5 field change triage endpoints.
#
# RUN: rm -rf %t.instance %t.pg.log
# RUN: %{utils}/with_postgres.sh %t.pg.log \
# RUN:     %{utils}/with_temporary_instance.py --db-version 5.0 %t.instance \
# RUN:         -- python %s %t.instance
# END.

import json
import sys
import os
import unittest
import uuid

sys.path.insert(0, os.path.dirname(__file__))
from v5_test_helpers import (
    create_app, create_client, make_scoped_headers, admin_headers,
    collect_all_pages, submit_run, submit_fieldchange,
    create_machine, create_commit, create_test,
    create_fieldchange, create_regression,
)


def _submit_headers(app):
    return make_scoped_headers(app, 'submit')


TS = 'nts'
PREFIX = f'/api/v5/{TS}'


def _create_fieldchange_fixture(client, app, prefix='fc',
                                old_value=10.0, new_value=20.0):
    """Create a machine, two runs, and a field change via the API.

    Returns the field change UUID.
    """
    tag = uuid.uuid4().hex[:8]
    machine = f'{prefix}-m-{tag}'
    rev1 = f'{prefix}-o1-{tag}'
    rev2 = f'{prefix}-o2-{tag}'
    test = f'{prefix}/test/{tag}'
    submit_run(client, machine, rev1,
               [{'name': test, 'execution_time': [1.0]}])
    submit_run(client, machine, rev2,
               [{'name': test, 'execution_time': [2.0]}])
    fc = submit_fieldchange(client, app, machine, test,
                            'execution_time', rev1, rev2,
                            old_value=old_value, new_value=new_value)
    return fc['uuid']


def _create_unassigned_fieldchange(client, app):
    """Create an unassigned field change."""
    return _create_fieldchange_fixture(client, app)


def _create_assigned_fieldchange(app):
    """Create a field change assigned to a regression via direct DB helpers.

    Uses direct DB helpers because the regressions endpoint is not yet
    rewritten.
    """
    tag = uuid.uuid4().hex[:8]
    db = app.instance.get_database("default")
    session = db.make_session()
    ts = db.testsuite[TS]

    machine = create_machine(session, ts, name=f'fc-assigned-m-{tag}')
    test = create_test(session, ts, name=f'fc-assigned/test/{tag}')
    c1 = create_commit(session, ts, commit=f'fc-assigned-c1-{tag}')
    c2 = create_commit(session, ts, commit=f'fc-assigned-c2-{tag}')

    fc = create_fieldchange(session, ts, c1, c2, machine, test,
                            'execution_time', old_value=1.0, new_value=2.0)
    create_regression(session, ts, field_changes=[fc])
    session.commit()
    fc_uuid = fc.uuid
    session.close()
    return fc_uuid


# ==========================================================================
# Field Change List (Unassigned) Tests
# ==========================================================================

class TestFieldChangeList(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.app = create_app(sys.argv[1])
        cls.client = create_client(cls.app)

    def test_list_returns_200(self):
        resp = self.client.get(PREFIX + '/field-changes')
        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        self.assertIn('items', data)
        self.assertIsInstance(data['items'], list)

    def test_list_has_pagination_envelope(self):
        resp = self.client.get(PREFIX + '/field-changes')
        data = resp.get_json()
        self.assertIn('cursor', data)
        self.assertIn('next', data['cursor'])
        self.assertIn('previous', data['cursor'])

    def test_list_contains_unassigned_fc(self):
        fc_uuid = _create_unassigned_fieldchange(self.client, self.app)
        resp = self.client.get(PREFIX + '/field-changes')
        data = resp.get_json()
        uuids = [fc['uuid'] for fc in data['items']]
        self.assertIn(fc_uuid, uuids)

    def test_list_excludes_assigned_fc(self):
        """Field changes with a RegressionIndicator should NOT appear."""
        assigned_uuid = _create_assigned_fieldchange(self.app)
        resp = self.client.get(PREFIX + '/field-changes')
        data = resp.get_json()
        uuids = [fc['uuid'] for fc in data['items']]
        self.assertNotIn(assigned_uuid, uuids)

    def test_list_item_has_expected_fields(self):
        _create_unassigned_fieldchange(self.client, self.app)
        resp = self.client.get(PREFIX + '/field-changes')
        data = resp.get_json()
        if data['items']:
            item = data['items'][0]
            self.assertIn('uuid', item)
            self.assertIn('test', item)
            self.assertIn('machine', item)
            self.assertIn('metric', item)
            self.assertIn('old_value', item)
            self.assertIn('new_value', item)
            self.assertIn('start_commit', item)
            self.assertIn('end_commit', item)

    def test_list_filter_by_machine(self):
        """Filter unassigned field changes by machine name."""
        unique = uuid.uuid4().hex[:8]
        machine_name = f'fc-filter-m-{unique}'
        rev1 = f'fc-fm-o1-{uuid.uuid4().hex[:8]}'
        rev2 = f'fc-fm-o2-{uuid.uuid4().hex[:8]}'
        test_name = f'fc/filter-m/{uuid.uuid4().hex[:8]}'
        submit_run(self.client, machine_name, rev1,
                   [{'name': test_name, 'execution_time': [1.0]}])
        submit_run(self.client, machine_name, rev2,
                   [{'name': test_name, 'execution_time': [2.0]}])
        fc = submit_fieldchange(self.client, self.app, machine_name,
                                test_name, 'execution_time', rev1, rev2)
        fc_uuid = fc['uuid']

        resp = self.client.get(
            PREFIX + f'/field-changes?machine={machine_name}')
        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        for item in data['items']:
            self.assertEqual(item['machine'], machine_name)
        uuids = [item['uuid'] for item in data['items']]
        self.assertIn(fc_uuid, uuids)

    def test_list_filter_by_test(self):
        """Filter unassigned field changes by test name."""
        unique = uuid.uuid4().hex[:8]
        test_name = f'fc/filter-t/{unique}'
        machine_name = f'fc-ft-m-{uuid.uuid4().hex[:8]}'
        rev1 = f'fc-ft-o1-{uuid.uuid4().hex[:8]}'
        rev2 = f'fc-ft-o2-{uuid.uuid4().hex[:8]}'
        submit_run(self.client, machine_name, rev1,
                   [{'name': test_name, 'execution_time': [1.0]}])
        submit_run(self.client, machine_name, rev2,
                   [{'name': test_name, 'execution_time': [2.0]}])
        fc = submit_fieldchange(self.client, self.app, machine_name,
                                test_name, 'execution_time', rev1, rev2)
        fc_uuid = fc['uuid']

        resp = self.client.get(
            PREFIX + f'/field-changes?test={test_name}')
        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        for item in data['items']:
            self.assertEqual(item['test'], test_name)
        uuids = [item['uuid'] for item in data['items']]
        self.assertIn(fc_uuid, uuids)

    def test_list_filter_by_metric(self):
        """Filter unassigned field changes by metric name."""
        unique = uuid.uuid4().hex[:8]
        machine_name = f'fc-filter-met-{unique}'
        rev1 = f'fc-fmet-o1-{uuid.uuid4().hex[:8]}'
        rev2 = f'fc-fmet-o2-{uuid.uuid4().hex[:8]}'
        test_name = f'fc/filter-met/{uuid.uuid4().hex[:8]}'
        submit_run(self.client, machine_name, rev1,
                   [{'name': test_name, 'execution_time': [1.0]}])
        submit_run(self.client, machine_name, rev2,
                   [{'name': test_name, 'execution_time': [2.0]}])
        fc = submit_fieldchange(self.client, self.app, machine_name,
                                test_name, 'execution_time', rev1, rev2)
        fc_uuid = fc['uuid']

        resp = self.client.get(
            PREFIX + '/field-changes?metric=execution_time')
        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        for item in data['items']:
            self.assertEqual(item['metric'], 'execution_time')
        uuids = [item['uuid'] for item in data['items']]
        self.assertIn(fc_uuid, uuids)

    def test_list_filter_nonexistent_machine_404(self):
        """Filtering by a nonexistent machine name returns 404."""
        resp = self.client.get(
            PREFIX + '/field-changes?machine=no-such-machine-xyz')
        self.assertEqual(resp.status_code, 404)

    def test_list_filter_nonexistent_test_404(self):
        """Filtering by a nonexistent test name returns 404."""
        resp = self.client.get(
            PREFIX + '/field-changes?test=no/such/test/xyz')
        self.assertEqual(resp.status_code, 404)

    def test_list_filter_unknown_metric_400(self):
        """Filtering by an unknown metric name returns 400."""
        resp = self.client.get(
            PREFIX + '/field-changes?metric=no_such_metric_xyz')
        self.assertEqual(resp.status_code, 400)

    def test_list_pagination(self):
        """Test pagination of unassigned field changes."""
        for _ in range(3):
            _create_unassigned_fieldchange(self.client, self.app)
        resp = self.client.get(PREFIX + '/field-changes?limit=2')
        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        self.assertLessEqual(len(data['items']), 2)
        if data['cursor']['next']:
            cursor = data['cursor']['next']
            resp2 = self.client.get(
                PREFIX + f'/field-changes?limit=2&cursor={cursor}')
            self.assertEqual(resp2.status_code, 200)

    def test_invalid_cursor_returns_400(self):
        """An invalid cursor string should return 400."""
        resp = self.client.get(
            PREFIX + '/field-changes?cursor=not-a-valid-cursor!!!')
        self.assertEqual(resp.status_code, 400)


# ==========================================================================
# Pagination Tests
# ==========================================================================

class TestFieldChangePagination(unittest.TestCase):
    """Exhaustive cursor pagination tests for GET /api/v5/{ts}/field-changes."""
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.app = create_app(sys.argv[1])
        cls.client = create_client(cls.app)
        cls._machine_name = f'pag-fc-m-{uuid.uuid4().hex[:8]}'
        rev1 = f'pag-fc-o1-{uuid.uuid4().hex[:8]}'
        rev2 = f'pag-fc-o2-{uuid.uuid4().hex[:8]}'
        submit_run(cls.client, cls._machine_name, rev1,
                   [{'name': f'pag-fc/test/{i}', 'execution_time': [1.0]}
                    for i in range(5)])
        submit_run(cls.client, cls._machine_name, rev2,
                   [{'name': f'pag-fc/test/{i}', 'execution_time': [2.0]}
                    for i in range(5)])
        for i in range(5):
            submit_fieldchange(cls.client, cls.app, cls._machine_name,
                               f'pag-fc/test/{i}', 'execution_time',
                               rev1, rev2,
                               old_value=float(i), new_value=float(i + 10))

    def _collect_all_pages(self):
        url = PREFIX + f'/field-changes?machine={self._machine_name}&limit=2'
        return collect_all_pages(self, self.client, url)

    def test_pagination_collects_all_items(self):
        """Paginating through all pages collects all 5 field changes."""
        all_items = self._collect_all_pages()
        self.assertEqual(len(all_items), 5)

    def test_no_duplicate_items_across_pages(self):
        """No duplicate field change UUIDs across pages."""
        all_items = self._collect_all_pages()
        uuids = [item['uuid'] for item in all_items]
        self.assertEqual(len(uuids), len(set(uuids)))


class TestFieldChangeUnknownParams(unittest.TestCase):
    """Test that unknown query parameters are rejected with 400."""
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.app = create_app(sys.argv[1])
        cls.client = create_client(cls.app)

    def test_field_changes_list_unknown_param_returns_400(self):
        resp = self.client.get(PREFIX + '/field-changes?bogus=1')
        self.assertEqual(resp.status_code, 400)
        data = resp.get_json()
        self.assertIn('bogus', data['error']['message'])


# ==========================================================================
# Field Change Creation Tests
# ==========================================================================

class TestFieldChangeCreate(unittest.TestCase):
    """Tests for POST /api/v5/{ts}/field-changes."""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.app = create_app(sys.argv[1])
        cls.client = create_client(cls.app)

        cls._machine_name = f'create-fc-m-{uuid.uuid4().hex[:8]}'
        cls._test_name = f'create-fc/test/{uuid.uuid4().hex[:8]}'
        cls._start_commit = f'create-fc-c1-{uuid.uuid4().hex[:8]}'
        cls._end_commit = f'create-fc-c2-{uuid.uuid4().hex[:8]}'
        cls._field_name = 'execution_time'

        submit_run(cls.client, cls._machine_name, cls._start_commit,
                   [{'name': cls._test_name, 'execution_time': [1.0]}])
        submit_run(cls.client, cls._machine_name, cls._end_commit,
                   [{'name': cls._test_name, 'execution_time': [2.0]}])

    def _valid_body(self, **overrides):
        """Return a valid POST body dict with optional overrides."""
        body = {
            'machine': self._machine_name,
            'test': self._test_name,
            'metric': self._field_name,
            'old_value': 10.0,
            'new_value': 20.0,
            'start_commit': self._start_commit,
            'end_commit': self._end_commit,
        }
        body.update(overrides)
        return body

    # -- Happy path --

    def test_create_field_change_201(self):
        """POST with valid body returns 201 and correct fields."""
        headers = _submit_headers(self.app)
        headers['Content-Type'] = 'application/json'
        body = self._valid_body()
        resp = self.client.post(
            PREFIX + '/field-changes',
            data=json.dumps(body),
            headers=headers,
        )
        self.assertEqual(resp.status_code, 201)
        data = resp.get_json()
        self.assertIn('uuid', data)
        self.assertEqual(data['machine'], self._machine_name)
        self.assertEqual(data['test'], self._test_name)
        self.assertEqual(data['metric'], self._field_name)
        self.assertAlmostEqual(data['old_value'], 10.0)
        self.assertAlmostEqual(data['new_value'], 20.0)
        self.assertEqual(data['start_commit'], self._start_commit)
        self.assertEqual(data['end_commit'], self._end_commit)

    def test_each_create_gets_unique_uuid(self):
        """Two POSTs should produce field changes with different UUIDs."""
        headers = _submit_headers(self.app)
        headers['Content-Type'] = 'application/json'
        body = self._valid_body()
        resp1 = self.client.post(
            PREFIX + '/field-changes',
            data=json.dumps(body),
            headers=headers,
        )
        resp2 = self.client.post(
            PREFIX + '/field-changes',
            data=json.dumps(body),
            headers=headers,
        )
        self.assertEqual(resp1.status_code, 201)
        self.assertEqual(resp2.status_code, 201)
        self.assertNotEqual(
            resp1.get_json()['uuid'], resp2.get_json()['uuid'])

    def test_created_fc_appears_in_list(self):
        """A created field change should appear in GET /field-changes."""
        headers = _submit_headers(self.app)
        headers['Content-Type'] = 'application/json'
        body = self._valid_body()
        resp = self.client.post(
            PREFIX + '/field-changes',
            data=json.dumps(body),
            headers=headers,
        )
        self.assertEqual(resp.status_code, 201)
        created_uuid = resp.get_json()['uuid']

        # Fetch unassigned list
        resp2 = self.client.get(PREFIX + '/field-changes')
        self.assertEqual(resp2.status_code, 200)
        uuids = [fc['uuid'] for fc in resp2.get_json()['items']]
        self.assertIn(created_uuid, uuids)

    # -- Missing required fields --

    def test_missing_machine_422(self):
        headers = _submit_headers(self.app)
        headers['Content-Type'] = 'application/json'
        body = self._valid_body()
        del body['machine']
        resp = self.client.post(
            PREFIX + '/field-changes',
            data=json.dumps(body),
            headers=headers,
        )
        self.assertEqual(resp.status_code, 422)

    def test_missing_test_422(self):
        headers = _submit_headers(self.app)
        headers['Content-Type'] = 'application/json'
        body = self._valid_body()
        del body['test']
        resp = self.client.post(
            PREFIX + '/field-changes',
            data=json.dumps(body),
            headers=headers,
        )
        self.assertEqual(resp.status_code, 422)

    def test_missing_metric_422(self):
        headers = _submit_headers(self.app)
        headers['Content-Type'] = 'application/json'
        body = self._valid_body()
        del body['metric']
        resp = self.client.post(
            PREFIX + '/field-changes',
            data=json.dumps(body),
            headers=headers,
        )
        self.assertEqual(resp.status_code, 422)

    def test_missing_old_value_422(self):
        headers = _submit_headers(self.app)
        headers['Content-Type'] = 'application/json'
        body = self._valid_body()
        del body['old_value']
        resp = self.client.post(
            PREFIX + '/field-changes',
            data=json.dumps(body),
            headers=headers,
        )
        self.assertEqual(resp.status_code, 422)

    def test_missing_new_value_422(self):
        headers = _submit_headers(self.app)
        headers['Content-Type'] = 'application/json'
        body = self._valid_body()
        del body['new_value']
        resp = self.client.post(
            PREFIX + '/field-changes',
            data=json.dumps(body),
            headers=headers,
        )
        self.assertEqual(resp.status_code, 422)

    def test_missing_start_commit_422(self):
        headers = _submit_headers(self.app)
        headers['Content-Type'] = 'application/json'
        body = self._valid_body()
        del body['start_commit']
        resp = self.client.post(
            PREFIX + '/field-changes',
            data=json.dumps(body),
            headers=headers,
        )
        self.assertEqual(resp.status_code, 422)

    def test_missing_end_commit_422(self):
        headers = _submit_headers(self.app)
        headers['Content-Type'] = 'application/json'
        body = self._valid_body()
        del body['end_commit']
        resp = self.client.post(
            PREFIX + '/field-changes',
            data=json.dumps(body),
            headers=headers,
        )
        self.assertEqual(resp.status_code, 422)

    # -- Nonexistent references --

    def test_nonexistent_machine_404(self):
        headers = _submit_headers(self.app)
        headers['Content-Type'] = 'application/json'
        body = self._valid_body(machine='no-such-machine-xyz')
        resp = self.client.post(
            PREFIX + '/field-changes',
            data=json.dumps(body),
            headers=headers,
        )
        self.assertEqual(resp.status_code, 404)

    def test_nonexistent_test_404(self):
        headers = _submit_headers(self.app)
        headers['Content-Type'] = 'application/json'
        body = self._valid_body(test='no/such/test/xyz')
        resp = self.client.post(
            PREFIX + '/field-changes',
            data=json.dumps(body),
            headers=headers,
        )
        self.assertEqual(resp.status_code, 404)

    def test_unknown_metric_400(self):
        headers = _submit_headers(self.app)
        headers['Content-Type'] = 'application/json'
        body = self._valid_body(metric='no_such_field_xyz')
        resp = self.client.post(
            PREFIX + '/field-changes',
            data=json.dumps(body),
            headers=headers,
        )
        self.assertEqual(resp.status_code, 400)

    def test_nonexistent_start_commit_404(self):
        headers = _submit_headers(self.app)
        headers['Content-Type'] = 'application/json'
        body = self._valid_body(start_commit='nonexistent-commit-xyz')
        resp = self.client.post(
            PREFIX + '/field-changes',
            data=json.dumps(body),
            headers=headers,
        )
        self.assertEqual(resp.status_code, 404)

    def test_nonexistent_end_commit_404(self):
        headers = _submit_headers(self.app)
        headers['Content-Type'] = 'application/json'
        body = self._valid_body(end_commit='nonexistent-commit-xyz')
        resp = self.client.post(
            PREFIX + '/field-changes',
            data=json.dumps(body),
            headers=headers,
        )
        self.assertEqual(resp.status_code, 404)

    # -- Invalid body --

    def test_empty_body_400(self):
        headers = _submit_headers(self.app)
        headers['Content-Type'] = 'application/json'
        resp = self.client.post(
            PREFIX + '/field-changes',
            data='',
            headers=headers,
        )
        self.assertIn(resp.status_code, (400, 422))

    def test_invalid_json_400(self):
        headers = _submit_headers(self.app)
        headers['Content-Type'] = 'application/json'
        resp = self.client.post(
            PREFIX + '/field-changes',
            data='not json',
            headers=headers,
        )
        self.assertIn(resp.status_code, (400, 422))

    # -- Auth --

    def test_no_auth_401(self):
        body = self._valid_body()
        resp = self.client.post(
            PREFIX + '/field-changes',
            data=json.dumps(body),
            content_type='application/json',
        )
        self.assertEqual(resp.status_code, 401)

    def test_read_scope_403(self):
        headers = make_scoped_headers(self.app, 'read')
        headers['Content-Type'] = 'application/json'
        body = self._valid_body()
        resp = self.client.post(
            PREFIX + '/field-changes',
            data=json.dumps(body),
            headers=headers,
        )
        self.assertEqual(resp.status_code, 403)

    def test_admin_scope_201(self):
        """Admin scope should also be allowed (higher than submit)."""
        headers = admin_headers()
        headers['Content-Type'] = 'application/json'
        body = self._valid_body()
        resp = self.client.post(
            PREFIX + '/field-changes',
            data=json.dumps(body),
            headers=headers,
        )
        self.assertEqual(resp.status_code, 201)


if __name__ == '__main__':
    unittest.main(argv=[sys.argv[0]], exit=True)

# Tests for the v5 field change triage endpoints.
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
from v5_test_helpers import (
    create_app, create_client, make_scoped_headers, admin_headers,
    collect_all_pages, submit_run, submit_fieldchange, submit_regression,
)


def _submit_headers(app):
    return make_scoped_headers(app, 'submit')


TS = 'nts'
PREFIX = f'/api/v5/{TS}'


def _triage_headers(app):
    return make_scoped_headers(app, 'triage')


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
    """Create an unassigned, non-ignored field change."""
    return _create_fieldchange_fixture(client, app)


def _create_assigned_fieldchange(client, app):
    """Create a field change assigned to a regression."""
    fc_uuid = _create_fieldchange_fixture(client, app, prefix='fc-assigned',
                                          old_value=1.0, new_value=2.0)
    submit_regression(client, app, [fc_uuid])
    return fc_uuid


def _create_ignored_fieldchange(client, app):
    """Create an ignored field change."""
    fc_uuid = _create_fieldchange_fixture(client, app, prefix='fc-ign',
                                          old_value=5.0, new_value=10.0)
    headers = make_scoped_headers(app, 'triage')
    resp = client.post(f'/api/v5/nts/field-changes/{fc_uuid}/ignore',
                       headers=headers)
    assert resp.status_code == 201, f"Ignore failed: {resp.get_json()}"
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
        assigned_uuid = _create_assigned_fieldchange(self.client, self.app)
        resp = self.client.get(PREFIX + '/field-changes')
        data = resp.get_json()
        uuids = [fc['uuid'] for fc in data['items']]
        self.assertNotIn(assigned_uuid, uuids)

    def test_list_excludes_ignored_fc(self):
        """Field changes with a ChangeIgnore should NOT appear."""
        ignored_uuid = _create_ignored_fieldchange(self.client, self.app)
        resp = self.client.get(PREFIX + '/field-changes')
        data = resp.get_json()
        uuids = [fc['uuid'] for fc in data['items']]
        self.assertNotIn(ignored_uuid, uuids)

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
            self.assertIn('start_order', item)
            self.assertIn('end_order', item)
            self.assertIn('run_uuid', item)

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
# Ignore Tests
# ==========================================================================

class TestFieldChangeIgnore(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.app = create_app(sys.argv[1])
        cls.client = create_client(cls.app)

    def test_ignore_field_change(self):
        fc_uuid = _create_unassigned_fieldchange(self.client, self.app)
        headers = _triage_headers(self.app)
        resp = self.client.post(
            PREFIX + f'/field-changes/{fc_uuid}/ignore',
            headers=headers,
        )
        self.assertEqual(resp.status_code, 201)
        data = resp.get_json()
        self.assertEqual(data['status'], 'ignored')
        self.assertEqual(data['field_change_uuid'], fc_uuid)

    def test_ignore_removes_from_unassigned_list(self):
        fc_uuid = _create_unassigned_fieldchange(self.client, self.app)
        headers = _triage_headers(self.app)

        # Ignore it
        resp = self.client.post(
            PREFIX + f'/field-changes/{fc_uuid}/ignore',
            headers=headers,
        )
        self.assertEqual(resp.status_code, 201)

        # Verify it's no longer in the unassigned list
        resp2 = self.client.get(PREFIX + '/field-changes')
        data2 = resp2.get_json()
        uuids = [fc['uuid'] for fc in data2['items']]
        self.assertNotIn(fc_uuid, uuids)

    def test_ignore_already_ignored_409(self):
        fc_uuid = _create_unassigned_fieldchange(self.client, self.app)
        headers = _triage_headers(self.app)

        # Ignore once
        resp = self.client.post(
            PREFIX + f'/field-changes/{fc_uuid}/ignore',
            headers=headers,
        )
        self.assertEqual(resp.status_code, 201)

        # Ignore again -- should be 409
        resp2 = self.client.post(
            PREFIX + f'/field-changes/{fc_uuid}/ignore',
            headers=headers,
        )
        self.assertEqual(resp2.status_code, 409)

    def test_ignore_nonexistent_404(self):
        headers = _triage_headers(self.app)
        resp = self.client.post(
            PREFIX + '/field-changes/nonexistent-uuid/ignore',
            headers=headers,
        )
        self.assertEqual(resp.status_code, 404)

    def test_ignore_no_auth_401(self):
        fc_uuid = _create_unassigned_fieldchange(self.client, self.app)
        resp = self.client.post(
            PREFIX + f'/field-changes/{fc_uuid}/ignore',
        )
        self.assertEqual(resp.status_code, 401)

    def test_ignore_read_scope_403(self):
        fc_uuid = _create_unassigned_fieldchange(self.client, self.app)
        headers = make_scoped_headers(self.app, 'read')
        resp = self.client.post(
            PREFIX + f'/field-changes/{fc_uuid}/ignore',
            headers=headers,
        )
        self.assertEqual(resp.status_code, 403)


# ==========================================================================
# Un-ignore Tests
# ==========================================================================

class TestFieldChangeUnignore(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.app = create_app(sys.argv[1])
        cls.client = create_client(cls.app)

    def test_unignore_field_change(self):
        fc_uuid = _create_ignored_fieldchange(self.client, self.app)
        headers = _triage_headers(self.app)
        resp = self.client.delete(
            PREFIX + f'/field-changes/{fc_uuid}/ignore',
            headers=headers,
        )
        self.assertEqual(resp.status_code, 204)

    def test_unignore_restores_to_unassigned_list(self):
        fc_uuid = _create_ignored_fieldchange(self.client, self.app)
        headers = _triage_headers(self.app)

        # Un-ignore it
        resp = self.client.delete(
            PREFIX + f'/field-changes/{fc_uuid}/ignore',
            headers=headers,
        )
        self.assertEqual(resp.status_code, 204)

        # Verify it appears in the unassigned list
        resp2 = self.client.get(PREFIX + '/field-changes')
        data2 = resp2.get_json()
        uuids = [fc['uuid'] for fc in data2['items']]
        self.assertIn(fc_uuid, uuids)

    def test_unignore_not_ignored_404(self):
        """Un-ignoring a field change that's not ignored should return 404."""
        fc_uuid = _create_unassigned_fieldchange(self.client, self.app)
        headers = _triage_headers(self.app)
        resp = self.client.delete(
            PREFIX + f'/field-changes/{fc_uuid}/ignore',
            headers=headers,
        )
        self.assertEqual(resp.status_code, 404)

    def test_unignore_nonexistent_404(self):
        headers = _triage_headers(self.app)
        resp = self.client.delete(
            PREFIX + '/field-changes/nonexistent-uuid/ignore',
            headers=headers,
        )
        self.assertEqual(resp.status_code, 404)

    def test_unignore_no_auth_401(self):
        fc_uuid = _create_ignored_fieldchange(self.client, self.app)
        resp = self.client.delete(
            PREFIX + f'/field-changes/{fc_uuid}/ignore',
        )
        self.assertEqual(resp.status_code, 401)

    def test_unignore_read_scope_403(self):
        fc_uuid = _create_ignored_fieldchange(self.client, self.app)
        headers = make_scoped_headers(self.app, 'read')
        resp = self.client.delete(
            PREFIX + f'/field-changes/{fc_uuid}/ignore',
            headers=headers,
        )
        self.assertEqual(resp.status_code, 403)


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
        cls._start_rev = f'create-fc-o1-{uuid.uuid4().hex[:8]}'
        cls._end_rev = f'create-fc-o2-{uuid.uuid4().hex[:8]}'
        cls._field_name = 'execution_time'

        submit_run(cls.client, cls._machine_name, cls._start_rev,
                   [{'name': cls._test_name, 'execution_time': [1.0]}])
        data = submit_run(cls.client, cls._machine_name, cls._end_rev,
                          [{'name': cls._test_name, 'execution_time': [2.0]}])
        cls._run_uuid = data['run_uuid']

    def _valid_body(self, **overrides):
        """Return a valid POST body dict with optional overrides."""
        body = {
            'machine': self._machine_name,
            'test': self._test_name,
            'metric': self._field_name,
            'old_value': 10.0,
            'new_value': 20.0,
            'start_order': self._start_rev,
            'end_order': self._end_rev,
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
        self.assertEqual(data['start_order'], self._start_rev)
        self.assertEqual(data['end_order'], self._end_rev)

    def test_create_with_run_uuid(self):
        """POST with optional run_uuid returns 201 with run_uuid in response."""
        headers = _submit_headers(self.app)
        headers['Content-Type'] = 'application/json'
        body = self._valid_body(run_uuid=self._run_uuid)
        resp = self.client.post(
            PREFIX + '/field-changes',
            data=json.dumps(body),
            headers=headers,
        )
        self.assertEqual(resp.status_code, 201)
        data = resp.get_json()
        self.assertEqual(data['run_uuid'], self._run_uuid)

    def test_create_without_run_uuid_returns_null(self):
        """POST without run_uuid should return run_uuid as None."""
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
        self.assertIsNone(data['run_uuid'])

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

    def test_missing_machine_name_400(self):
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

    def test_missing_test_name_400(self):
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

    def test_missing_field_name_400(self):
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

    def test_missing_old_value_400(self):
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

    def test_missing_start_order_400(self):
        headers = _submit_headers(self.app)
        headers['Content-Type'] = 'application/json'
        body = self._valid_body()
        del body['start_order']
        resp = self.client.post(
            PREFIX + '/field-changes',
            data=json.dumps(body),
            headers=headers,
        )
        self.assertEqual(resp.status_code, 422)

    def test_missing_new_value_400(self):
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

    def test_missing_end_order_400(self):
        headers = _submit_headers(self.app)
        headers['Content-Type'] = 'application/json'
        body = self._valid_body()
        del body['end_order']
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

    def test_unknown_field_name_400(self):
        headers = _submit_headers(self.app)
        headers['Content-Type'] = 'application/json'
        body = self._valid_body(metric='no_such_field_xyz')
        resp = self.client.post(
            PREFIX + '/field-changes',
            data=json.dumps(body),
            headers=headers,
        )
        self.assertEqual(resp.status_code, 400)

    def test_nonexistent_start_order_404(self):
        headers = _submit_headers(self.app)
        headers['Content-Type'] = 'application/json'
        body = self._valid_body(start_order='nonexistent-rev-xyz')
        resp = self.client.post(
            PREFIX + '/field-changes',
            data=json.dumps(body),
            headers=headers,
        )
        self.assertEqual(resp.status_code, 404)

    def test_nonexistent_end_order_404(self):
        headers = _submit_headers(self.app)
        headers['Content-Type'] = 'application/json'
        body = self._valid_body(end_order='nonexistent-rev-xyz')
        resp = self.client.post(
            PREFIX + '/field-changes',
            data=json.dumps(body),
            headers=headers,
        )
        self.assertEqual(resp.status_code, 404)

    def test_nonexistent_run_uuid_404(self):
        headers = _submit_headers(self.app)
        headers['Content-Type'] = 'application/json'
        body = self._valid_body(run_uuid='nonexistent-run-uuid-xyz')
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

# Tests for the v5 run endpoints.
#
# RUN: rm -rf %t.instance %t.pg.log
# RUN: %{utils}/with_postgres.sh %t.pg.log \
# RUN:     %{utils}/with_temporary_instance.py --db-version 5.0 %t.instance \
# RUN:         -- python %s %t.instance
# END.

import datetime
import json
import sys
import os
import unittest
import uuid

sys.path.insert(0, os.path.dirname(__file__))
from v5_test_helpers import (
    create_app, create_client, admin_headers, make_scoped_headers,
    create_machine, create_commit, create_run,
    collect_all_pages, submit_run,
)


TS = 'nts'
PREFIX = f'/api/v5/{TS}'


def _make_submission_payload(machine_name=None, commit_str=None):
    """Build a valid v5-format JSON submission payload."""
    if machine_name is None:
        machine_name = f'submit-machine-{uuid.uuid4().hex[:8]}'
    if commit_str is None:
        commit_str = f'r{uuid.uuid4().hex[:8]}'

    return json.dumps({
        'format_version': '5',
        'machine': {
            'name': machine_name,
        },
        'commit': commit_str,
        'tests': [
            {
                'name': 'test.suite/benchmark1',
                'execution_time': 0.1234,
            },
        ],
    })


class TestRunListEmpty(unittest.TestCase):
    """Tests for GET /api/v5/{ts}/runs with no data."""
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.app = create_app(sys.argv[1])
        cls.client = create_client(cls.app)

    def test_list_returns_200(self):
        resp = self.client.get(PREFIX + '/runs')
        self.assertEqual(resp.status_code, 200)

    def test_list_has_items_key(self):
        resp = self.client.get(PREFIX + '/runs')
        data = resp.get_json()
        self.assertIn('items', data)
        self.assertIsInstance(data['items'], list)

    def test_list_has_pagination_envelope(self):
        resp = self.client.get(PREFIX + '/runs')
        data = resp.get_json()
        self.assertIn('cursor', data)
        self.assertIn('next', data['cursor'])
        self.assertIn('previous', data['cursor'])


class TestRunListWithData(unittest.TestCase):
    """Tests for GET /api/v5/{ts}/runs with existing data."""
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.app = create_app(sys.argv[1])
        cls.client = create_client(cls.app)

    def test_list_includes_created_runs(self):
        """Runs created via API appear in list."""
        name = f'list-data-{uuid.uuid4().hex[:8]}'
        rev = f'list-rev-{uuid.uuid4().hex[:6]}'
        data = submit_run(self.client, name, rev,
                          [{'name': 'p/test', 'execution_time': 0.0}])
        run_uuid = data['run_uuid']

        resp = self.client.get(PREFIX + f'/runs?machine={name}')
        rdata = resp.get_json()
        uuids = [item['uuid'] for item in rdata['items']]
        self.assertIn(run_uuid, uuids)

    def test_list_run_has_expected_fields(self):
        """Each run in the list has uuid, machine, commit, submitted_at, run_parameters."""
        name = f'list-fields-{uuid.uuid4().hex[:8]}'
        submit_run(self.client, name, f'fields-rev-{uuid.uuid4().hex[:6]}',
                   [{'name': 'p/test', 'execution_time': 0.0}])

        resp = self.client.get(PREFIX + f'/runs?machine={name}')
        data = resp.get_json()
        self.assertGreater(len(data['items']), 0)
        item = data['items'][0]
        self.assertIn('uuid', item)
        self.assertIn('machine', item)
        self.assertIn('commit', item)
        self.assertIn('submitted_at', item)
        self.assertIn('run_parameters', item)
        # Must NOT have internal IDs or v4 fields
        self.assertNotIn('id', item)
        self.assertNotIn('machine_id', item)
        self.assertNotIn('order', item)
        self.assertNotIn('start_time', item)
        self.assertNotIn('end_time', item)
        self.assertNotIn('parameters', item)

    def test_list_never_exposes_internal_ids(self):
        """Run list items never contain internal database IDs."""
        name = f'no-ids-{uuid.uuid4().hex[:8]}'
        submit_run(self.client, name, f'noid-rev-{uuid.uuid4().hex[:6]}',
                   [{'name': 'p/test', 'execution_time': 0.0}])

        resp = self.client.get(PREFIX + f'/runs?machine={name}')
        data = resp.get_json()
        for item in data['items']:
            self.assertNotIn('id', item)
            self.assertNotIn('machine_id', item)
            self.assertNotIn('commit_id', item)


class TestRunListPagination(unittest.TestCase):
    """Tests for run list pagination."""
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.app = create_app(sys.argv[1])
        cls.client = create_client(cls.app)

    def test_pagination(self):
        """Create multiple runs and paginate through them."""
        name = f'page-{uuid.uuid4().hex[:8]}'
        for i in range(3):
            submit_run(self.client, name,
                       f'page-rev-{uuid.uuid4().hex[:6]}-{i}',
                       [{'name': 'p/test', 'execution_time': 0.0}])

        # Get first page with limit=2
        resp = self.client.get(PREFIX + f'/runs?machine={name}&limit=2')
        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        self.assertEqual(len(data['items']), 2)
        self.assertIsNotNone(data['cursor']['next'])

        # Follow cursor
        cursor = data['cursor']['next']
        resp2 = self.client.get(
            PREFIX + f'/runs?machine={name}&limit=2&cursor={cursor}')
        self.assertEqual(resp2.status_code, 200)
        data2 = resp2.get_json()
        self.assertEqual(len(data2['items']), 1)
        self.assertIsNone(data2['cursor']['next'])


class TestRunSubmit(unittest.TestCase):
    """Tests for POST /api/v5/{ts}/runs (run submission)."""
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.app = create_app(sys.argv[1])
        cls.client = create_client(cls.app)

    def test_submit_valid_payload(self):
        """Submit a valid JSON payload and verify response."""
        payload = _make_submission_payload()
        resp = self.client.post(
            PREFIX + '/runs',
            data=payload,
            content_type='application/json',
            headers=admin_headers(),
        )
        self.assertEqual(resp.status_code, 201)
        data = resp.get_json()
        self.assertTrue(data.get('success'))
        self.assertIn('run_uuid', data)
        self.assertIsNotNone(data['run_uuid'])
        self.assertIn('result_url', data)

    def test_submit_returns_uuid(self):
        """Submitted run has a valid UUID."""
        payload = _make_submission_payload()
        resp = self.client.post(
            PREFIX + '/runs',
            data=payload,
            content_type='application/json',
            headers=admin_headers(),
        )
        data = resp.get_json()
        run_uuid = data.get('run_uuid')
        self.assertIsNotNone(run_uuid)
        # Verify UUID format (should be valid UUID4)
        try:
            uuid.UUID(run_uuid, version=4)
        except ValueError:
            self.fail(f"run_uuid is not a valid UUID: {run_uuid}")

    def test_submit_run_appears_in_list(self):
        """After submission, the run appears in the list endpoint."""
        machine_name = f'submit-list-{uuid.uuid4().hex[:8]}'
        payload = _make_submission_payload(machine_name=machine_name)
        resp = self.client.post(
            PREFIX + '/runs',
            data=payload,
            content_type='application/json',
            headers=admin_headers(),
        )
        data = resp.get_json()
        run_uuid = data['run_uuid']

        # Verify the run appears in the list
        list_resp = self.client.get(
            PREFIX + f'/runs?machine={machine_name}')
        list_data = list_resp.get_json()
        uuids = [item['uuid'] for item in list_data['items']]
        self.assertIn(run_uuid, uuids)

    def test_submit_run_detail_accessible(self):
        """After submission, the run detail is accessible by UUID."""
        payload = _make_submission_payload()
        resp = self.client.post(
            PREFIX + '/runs',
            data=payload,
            content_type='application/json',
            headers=admin_headers(),
        )
        data = resp.get_json()
        run_uuid = data['run_uuid']

        # Fetch run detail
        detail_resp = self.client.get(PREFIX + f'/runs/{run_uuid}')
        self.assertEqual(detail_resp.status_code, 200)
        detail = detail_resp.get_json()
        self.assertEqual(detail['uuid'], run_uuid)

    def test_submit_invalid_payload_422(self):
        """Submitting a JSON object without required fields returns 422."""
        resp = self.client.post(
            PREFIX + '/runs',
            data='{"not": "valid report"}',
            content_type='application/json',
            headers=admin_headers(),
        )
        self.assertEqual(resp.status_code, 422)

    def test_submit_empty_body_422(self):
        """Submitting an empty body returns 422."""
        resp = self.client.post(
            PREFIX + '/runs',
            data='',
            content_type='application/json',
            headers=admin_headers(),
        )
        self.assertEqual(resp.status_code, 422)

    def test_submit_no_auth_401(self):
        """Submitting without auth returns 401."""
        payload = _make_submission_payload()
        resp = self.client.post(
            PREFIX + '/runs',
            data=payload,
            content_type='application/json',
        )
        self.assertEqual(resp.status_code, 401)

    def test_submit_read_scope_403(self):
        """Submitting with read scope returns 403."""
        headers = make_scoped_headers(self.app, 'read')
        payload = _make_submission_payload()
        resp = self.client.post(
            PREFIX + '/runs',
            data=payload,
            content_type='application/json',
            headers=headers,
        )
        self.assertEqual(resp.status_code, 403)

    def test_submit_with_submit_scope_succeeds(self):
        """Submitting with submit scope succeeds."""
        headers = make_scoped_headers(self.app, 'submit')
        payload = _make_submission_payload()
        resp = self.client.post(
            PREFIX + '/runs',
            data=payload,
            content_type='application/json',
            headers=headers,
        )
        self.assertEqual(resp.status_code, 201)

    def test_submit_result_url_format(self):
        """Result URL should point to the v5 run detail."""
        payload = _make_submission_payload()
        resp = self.client.post(
            PREFIX + '/runs',
            data=payload,
            content_type='application/json',
            headers=admin_headers(),
        )
        data = resp.get_json()
        result_url = data.get('result_url')
        self.assertIsNotNone(result_url)
        self.assertIn(f'/api/v5/{TS}/runs/', result_url)


class TestRunSubmitFormatValidation(unittest.TestCase):
    """Tests that POST /api/v5/{ts}/runs mandates format_version '5'."""
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.app = create_app(sys.argv[1])
        cls.client = create_client(cls.app)

    def test_submit_non_json_body_400(self):
        """Non-JSON request body returns 400."""
        resp = self.client.post(
            PREFIX + '/runs',
            data='not json at all',
            content_type='application/json',
            headers=admin_headers(),
        )
        self.assertEqual(resp.status_code, 400)

    def test_submit_json_array_body_422(self):
        """A JSON array (not object) returns 422."""
        resp = self.client.post(
            PREFIX + '/runs',
            data='[1, 2, 3]',
            content_type='application/json',
            headers=admin_headers(),
        )
        self.assertEqual(resp.status_code, 422)

    def test_submit_missing_format_version_422(self):
        """A JSON object without format_version returns 422."""
        payload = json.dumps({
            'machine': {'name': 'dummy'},
            'commit': 'rev1',
            'tests': [],
        })
        resp = self.client.post(
            PREFIX + '/runs',
            data=payload,
            content_type='application/json',
            headers=admin_headers(),
        )
        self.assertEqual(resp.status_code, 422)

    def test_submit_wrong_format_version_400(self):
        """format_version '2' (v4 format) is rejected."""
        payload = json.dumps({
            'format_version': '2',
            'machine': {'name': 'dummy'},
            'commit': 'rev1',
            'tests': [],
        })
        resp = self.client.post(
            PREFIX + '/runs',
            data=payload,
            content_type='application/json',
            headers=admin_headers(),
        )
        self.assertEqual(resp.status_code, 400)
        msg = resp.get_json()['error']['message']
        self.assertIn('format_version', msg)

    def test_submit_integer_format_version_400(self):
        """format_version as integer 5 (not string '5') is rejected."""
        payload = json.dumps({
            'format_version': 5,
            'machine': {'name': 'dummy'},
            'commit': 'rev1',
            'tests': [],
        })
        resp = self.client.post(
            PREFIX + '/runs',
            data=payload,
            content_type='application/json',
            headers=admin_headers(),
        )
        self.assertEqual(resp.status_code, 400)
        msg = resp.get_json()['error']['message']
        self.assertIn('format_version', msg)

    def test_submit_v5_format_accepted(self):
        """A valid format_version '5' payload is accepted."""
        payload = _make_submission_payload()
        resp = self.client.post(
            PREFIX + '/runs',
            data=payload,
            content_type='application/json',
            headers=admin_headers(),
        )
        self.assertEqual(resp.status_code, 201)
        self.assertTrue(resp.get_json().get('success'))


class TestRunSubmitMachineConflict(unittest.TestCase):
    """Tests for the on_machine_conflict query parameter on POST /runs."""
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.app = create_app(sys.argv[1])
        cls.client = create_client(cls.app)

    def test_default_is_reject(self):
        """Omitting on_machine_conflict uses reject by default."""
        payload = _make_submission_payload()
        resp = self.client.post(
            PREFIX + '/runs',
            data=payload,
            content_type='application/json',
            headers=admin_headers(),
        )
        self.assertEqual(resp.status_code, 201)
        self.assertTrue(resp.get_json().get('success'))

    def test_reject_value_accepted(self):
        """on_machine_conflict=reject is accepted."""
        payload = _make_submission_payload()
        resp = self.client.post(
            PREFIX + '/runs?on_machine_conflict=reject',
            data=payload,
            content_type='application/json',
            headers=admin_headers(),
        )
        self.assertEqual(resp.status_code, 201)

    def test_update_value_accepted(self):
        """on_machine_conflict=update is accepted."""
        payload = _make_submission_payload()
        resp = self.client.post(
            PREFIX + '/runs?on_machine_conflict=update',
            data=payload,
            content_type='application/json',
            headers=admin_headers(),
        )
        self.assertEqual(resp.status_code, 201)

    def test_invalid_value_returns_422(self):
        """An invalid on_machine_conflict value returns 422."""
        payload = _make_submission_payload()
        resp = self.client.post(
            PREFIX + '/runs?on_machine_conflict=bogus',
            data=payload,
            content_type='application/json',
            headers=admin_headers(),
        )
        self.assertEqual(resp.status_code, 422)


def _make_submission_with_info(machine_name, machine_info, commit_str=None):
    """Build a v5-format JSON submission payload with machine info fields."""
    if commit_str is None:
        commit_str = f'r{uuid.uuid4().hex[:8]}'
    machine = {'name': machine_name}
    machine.update(machine_info)
    return json.dumps({
        'format_version': '5',
        'machine': machine,
        'commit': commit_str,
        'tests': [
            {
                'name': 'test.suite/benchmark1',
                'execution_time': 0.1234,
            },
        ],
    })


class TestMachineConflictUpdateBehavior(unittest.TestCase):
    """Behavioral tests for on_machine_conflict on POST /runs.

    These tests verify that the 'reject' strategy raises on
    machine field conflicts, and that the 'update' strategy does not
    create duplicates.
    """
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.app = create_app(sys.argv[1])
        cls.client = create_client(cls.app)

    def _submit_run(self, machine_name, machine_info, conflict='update'):
        """Helper: submit a run with the given machine info and conflict mode."""
        payload = _make_submission_with_info(machine_name, machine_info)
        url = PREFIX + '/runs'
        if conflict is not None:
            url += f'?on_machine_conflict={conflict}'
        return self.client.post(
            url,
            data=payload,
            content_type='application/json',
            headers=admin_headers(),
        )

    def _list_machines_by_name(self, machine_name):
        """Helper: list machines filtered by exact name prefix."""
        resp = self.client.get(
            PREFIX + f'/machines?search={machine_name}')
        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        # Filter to exact name matches (search could match longer names)
        return [m for m in data['items'] if m['name'] == machine_name]

    def _get_machine(self, machine_name):
        """Helper: GET a machine by name and return (status_code, json)."""
        resp = self.client.get(PREFIX + f'/machines/{machine_name}')
        return resp.status_code, resp.get_json()

    def test_update_does_not_create_new_machine(self):
        """on_machine_conflict=update reuses the existing machine, no duplicate."""
        name = f'mc-update-nodup-{uuid.uuid4().hex[:8]}'

        # First submission creates the machine.
        resp1 = self._submit_run(name, {'os': 'Linux'})
        self.assertEqual(resp1.status_code, 201)

        # Second submission with different info and update mode.
        resp2 = self._submit_run(name, {'os': 'Linux-v2'}, conflict='update')
        self.assertEqual(resp2.status_code, 201)

        # Verify only one machine with this name exists.
        machines = self._list_machines_by_name(name)
        self.assertEqual(len(machines), 1,
                         f"Expected 1 machine named '{name}', got {len(machines)}")

    def test_update_changes_machine_info(self):
        """on_machine_conflict=update actually modifies the machine's info."""
        name = f'mc-update-info-{uuid.uuid4().hex[:8]}'

        # First submission creates the machine with os=Linux.
        resp1 = self._submit_run(name, {'os': 'Linux'})
        self.assertEqual(resp1.status_code, 201)

        # Verify initial info.
        status, data = self._get_machine(name)
        self.assertEqual(status, 200)
        self.assertEqual(data['info']['os'], 'Linux')

        # Second submission with updated os.
        resp2 = self._submit_run(name, {'os': 'Linux-v2'}, conflict='update')
        self.assertEqual(resp2.status_code, 201)

        # Verify updated info.
        status, data = self._get_machine(name)
        self.assertEqual(status, 200)
        self.assertEqual(data['info']['os'], 'Linux-v2')

    def test_reject_default_raises_on_conflict(self):
        """Default reject mode returns 400 when machine info has changed."""
        name = f'mc-reject-err-{uuid.uuid4().hex[:8]}'

        # First submission creates the machine with os=Linux.
        resp1 = self._submit_run(name, {'os': 'Linux'}, conflict=None)
        self.assertEqual(resp1.status_code, 201)

        # Second submission with different os and default (reject) mode.
        resp2 = self._submit_run(name, {'os': 'Linux-v2'}, conflict=None)
        self.assertEqual(resp2.status_code, 400)

    def test_update_with_same_info_succeeds(self):
        """on_machine_conflict=update with identical info succeeds, no duplicate."""
        name = f'mc-update-same-{uuid.uuid4().hex[:8]}'

        # Both submissions use the same info.
        resp1 = self._submit_run(name, {'os': 'Linux'}, conflict='update')
        self.assertEqual(resp1.status_code, 201)

        resp2 = self._submit_run(name, {'os': 'Linux'}, conflict='update')
        self.assertEqual(resp2.status_code, 201)

        # Still only one machine.
        machines = self._list_machines_by_name(name)
        self.assertEqual(len(machines), 1,
                         f"Expected 1 machine named '{name}', got {len(machines)}")

    def test_update_preserves_existing_fields_when_new_is_null(self):
        """on_machine_conflict=update preserves fields not in the new submission."""
        name = f'mc-update-preserve-{uuid.uuid4().hex[:8]}'

        # First submission with both os and hardware.
        resp1 = self._submit_run(name, {'os': 'Linux', 'hardware': 'x86_64'})
        self.assertEqual(resp1.status_code, 201)

        # Verify both fields are set.
        status, data = self._get_machine(name)
        self.assertEqual(status, 200)
        self.assertEqual(data['info']['os'], 'Linux')
        self.assertEqual(data['info']['hardware'], 'x86_64')

        # Second submission with only os (no hardware).
        resp2 = self._submit_run(name, {'os': 'Linux-v2'}, conflict='update')
        self.assertEqual(resp2.status_code, 201)

        # Verify os is updated but hardware is preserved.
        status, data = self._get_machine(name)
        self.assertEqual(status, 200)
        self.assertEqual(data['info']['os'], 'Linux-v2')
        self.assertEqual(data['info']['hardware'], 'x86_64')


class TestRunDetail(unittest.TestCase):
    """Tests for GET /api/v5/{ts}/runs/{uuid}."""
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.app = create_app(sys.argv[1])
        cls.client = create_client(cls.app)

    def test_get_run_detail(self):
        """Get run detail by UUID."""
        name = f'detail-{uuid.uuid4().hex[:8]}'
        data = submit_run(self.client, name, f'detail-rev-{uuid.uuid4().hex[:6]}',
                          [{'name': 'p/test', 'execution_time': 0.0}])
        run_uuid = data['run_uuid']

        resp = self.client.get(PREFIX + f'/runs/{run_uuid}')
        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        self.assertEqual(data['uuid'], run_uuid)
        self.assertEqual(data['machine'], name)
        self.assertIn('commit', data)
        self.assertIn('submitted_at', data)
        self.assertIn('run_parameters', data)

    def test_get_run_detail_has_no_internal_ids(self):
        """Run detail does not expose internal IDs."""
        name = f'detail-noid-{uuid.uuid4().hex[:8]}'
        data = submit_run(self.client, name, f'noid-detail-rev-{uuid.uuid4().hex[:6]}',
                          [{'name': 'p/test', 'execution_time': 0.0}])
        run_uuid = data['run_uuid']

        resp = self.client.get(PREFIX + f'/runs/{run_uuid}')
        data = resp.get_json()
        self.assertNotIn('id', data)
        self.assertNotIn('machine_id', data)
        self.assertNotIn('commit_id', data)

    def test_get_nonexistent_uuid_404(self):
        """Getting a run with a nonexistent UUID returns 404."""
        fake_uuid = str(uuid.uuid4())
        resp = self.client.get(PREFIX + f'/runs/{fake_uuid}')
        self.assertEqual(resp.status_code, 404)

    def test_get_invalid_uuid_format_404(self):
        """Getting a run with an invalid UUID string returns 404."""
        resp = self.client.get(PREFIX + '/runs/not-a-valid-uuid')
        self.assertEqual(resp.status_code, 404)


class TestRunDetailETag(unittest.TestCase):
    """ETag tests for GET /api/v5/{ts}/runs/{uuid}."""
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.app = create_app(sys.argv[1])
        cls.client = create_client(cls.app)

    def test_etag_present_on_detail(self):
        """Run detail response should include an ETag header."""
        name = f'etag-present-{uuid.uuid4().hex[:8]}'
        data = submit_run(self.client, name, f'etag-rev-{uuid.uuid4().hex[:6]}',
                          [{'name': 'p/test', 'execution_time': 0.0}])
        run_uuid = data['run_uuid']

        resp = self.client.get(PREFIX + f'/runs/{run_uuid}')
        self.assertEqual(resp.status_code, 200)
        etag = resp.headers.get('ETag')
        self.assertIsNotNone(etag)
        self.assertTrue(etag.startswith('W/"'))

    def test_etag_304_on_match(self):
        """Sending If-None-Match with the same ETag returns 304."""
        name = f'etag-304-{uuid.uuid4().hex[:8]}'
        data = submit_run(self.client, name, f'etag-304-rev-{uuid.uuid4().hex[:6]}',
                          [{'name': 'p/test', 'execution_time': 0.0}])
        run_uuid = data['run_uuid']

        resp = self.client.get(PREFIX + f'/runs/{run_uuid}')
        etag = resp.headers.get('ETag')

        resp2 = self.client.get(
            PREFIX + f'/runs/{run_uuid}',
            headers={'If-None-Match': etag},
        )
        self.assertEqual(resp2.status_code, 304)

    def test_etag_200_on_mismatch(self):
        """Sending If-None-Match with a different ETag returns 200."""
        name = f'etag-200-{uuid.uuid4().hex[:8]}'
        data = submit_run(self.client, name, f'etag-200-rev-{uuid.uuid4().hex[:6]}',
                          [{'name': 'p/test', 'execution_time': 0.0}])
        run_uuid = data['run_uuid']

        resp = self.client.get(
            PREFIX + f'/runs/{run_uuid}',
            headers={'If-None-Match': 'W/"stale-etag-value"'},
        )
        self.assertEqual(resp.status_code, 200)
        self.assertIsNotNone(resp.get_json())


class TestRunDelete(unittest.TestCase):
    """Tests for DELETE /api/v5/{ts}/runs/{uuid}."""
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.app = create_app(sys.argv[1])
        cls.client = create_client(cls.app)

    def test_delete_run(self):
        """Delete a run and verify 204, then verify it's gone."""
        name = f'delete-{uuid.uuid4().hex[:8]}'
        data = submit_run(self.client, name, f'del-rev-{uuid.uuid4().hex[:6]}',
                          [{'name': 'p/test', 'execution_time': 0.0}])
        run_uuid = data['run_uuid']

        resp = self.client.delete(
            PREFIX + f'/runs/{run_uuid}',
            headers=admin_headers(),
        )
        self.assertEqual(resp.status_code, 204)

        # Verify it's gone
        resp = self.client.get(PREFIX + f'/runs/{run_uuid}')
        self.assertEqual(resp.status_code, 404)

    def test_delete_nonexistent_404(self):
        """Deleting a nonexistent run returns 404."""
        fake_uuid = str(uuid.uuid4())
        resp = self.client.delete(
            PREFIX + f'/runs/{fake_uuid}',
            headers=admin_headers(),
        )
        self.assertEqual(resp.status_code, 404)

    def test_delete_no_auth_401(self):
        """Deleting without auth returns 401."""
        name = f'del-noauth-{uuid.uuid4().hex[:8]}'
        data = submit_run(self.client, name, f'del-noauth-{uuid.uuid4().hex[:6]}',
                          [{'name': 'p/test', 'execution_time': 0.0}])
        run_uuid = data['run_uuid']

        resp = self.client.delete(PREFIX + f'/runs/{run_uuid}')
        self.assertEqual(resp.status_code, 401)

    def test_delete_triage_scope_403(self):
        """Deleting with triage scope (one below manage) returns 403."""
        name = f'del-scope-{uuid.uuid4().hex[:8]}'
        data = submit_run(self.client, name, f'del-scope-{uuid.uuid4().hex[:6]}',
                          [{'name': 'p/test', 'execution_time': 0.0}])
        run_uuid = data['run_uuid']

        headers = make_scoped_headers(self.app, 'triage')
        resp = self.client.delete(
            PREFIX + f'/runs/{run_uuid}',
            headers=headers,
        )
        self.assertEqual(resp.status_code, 403)

    def test_delete_manage_scope_204(self):
        """Deleting with manage scope (the required scope) succeeds."""
        name = f'del-mng-{uuid.uuid4().hex[:8]}'
        data = submit_run(self.client, name, f'del-mng-{uuid.uuid4().hex[:6]}',
                          [{'name': 'p/test', 'execution_time': 0.0}])
        run_uuid = data['run_uuid']

        headers = make_scoped_headers(self.app, 'manage')
        resp = self.client.delete(
            PREFIX + f'/runs/{run_uuid}',
            headers=headers,
        )
        self.assertEqual(resp.status_code, 204)


class TestRunFilterByMachine(unittest.TestCase):
    """Test filtering runs by machine name."""
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.app = create_app(sys.argv[1])
        cls.client = create_client(cls.app)

    def test_filter_by_machine_name(self):
        """Filter runs by machine name."""
        name = f'filter-machine-{uuid.uuid4().hex[:8]}'
        submit_run(self.client, name, f'fm-rev-{uuid.uuid4().hex[:6]}',
                   [{'name': 'p/test', 'execution_time': 0.0}])

        resp = self.client.get(PREFIX + f'/runs?machine={name}')
        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        self.assertGreater(len(data['items']), 0)
        for item in data['items']:
            self.assertEqual(item['machine'], name)

    def test_filter_by_nonexistent_machine(self):
        """Filtering by a machine that doesn't exist returns empty results."""
        resp = self.client.get(
            PREFIX + '/runs?machine=nonexistent-machine-xyz-abc')
        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        self.assertEqual(len(data['items']), 0)


class TestRunFilterByCommit(unittest.TestCase):
    """Test filtering runs by commit string."""
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.app = create_app(sys.argv[1])
        cls.client = create_client(cls.app)

    def test_filter_by_commit(self):
        """Filter runs by commit string."""
        name = f'commit-filter-{uuid.uuid4().hex[:8]}'
        rev1 = f'cfilt-rev1-{uuid.uuid4().hex[:6]}'
        rev2 = f'cfilt-rev2-{uuid.uuid4().hex[:6]}'
        submit_run(self.client, name, rev1,
                   [{'name': 'p/test', 'execution_time': 0.0}])
        submit_run(self.client, name, rev2,
                   [{'name': 'p/test', 'execution_time': 0.0}])

        resp = self.client.get(
            PREFIX + f'/runs?machine={name}&commit={rev1}')
        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        self.assertEqual(len(data['items']), 1)
        self.assertEqual(data['items'][0]['commit'], rev1)

    def test_filter_by_nonexistent_commit(self):
        """Filtering by a nonexistent commit returns empty results."""
        resp = self.client.get(
            PREFIX + '/runs?commit=nonexistent-commit-xyz-abc')
        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        self.assertEqual(len(data['items']), 0)


class TestRunFilterByDatetime(unittest.TestCase):
    """Test filtering runs by after/before datetime (submitted_at).

    Since submitted_at is set server-side, we use direct DB helpers
    to create runs with specific timestamps.
    """
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.app = create_app(sys.argv[1])
        cls.client = create_client(cls.app)

    def test_filter_after(self):
        """Filter runs submitted after a given datetime."""
        name = f'after-{uuid.uuid4().hex[:8]}'
        db = self.app.instance.get_database("default")
        session = db.make_session()
        ts = db.testsuite[TS]
        machine = create_machine(session, ts, name=name)
        c1 = create_commit(
            session, ts,
            commit=f'after-rev1-{uuid.uuid4().hex[:6]}')
        create_run(session, ts, machine, c1,
                   submitted_at=datetime.datetime(2024, 1, 1, 12, 0, 0, tzinfo=datetime.timezone.utc))
        c2 = create_commit(
            session, ts,
            commit=f'after-rev2-{uuid.uuid4().hex[:6]}')
        create_run(session, ts, machine, c2,
                   submitted_at=datetime.datetime(2024, 6, 1, 12, 0, 0, tzinfo=datetime.timezone.utc))
        session.commit()
        session.close()

        resp = self.client.get(
            PREFIX + f'/runs?machine={name}&after=2024-03-01T00:00:00')
        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        self.assertEqual(len(data['items']), 1)

    def test_filter_before(self):
        """Filter runs submitted before a given datetime."""
        name = f'before-{uuid.uuid4().hex[:8]}'
        db = self.app.instance.get_database("default")
        session = db.make_session()
        ts = db.testsuite[TS]
        machine = create_machine(session, ts, name=name)
        c1 = create_commit(
            session, ts,
            commit=f'before-rev1-{uuid.uuid4().hex[:6]}')
        create_run(session, ts, machine, c1,
                   submitted_at=datetime.datetime(2024, 1, 1, 12, 0, 0, tzinfo=datetime.timezone.utc))
        c2 = create_commit(
            session, ts,
            commit=f'before-rev2-{uuid.uuid4().hex[:6]}')
        create_run(session, ts, machine, c2,
                   submitted_at=datetime.datetime(2024, 6, 1, 12, 0, 0, tzinfo=datetime.timezone.utc))
        session.commit()
        session.close()

        resp = self.client.get(
            PREFIX + f'/runs?machine={name}&before=2024-03-01T00:00:00')
        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        self.assertEqual(len(data['items']), 1)

    def test_filter_after_and_before(self):
        """Filter runs within a datetime range."""
        name = f'range-{uuid.uuid4().hex[:8]}'
        db = self.app.instance.get_database("default")
        session = db.make_session()
        ts = db.testsuite[TS]
        machine = create_machine(session, ts, name=name)
        for month in (1, 4, 7, 10):
            c = create_commit(
                session, ts,
                commit=f'range-rev-{month}-{uuid.uuid4().hex[:6]}')
            create_run(session, ts, machine, c,
                       submitted_at=datetime.datetime(
                           2024, month, 15, 12, 0, 0,
                           tzinfo=datetime.timezone.utc))
        session.commit()
        session.close()

        resp = self.client.get(
            PREFIX + f'/runs?machine={name}&after=2024-03-01T00:00:00&before=2024-08-01T00:00:00')
        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        # Should match runs from month 4 and 7
        self.assertEqual(len(data['items']), 2)

    def test_filter_invalid_after_datetime_400(self):
        """Invalid after datetime returns 400."""
        resp = self.client.get(PREFIX + '/runs?after=not-a-date')
        self.assertEqual(resp.status_code, 400)

    def test_filter_invalid_before_datetime_400(self):
        """Invalid before datetime returns 400."""
        resp = self.client.get(PREFIX + '/runs?before=not-a-date')
        self.assertEqual(resp.status_code, 400)


class TestRunSort(unittest.TestCase):
    """Test sorting runs."""
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.app = create_app(sys.argv[1])
        cls.client = create_client(cls.app)

    def test_sort_descending_submitted_at(self):
        """Sort runs by -submitted_at returns newest first."""
        name = f'sort-run-{uuid.uuid4().hex[:8]}'
        db = self.app.instance.get_database("default")
        session = db.make_session()
        ts = db.testsuite[TS]
        machine = create_machine(session, ts, name=name)
        for month in (1, 4, 7):
            c = create_commit(
                session, ts,
                commit=f'sort-rev-{month}-{uuid.uuid4().hex[:6]}')
            create_run(session, ts, machine, c,
                       submitted_at=datetime.datetime(
                           2024, month, 1, 12, 0, 0,
                           tzinfo=datetime.timezone.utc))
        session.commit()
        session.close()

        # Default order (ascending by ID)
        resp_default = self.client.get(
            PREFIX + f'/runs?machine={name}')
        self.assertEqual(resp_default.status_code, 200)
        default_times = [
            item['submitted_at']
            for item in resp_default.get_json()['items']]

        # Descending by submitted_at
        resp_sorted = self.client.get(
            PREFIX + f'/runs?machine={name}&sort=-submitted_at')
        self.assertEqual(resp_sorted.status_code, 200)
        sorted_times = [
            item['submitted_at']
            for item in resp_sorted.get_json()['items']]

        self.assertEqual(len(sorted_times), 3)
        self.assertEqual(sorted_times, list(reversed(default_times)))


class TestRunPagination(unittest.TestCase):
    """Exhaustive cursor pagination tests for GET /api/v5/{ts}/runs."""
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.app = create_app(sys.argv[1])
        cls.client = create_client(cls.app)
        cls._machine_name = f'pag-machine-{uuid.uuid4().hex[:8]}'
        for i in range(5):
            submit_run(cls.client, cls._machine_name,
                       f'pag-run-rev-{uuid.uuid4().hex[:6]}-{i}',
                       [{'name': 'p/test', 'execution_time': 0.0}])

    def _collect_all_pages(self):
        url = PREFIX + f'/runs?machine={self._machine_name}&limit=2'
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


class TestRunListInvalidCursor(unittest.TestCase):
    """Tests that an invalid cursor returns 400 for the run list endpoint."""
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.app = create_app(sys.argv[1])
        cls.client = create_client(cls.app)

    def test_invalid_cursor_returns_400(self):
        """An invalid cursor string should return 400."""
        resp = self.client.get(
            PREFIX + '/runs?cursor=not-a-valid-cursor!!!')
        self.assertEqual(resp.status_code, 400)


class TestRunUnknownParams(unittest.TestCase):
    """Test that unknown query parameters are rejected with 400."""
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.app = create_app(sys.argv[1])
        cls.client = create_client(cls.app)

    def test_runs_list_unknown_param_returns_400(self):
        resp = self.client.get(PREFIX + '/runs?bogus=1')
        self.assertEqual(resp.status_code, 400)
        data = resp.get_json()
        self.assertIn('bogus', data['error']['message'])

    def test_run_detail_unknown_param_returns_400(self):
        name = f'unk-det-{uuid.uuid4().hex[:8]}'
        data = submit_run(self.client, name, f'unk-det-rev-{uuid.uuid4().hex[:6]}',
                          [{'name': 'p/test', 'execution_time': 0.0}])
        run_uuid = data['run_uuid']
        resp = self.client.get(PREFIX + f'/runs/{run_uuid}?bogus=1')
        self.assertEqual(resp.status_code, 400)

    def test_run_submit_ignore_regressions_rejected(self):
        """ignore_regressions is no longer accepted by v5 POST /runs."""
        headers = admin_headers()
        headers['Content-Type'] = 'application/json'
        body = json.dumps({
            'format_version': '5',
            'machine': {'name': 'dummy'},
            'commit': 'rev-ignore-test',
            'tests': [],
        })
        resp = self.client.post(
            PREFIX + '/runs?ignore_regressions=true',
            data=body,
            headers=headers,
        )
        self.assertIn(resp.status_code, [400, 422])


if __name__ == '__main__':
    unittest.main(argv=[sys.argv[0]], exit=True)

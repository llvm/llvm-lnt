# Tests for the v5 regression endpoints.
#
# RUN: rm -rf %t.instance %t.pg.log
# RUN: %{utils}/with_postgres.sh %t.pg.log \
# RUN:     %{utils}/with_temporary_instance.py %t.instance \
# RUN:         -- python %s %t.instance
# END.

import sys
import os
import unittest
import uuid

sys.path.insert(0, os.path.dirname(__file__))
from v5_test_helpers import (
    create_app, create_client, make_scoped_headers,
    collect_all_pages, submit_run, submit_fieldchange, submit_regression,
)


TS = 'nts'
PREFIX = f'/api/v5/{TS}'


def _triage_headers(app):
    return make_scoped_headers(app, 'triage')


def _setup_fieldchange(client, app):
    """Create a field change via the API and return its UUID."""
    tag = uuid.uuid4().hex[:8]
    machine = f'reg-m-{tag}'
    rev1 = f'reg-o1-{tag}'
    rev2 = f'reg-o2-{tag}'
    test = f'reg/test/{tag}'
    submit_run(client, machine, rev1,
               [{'name': test, 'execution_time': [1.0]}])
    submit_run(client, machine, rev2,
               [{'name': test, 'execution_time': [2.0]}])
    fc = submit_fieldchange(client, app, machine, test,
                            'execution_time', rev1, rev2)
    return fc['uuid']


def _setup_regression_with_indicators(client, app, num_indicators=2):
    """Create a regression with field changes via the API.

    Returns (regression_uuid, [fc_uuid, ...]).
    """
    tag = uuid.uuid4().hex[:8]
    machine = f'reg-m-{tag}'
    rev1 = f'reg-o1-{tag}'
    rev2 = f'reg-o2-{tag}'
    tests = [
        {'name': f'reg/test/{tag}/{i}', 'execution_time': [1.0 + i]}
        for i in range(num_indicators)
    ]
    submit_run(client, machine, rev1, tests)
    submit_run(client, machine, rev2, [
        {'name': f'reg/test/{tag}/{i}', 'execution_time': [2.0 + i]}
        for i in range(num_indicators)
    ])
    fc_uuids = []
    for i in range(num_indicators):
        fc = submit_fieldchange(client, app, machine,
                                f'reg/test/{tag}/{i}',
                                'execution_time', rev1, rev2)
        fc_uuids.append(fc['uuid'])
    reg = submit_regression(client, app, fc_uuids)
    return reg['uuid'], fc_uuids


# ==========================================================================
# Regression List Tests
# ==========================================================================

class TestRegressionList(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.app = create_app(sys.argv[1])
        cls.client = create_client(cls.app)

    def test_list_returns_200_with_envelope(self):
        resp = self.client.get(PREFIX + '/regressions')
        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        self.assertIn('items', data)
        self.assertIsInstance(data['items'], list)
        self.assertIn('cursor', data)
        self.assertIn('next', data['cursor'])
        self.assertIn('previous', data['cursor'])

    def test_list_item_has_expected_fields(self):
        reg_uuid, _ = _setup_regression_with_indicators(self.client, self.app, 1)
        resp = self.client.get(PREFIX + '/regressions')
        data = resp.get_json()
        item = None
        for r in data['items']:
            if r['uuid'] == reg_uuid:
                item = r
                break
        self.assertIsNotNone(item)
        self.assertIn('uuid', item)
        self.assertIn('title', item)
        self.assertIn('bug', item)
        self.assertIn('state', item)
        # List items should NOT have indicators embedded
        self.assertNotIn('indicators', item)

    def test_list_filter_by_state(self):
        reg_uuid, _ = _setup_regression_with_indicators(self.client, self.app, 1)
        resp = self.client.get(PREFIX + '/regressions?state=active')
        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        for r in data['items']:
            self.assertEqual(r['state'], 'active')

    def test_list_filter_by_state_multiple(self):
        tag = uuid.uuid4().hex[:8]
        machine = f'state-m-{tag}'
        rev1 = f'state-o1-{tag}'
        rev2 = f'state-o2-{tag}'
        test1 = f'state-test/{tag}/1'
        test2 = f'state-test/{tag}/2'

        submit_run(self.client, machine, rev1, [
            {'name': test1, 'execution_time': [1.0]},
            {'name': test2, 'execution_time': [1.0]},
        ])
        submit_run(self.client, machine, rev2, [
            {'name': test1, 'execution_time': [2.0]},
            {'name': test2, 'execution_time': [2.0]},
        ])

        fc1 = submit_fieldchange(self.client, self.app, machine,
                                 test1, 'execution_time', rev1, rev2)
        fc2 = submit_fieldchange(self.client, self.app, machine,
                                 test2, 'execution_time', rev1, rev2)
        submit_regression(self.client, self.app, [fc1['uuid']],
                          state='active')
        submit_regression(self.client, self.app, [fc2['uuid']],
                          state='detected')

        resp = self.client.get(
            PREFIX + '/regressions?state=active,detected')
        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        states = {r['state'] for r in data['items']}
        self.assertTrue(states.issubset({'active', 'detected'}))

    def test_list_filter_invalid_state_400(self):
        resp = self.client.get(PREFIX + '/regressions?state=invalid_state')
        self.assertEqual(resp.status_code, 400)

    def test_invalid_cursor_returns_400(self):
        """An invalid cursor string should return 400."""
        resp = self.client.get(
            PREFIX + '/regressions?cursor=not-a-valid-cursor!!!')
        self.assertEqual(resp.status_code, 400)

    def test_list_pagination(self):
        # Create 3 regressions
        for _ in range(3):
            _setup_regression_with_indicators(self.client, self.app, 1)
        resp = self.client.get(PREFIX + '/regressions?limit=2')
        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        self.assertLessEqual(len(data['items']), 2)
        if data['cursor']['next']:
            cursor = data['cursor']['next']
            resp2 = self.client.get(
                PREFIX + f'/regressions?limit=2&cursor={cursor}')
            self.assertEqual(resp2.status_code, 200)


# ==========================================================================
# Regression List Filter Tests
# ==========================================================================

class TestRegressionListFilters(unittest.TestCase):
    """Tests for machine, test, and metric query filters on the list endpoint."""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.app = create_app(sys.argv[1])
        cls.client = create_client(cls.app)

    def _collect_filtered(self, query_string):
        """Collect all regression UUIDs across pages for a filtered query."""
        url = PREFIX + '/regressions?' + query_string + '&limit=2'
        items = collect_all_pages(self, self.client, url, page_limit=100)
        return [r['uuid'] for r in items]

    def test_list_filter_by_machine(self):
        """Filter by machine name returns only regressions on that machine."""
        tag = uuid.uuid4().hex[:8]
        machine_name = f'filter-m-{tag}'
        rev1 = f'filter-r1-{tag}'
        rev2 = f'filter-r2-{tag}'
        test_name = f'filter/test/{tag}'

        submit_run(self.client, machine_name, rev1,
                   [{'name': test_name, 'execution_time': [1.0]}])
        submit_run(self.client, machine_name, rev2,
                   [{'name': test_name, 'execution_time': [2.0]}])

        fc = submit_fieldchange(self.client, self.app, machine_name,
                                test_name, 'execution_time', rev1, rev2)
        reg = submit_regression(self.client, self.app, [fc['uuid']])

        uuids = self._collect_filtered(f'machine={machine_name}')
        self.assertIn(reg['uuid'], uuids)

    def test_list_filter_by_test(self):
        """Filter by test name returns only regressions on that test."""
        tag = uuid.uuid4().hex[:8]
        machine_name = f'filter-tm-{tag}'
        rev1 = f'filter-tr1-{tag}'
        rev2 = f'filter-tr2-{tag}'
        test_name = f'filter/testname/{tag}'

        submit_run(self.client, machine_name, rev1,
                   [{'name': test_name, 'execution_time': [1.0]}])
        submit_run(self.client, machine_name, rev2,
                   [{'name': test_name, 'execution_time': [2.0]}])

        fc = submit_fieldchange(self.client, self.app, machine_name,
                                test_name, 'execution_time', rev1, rev2)
        reg = submit_regression(self.client, self.app, [fc['uuid']])

        uuids = self._collect_filtered(f'test={test_name}')
        self.assertIn(reg['uuid'], uuids)

    def test_list_filter_by_metric(self):
        """Filter by metric returns only regressions with that metric."""
        tag = uuid.uuid4().hex[:8]
        machine_name = f'filter-mm-{tag}'
        rev1 = f'filter-mr1-{tag}'
        rev2 = f'filter-mr2-{tag}'
        test_ct = f'filter/compile/{tag}'
        test_et = f'filter/exec/{tag}'

        # Submit runs with both metrics
        submit_run(self.client, machine_name, rev1, [
            {'name': test_ct, 'compile_time': [5.0]},
            {'name': test_et, 'execution_time': [1.0]},
        ])
        submit_run(self.client, machine_name, rev2, [
            {'name': test_ct, 'compile_time': [10.0]},
            {'name': test_et, 'execution_time': [2.0]},
        ])

        # Create field change + regression for compile_time
        fc_ct = submit_fieldchange(self.client, self.app, machine_name,
                                   test_ct, 'compile_time', rev1, rev2)
        reg_ct = submit_regression(self.client, self.app, [fc_ct['uuid']])

        # Create field change + regression for execution_time
        fc_et = submit_fieldchange(self.client, self.app, machine_name,
                                   test_et, 'execution_time', rev1, rev2)
        reg_et = submit_regression(self.client, self.app, [fc_et['uuid']])

        # Filter by execution_time -- should include reg_et, exclude reg_ct
        uuids = self._collect_filtered('metric=execution_time')
        self.assertIn(reg_et['uuid'], uuids)
        self.assertNotIn(reg_ct['uuid'], uuids)

    def test_list_filter_by_metric_unknown_returns_400(self):
        """Filtering by a nonexistent metric returns 400."""
        resp = self.client.get(
            PREFIX + '/regressions?metric=nonexistent_metric')
        self.assertEqual(resp.status_code, 400)

    def test_list_filter_combined(self):
        """Combined machine + test + metric filter narrows results."""
        tag = uuid.uuid4().hex[:8]
        machine_name = f'filter-cm-{tag}'
        rev1 = f'filter-cr1-{tag}'
        rev2 = f'filter-cr2-{tag}'
        test_name = f'filter/combined/{tag}'

        submit_run(self.client, machine_name, rev1,
                   [{'name': test_name, 'execution_time': [1.0]}])
        submit_run(self.client, machine_name, rev2,
                   [{'name': test_name, 'execution_time': [2.0]}])

        fc = submit_fieldchange(self.client, self.app, machine_name,
                                test_name, 'execution_time', rev1, rev2)
        reg = submit_regression(self.client, self.app, [fc['uuid']])

        uuids = self._collect_filtered(
            f'machine={machine_name}&test={test_name}'
            f'&metric=execution_time')
        self.assertIn(reg['uuid'], uuids)


# ==========================================================================
# Regression Create Tests
# ==========================================================================

class TestRegressionCreate(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.app = create_app(sys.argv[1])
        cls.client = create_client(cls.app)

    def test_create_regression(self):
        fc_uuid = _setup_fieldchange(self.client, self.app)
        headers = _triage_headers(self.app)
        resp = self.client.post(
            PREFIX + '/regressions',
            json={'field_change_uuids': [fc_uuid]},
            headers=headers,
        )
        self.assertEqual(resp.status_code, 201)
        data = resp.get_json()
        self.assertIn('uuid', data)
        self.assertIn('indicators', data)
        self.assertEqual(len(data['indicators']), 1)
        self.assertEqual(data['indicators'][0]['field_change_uuid'], fc_uuid)

    def test_create_with_custom_title(self):
        fc_uuid = _setup_fieldchange(self.client, self.app)
        headers = _triage_headers(self.app)
        resp = self.client.post(
            PREFIX + '/regressions',
            json={
                'field_change_uuids': [fc_uuid],
                'title': 'Custom Title',
            },
            headers=headers,
        )
        self.assertEqual(resp.status_code, 201)
        data = resp.get_json()
        self.assertEqual(data['title'], 'Custom Title')

    def test_create_with_state(self):
        fc_uuid = _setup_fieldchange(self.client, self.app)
        headers = _triage_headers(self.app)
        resp = self.client.post(
            PREFIX + '/regressions',
            json={
                'field_change_uuids': [fc_uuid],
                'state': 'active',
            },
            headers=headers,
        )
        self.assertEqual(resp.status_code, 201)
        data = resp.get_json()
        self.assertEqual(data['state'], 'active')

    def test_create_default_state_detected(self):
        fc_uuid = _setup_fieldchange(self.client, self.app)
        headers = _triage_headers(self.app)
        resp = self.client.post(
            PREFIX + '/regressions',
            json={'field_change_uuids': [fc_uuid]},
            headers=headers,
        )
        self.assertEqual(resp.status_code, 201)
        data = resp.get_json()
        self.assertEqual(data['state'], 'detected')

    def test_create_missing_field_changes_422(self):
        headers = _triage_headers(self.app)
        resp = self.client.post(
            PREFIX + '/regressions',
            json={},
            headers=headers,
        )
        self.assertEqual(resp.status_code, 422)

    def test_create_empty_field_changes_422(self):
        headers = _triage_headers(self.app)
        resp = self.client.post(
            PREFIX + '/regressions',
            json={'field_change_uuids': []},
            headers=headers,
        )
        self.assertEqual(resp.status_code, 422)

    def test_create_invalid_field_change_uuid_404(self):
        headers = _triage_headers(self.app)
        resp = self.client.post(
            PREFIX + '/regressions',
            json={'field_change_uuids': ['nonexistent-uuid']},
            headers=headers,
        )
        self.assertEqual(resp.status_code, 404)

    def test_create_invalid_state_422(self):
        fc_uuid = _setup_fieldchange(self.client, self.app)
        headers = _triage_headers(self.app)
        resp = self.client.post(
            PREFIX + '/regressions',
            json={
                'field_change_uuids': [fc_uuid],
                'state': 'bogus_state',
            },
            headers=headers,
        )
        self.assertEqual(resp.status_code, 422)

    def test_create_no_auth_401(self):
        resp = self.client.post(
            PREFIX + '/regressions',
            json={'field_change_uuids': ['x']},
        )
        self.assertEqual(resp.status_code, 401)

    def test_create_read_scope_403(self):
        headers = make_scoped_headers(self.app, 'read')
        resp = self.client.post(
            PREFIX + '/regressions',
            json={'field_change_uuids': ['x']},
            headers=headers,
        )
        self.assertEqual(resp.status_code, 403)


# ==========================================================================
# Regression Detail Tests
# ==========================================================================

class TestRegressionDetail(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.app = create_app(sys.argv[1])
        cls.client = create_client(cls.app)

    def test_get_detail(self):
        reg_uuid, fc_uuids = _setup_regression_with_indicators(self.client, self.app, 1)
        resp = self.client.get(PREFIX + f'/regressions/{reg_uuid}')
        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        self.assertEqual(data['uuid'], reg_uuid)
        self.assertIn('title', data)
        self.assertIn('bug', data)
        self.assertIn('state', data)
        self.assertIn('indicators', data)
        self.assertEqual(len(data['indicators']), 1)
        ind = data['indicators'][0]
        self.assertIn('field_change_uuid', ind)
        self.assertIn('test', ind)
        self.assertIn('machine', ind)
        self.assertIn('metric', ind)
        self.assertIn('old_value', ind)
        self.assertIn('new_value', ind)
        self.assertIn('start_order', ind)
        self.assertIn('end_order', ind)
        self.assertIn('run_uuid', ind)

    def test_detail_nonexistent_404(self):
        resp = self.client.get(
            PREFIX + '/regressions/nonexistent-uuid-12345')
        self.assertEqual(resp.status_code, 404)

    def test_detail_state_is_string(self):
        reg_uuid, _ = _setup_regression_with_indicators(self.client, self.app, 1)
        resp = self.client.get(PREFIX + f'/regressions/{reg_uuid}')
        data = resp.get_json()
        self.assertIsInstance(data['state'], str)
        self.assertEqual(data['state'], 'active')  # state=10 -> 'active'


class TestRegressionDetailETag(unittest.TestCase):
    """ETag tests for GET /api/v5/{ts}/regressions/{uuid}."""
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.app = create_app(sys.argv[1])
        cls.client = create_client(cls.app)

    def test_etag_present_on_detail(self):
        """Regression detail response should include an ETag header."""
        reg_uuid, _ = _setup_regression_with_indicators(self.client, self.app, 1)
        resp = self.client.get(PREFIX + f'/regressions/{reg_uuid}')
        self.assertEqual(resp.status_code, 200)
        etag = resp.headers.get('ETag')
        self.assertIsNotNone(etag)
        self.assertTrue(etag.startswith('W/"'))

    def test_etag_304_on_match(self):
        """Sending If-None-Match with the same ETag returns 304."""
        reg_uuid, _ = _setup_regression_with_indicators(self.client, self.app, 1)
        resp = self.client.get(PREFIX + f'/regressions/{reg_uuid}')
        etag = resp.headers.get('ETag')

        resp2 = self.client.get(
            PREFIX + f'/regressions/{reg_uuid}',
            headers={'If-None-Match': etag},
        )
        self.assertEqual(resp2.status_code, 304)

    def test_etag_200_on_mismatch(self):
        """Sending If-None-Match with a different ETag returns 200."""
        reg_uuid, _ = _setup_regression_with_indicators(self.client, self.app, 1)
        resp = self.client.get(
            PREFIX + f'/regressions/{reg_uuid}',
            headers={'If-None-Match': 'W/"stale-etag-value"'},
        )
        self.assertEqual(resp.status_code, 200)
        self.assertIsNotNone(resp.get_json())


# ==========================================================================
# Regression Update Tests
# ==========================================================================

class TestRegressionUpdate(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.app = create_app(sys.argv[1])
        cls.client = create_client(cls.app)

    def test_update_title(self):
        reg_uuid, _ = _setup_regression_with_indicators(self.client, self.app, 1)
        headers = _triage_headers(self.app)
        resp = self.client.patch(
            PREFIX + f'/regressions/{reg_uuid}',
            json={'title': 'Updated Title'},
            headers=headers,
        )
        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        self.assertEqual(data['title'], 'Updated Title')

    def test_update_bug(self):
        reg_uuid, _ = _setup_regression_with_indicators(self.client, self.app, 1)
        headers = _triage_headers(self.app)
        resp = self.client.patch(
            PREFIX + f'/regressions/{reg_uuid}',
            json={'bug': 'https://bugs.example.com/123'},
            headers=headers,
        )
        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        self.assertEqual(data['bug'], 'https://bugs.example.com/123')

    def test_update_state(self):
        reg_uuid, _ = _setup_regression_with_indicators(self.client, self.app, 1)
        headers = _triage_headers(self.app)
        resp = self.client.patch(
            PREFIX + f'/regressions/{reg_uuid}',
            json={'state': 'fixed'},
            headers=headers,
        )
        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        self.assertEqual(data['state'], 'fixed')

    def test_update_state_any_transition(self):
        """State transitions are unconstrained -- any -> any."""
        reg_uuid, _ = _setup_regression_with_indicators(self.client, self.app, 1)
        headers = _triage_headers(self.app)
        # active -> ignored
        resp = self.client.patch(
            PREFIX + f'/regressions/{reg_uuid}',
            json={'state': 'ignored'},
            headers=headers,
        )
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.get_json()['state'], 'ignored')
        # ignored -> detected
        resp = self.client.patch(
            PREFIX + f'/regressions/{reg_uuid}',
            json={'state': 'detected'},
            headers=headers,
        )
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.get_json()['state'], 'detected')

    def test_update_invalid_state_422(self):
        reg_uuid, _ = _setup_regression_with_indicators(self.client, self.app, 1)
        headers = _triage_headers(self.app)
        resp = self.client.patch(
            PREFIX + f'/regressions/{reg_uuid}',
            json={'state': 'not_a_real_state'},
            headers=headers,
        )
        self.assertEqual(resp.status_code, 422)

    def test_update_nonexistent_404(self):
        headers = _triage_headers(self.app)
        resp = self.client.patch(
            PREFIX + '/regressions/nonexistent-uuid',
            json={'title': 'x'},
            headers=headers,
        )
        self.assertEqual(resp.status_code, 404)

    def test_update_no_auth_401(self):
        reg_uuid, _ = _setup_regression_with_indicators(self.client, self.app, 1)
        resp = self.client.patch(
            PREFIX + f'/regressions/{reg_uuid}',
            json={'title': 'x'},
        )
        self.assertEqual(resp.status_code, 401)

    def test_update_read_scope_403(self):
        reg_uuid, _ = _setup_regression_with_indicators(self.client, self.app, 1)
        headers = make_scoped_headers(self.app, 'read')
        resp = self.client.patch(
            PREFIX + f'/regressions/{reg_uuid}',
            json={'title': 'x'},
            headers=headers,
        )
        self.assertEqual(resp.status_code, 403)

    def test_update_returns_indicators(self):
        """PATCH response should include indicators."""
        reg_uuid, _ = _setup_regression_with_indicators(self.client, self.app, 2)
        headers = _triage_headers(self.app)
        resp = self.client.patch(
            PREFIX + f'/regressions/{reg_uuid}',
            json={'title': 'With Indicators'},
            headers=headers,
        )
        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        self.assertIn('indicators', data)
        self.assertEqual(len(data['indicators']), 2)


# ==========================================================================
# Regression Delete Tests
# ==========================================================================

class TestRegressionDelete(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.app = create_app(sys.argv[1])
        cls.client = create_client(cls.app)

    def test_delete_regression(self):
        reg_uuid, _ = _setup_regression_with_indicators(self.client, self.app, 1)
        headers = _triage_headers(self.app)
        resp = self.client.delete(
            PREFIX + f'/regressions/{reg_uuid}',
            headers=headers,
        )
        self.assertEqual(resp.status_code, 204)

        # Verify it's gone
        resp = self.client.get(PREFIX + f'/regressions/{reg_uuid}')
        self.assertEqual(resp.status_code, 404)

    def test_delete_nonexistent_404(self):
        headers = _triage_headers(self.app)
        resp = self.client.delete(
            PREFIX + '/regressions/nonexistent-uuid',
            headers=headers,
        )
        self.assertEqual(resp.status_code, 404)

    def test_delete_no_auth_401(self):
        reg_uuid, _ = _setup_regression_with_indicators(self.client, self.app, 1)
        resp = self.client.delete(
            PREFIX + f'/regressions/{reg_uuid}',
        )
        self.assertEqual(resp.status_code, 401)


# ==========================================================================
# Regression Merge Tests
# ==========================================================================

class TestRegressionMerge(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.app = create_app(sys.argv[1])
        cls.client = create_client(cls.app)

    def test_merge_regressions(self):
        """Merge source into target: target gets all indicators."""
        target_uuid, target_fcs = _setup_regression_with_indicators(
            self.client, self.app, 2)
        source_uuid, source_fcs = _setup_regression_with_indicators(
            self.client, self.app, 2)
        headers = _triage_headers(self.app)

        resp = self.client.post(
            PREFIX + f'/regressions/{target_uuid}/merge',
            json={'source_regression_uuids': [source_uuid]},
            headers=headers,
        )
        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        # Target should now have all 4 indicators
        self.assertEqual(len(data['indicators']), 4)

        # Source should be marked as IGNORED
        resp2 = self.client.get(PREFIX + f'/regressions/{source_uuid}')
        self.assertEqual(resp2.status_code, 200)
        self.assertEqual(resp2.get_json()['state'], 'ignored')

    def test_merge_deduplicates_indicators(self):
        """If source has same field change as target, deduplicate."""
        tag = uuid.uuid4().hex[:8]
        machine = f'dup-m-{tag}'
        rev1 = f'dup-o1-{tag}'
        rev2 = f'dup-o2-{tag}'
        test1 = f'dup-test/{tag}'
        test2 = f'dup-test2/{tag}'

        submit_run(self.client, machine, rev1, [
            {'name': test1, 'execution_time': [1.0]},
            {'name': test2, 'execution_time': [1.0]},
        ])
        submit_run(self.client, machine, rev2, [
            {'name': test1, 'execution_time': [2.0]},
            {'name': test2, 'execution_time': [2.0]},
        ])

        shared_fc = submit_fieldchange(self.client, self.app, machine,
                                       test1, 'execution_time',
                                       rev1, rev2)
        unique_fc = submit_fieldchange(self.client, self.app, machine,
                                       test2, 'execution_time',
                                       rev1, rev2)

        target = submit_regression(
            self.client, self.app,
            [shared_fc['uuid'], unique_fc['uuid']])
        source = submit_regression(
            self.client, self.app, [shared_fc['uuid']])

        target_uuid = target['uuid']
        source_uuid = source['uuid']

        headers = _triage_headers(self.app)
        resp = self.client.post(
            PREFIX + f'/regressions/{target_uuid}/merge',
            json={'source_regression_uuids': [source_uuid]},
            headers=headers,
        )
        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        self.assertEqual(len(data['indicators']), 2)

    def test_merge_into_self_400(self):
        reg_uuid, _ = _setup_regression_with_indicators(self.client, self.app, 1)
        headers = _triage_headers(self.app)
        resp = self.client.post(
            PREFIX + f'/regressions/{reg_uuid}/merge',
            json={'source_regression_uuids': [reg_uuid]},
            headers=headers,
        )
        self.assertEqual(resp.status_code, 400)

    def test_merge_missing_body_422(self):
        reg_uuid, _ = _setup_regression_with_indicators(self.client, self.app, 1)
        headers = _triage_headers(self.app)
        resp = self.client.post(
            PREFIX + f'/regressions/{reg_uuid}/merge',
            json={},
            headers=headers,
        )
        self.assertEqual(resp.status_code, 422)

    def test_merge_nonexistent_source_404(self):
        reg_uuid, _ = _setup_regression_with_indicators(self.client, self.app, 1)
        headers = _triage_headers(self.app)
        resp = self.client.post(
            PREFIX + f'/regressions/{reg_uuid}/merge',
            json={'source_regression_uuids': ['nonexistent-uuid']},
            headers=headers,
        )
        self.assertEqual(resp.status_code, 404)

    def test_merge_nonexistent_target_404(self):
        headers = _triage_headers(self.app)
        resp = self.client.post(
            PREFIX + '/regressions/nonexistent-uuid/merge',
            json={'source_regression_uuids': ['also-nonexistent']},
            headers=headers,
        )
        self.assertEqual(resp.status_code, 404)

    def test_merge_no_auth_401(self):
        reg_uuid, _ = _setup_regression_with_indicators(self.client, self.app, 1)
        resp = self.client.post(
            PREFIX + f'/regressions/{reg_uuid}/merge',
            json={'source_regression_uuids': ['x']},
        )
        self.assertEqual(resp.status_code, 401)


# ==========================================================================
# Regression Split Tests
# ==========================================================================

class TestRegressionSplit(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.app = create_app(sys.argv[1])
        cls.client = create_client(cls.app)

    def test_split_regression(self):
        """Split one field change into a new regression."""
        reg_uuid, fc_uuids = _setup_regression_with_indicators(self.client, self.app, 3)
        headers = _triage_headers(self.app)

        resp = self.client.post(
            PREFIX + f'/regressions/{reg_uuid}/split',
            json={'field_change_uuids': [fc_uuids[0]]},
            headers=headers,
        )
        self.assertEqual(resp.status_code, 201)
        data = resp.get_json()
        self.assertIn('uuid', data)
        self.assertNotEqual(data['uuid'], reg_uuid)
        self.assertEqual(len(data['indicators']), 1)
        self.assertEqual(data['indicators'][0]['field_change_uuid'],
                         fc_uuids[0])

        # Original regression should have 2 remaining indicators
        resp2 = self.client.get(PREFIX + f'/regressions/{reg_uuid}')
        self.assertEqual(resp2.status_code, 200)
        data2 = resp2.get_json()
        self.assertEqual(len(data2['indicators']), 2)

    def test_split_all_indicators_400(self):
        """Cannot split ALL indicators -- would leave source empty."""
        reg_uuid, fc_uuids = _setup_regression_with_indicators(self.client, self.app, 2)
        headers = _triage_headers(self.app)

        resp = self.client.post(
            PREFIX + f'/regressions/{reg_uuid}/split',
            json={'field_change_uuids': fc_uuids},
            headers=headers,
        )
        self.assertEqual(resp.status_code, 400)

    def test_split_missing_body_422(self):
        reg_uuid, _ = _setup_regression_with_indicators(self.client, self.app, 2)
        headers = _triage_headers(self.app)
        resp = self.client.post(
            PREFIX + f'/regressions/{reg_uuid}/split',
            json={},
            headers=headers,
        )
        self.assertEqual(resp.status_code, 422)

    def test_split_fc_not_in_regression_400(self):
        """Splitting a field change that's not in this regression -> 400."""
        reg_uuid, _ = _setup_regression_with_indicators(self.client, self.app, 2)
        other_fc_uuid = _setup_fieldchange(self.client, self.app)
        headers = _triage_headers(self.app)
        resp = self.client.post(
            PREFIX + f'/regressions/{reg_uuid}/split',
            json={'field_change_uuids': [other_fc_uuid]},
            headers=headers,
        )
        self.assertEqual(resp.status_code, 400)

    def test_split_nonexistent_regression_404(self):
        headers = _triage_headers(self.app)
        resp = self.client.post(
            PREFIX + '/regressions/nonexistent-uuid/split',
            json={'field_change_uuids': ['x']},
            headers=headers,
        )
        self.assertEqual(resp.status_code, 404)

    def test_split_no_auth_401(self):
        reg_uuid, fc_uuids = _setup_regression_with_indicators(self.client, self.app, 2)
        resp = self.client.post(
            PREFIX + f'/regressions/{reg_uuid}/split',
            json={'field_change_uuids': [fc_uuids[0]]},
        )
        self.assertEqual(resp.status_code, 401)


# ==========================================================================
# Regression Indicators Tests
# ==========================================================================

class TestRegressionIndicators(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.app = create_app(sys.argv[1])
        cls.client = create_client(cls.app)

    def test_list_indicators(self):
        reg_uuid, fc_uuids = _setup_regression_with_indicators(self.client, self.app, 2)
        resp = self.client.get(
            PREFIX + f'/regressions/{reg_uuid}/indicators')
        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        self.assertIn('items', data)
        self.assertEqual(len(data['items']), 2)
        self.assertIn('cursor', data)

    def test_list_indicators_nonexistent_regression_404(self):
        resp = self.client.get(
            PREFIX + '/regressions/nonexistent-uuid/indicators')
        self.assertEqual(resp.status_code, 404)

    def test_add_indicator(self):
        reg_uuid, _ = _setup_regression_with_indicators(self.client, self.app, 1)
        fc_uuid = _setup_fieldchange(self.client, self.app)
        headers = _triage_headers(self.app)

        resp = self.client.post(
            PREFIX + f'/regressions/{reg_uuid}/indicators',
            json={'field_change_uuid': fc_uuid},
            headers=headers,
        )
        self.assertEqual(resp.status_code, 201)
        data = resp.get_json()
        self.assertEqual(data['field_change_uuid'], fc_uuid)

        # Verify it appears in the indicators list
        resp2 = self.client.get(
            PREFIX + f'/regressions/{reg_uuid}/indicators')
        data2 = resp2.get_json()
        self.assertEqual(len(data2['items']), 2)

    def test_add_duplicate_indicator_409(self):
        reg_uuid, fc_uuids = _setup_regression_with_indicators(self.client, self.app, 1)
        headers = _triage_headers(self.app)
        resp = self.client.post(
            PREFIX + f'/regressions/{reg_uuid}/indicators',
            json={'field_change_uuid': fc_uuids[0]},
            headers=headers,
        )
        self.assertEqual(resp.status_code, 409)

    def test_add_nonexistent_fc_404(self):
        reg_uuid, _ = _setup_regression_with_indicators(self.client, self.app, 1)
        headers = _triage_headers(self.app)
        resp = self.client.post(
            PREFIX + f'/regressions/{reg_uuid}/indicators',
            json={'field_change_uuid': 'nonexistent-uuid'},
            headers=headers,
        )
        self.assertEqual(resp.status_code, 404)

    def test_add_indicator_no_auth_401(self):
        reg_uuid, _ = _setup_regression_with_indicators(self.client, self.app, 1)
        resp = self.client.post(
            PREFIX + f'/regressions/{reg_uuid}/indicators',
            json={'field_change_uuid': 'x'},
        )
        self.assertEqual(resp.status_code, 401)

    def test_remove_indicator(self):
        reg_uuid, fc_uuids = _setup_regression_with_indicators(self.client, self.app, 2)
        headers = _triage_headers(self.app)
        resp = self.client.delete(
            PREFIX + f'/regressions/{reg_uuid}/indicators/{fc_uuids[0]}',
            headers=headers,
        )
        self.assertEqual(resp.status_code, 204)

        # Verify indicator is removed
        resp2 = self.client.get(
            PREFIX + f'/regressions/{reg_uuid}/indicators')
        data2 = resp2.get_json()
        self.assertEqual(len(data2['items']), 1)

    def test_remove_nonexistent_indicator_404(self):
        reg_uuid, _ = _setup_regression_with_indicators(self.client, self.app, 1)
        headers = _triage_headers(self.app)
        resp = self.client.delete(
            PREFIX + f'/regressions/{reg_uuid}/indicators/nonexistent-fc-uuid',
            headers=headers,
        )
        self.assertEqual(resp.status_code, 404)

    def test_remove_indicator_not_linked_404(self):
        """Remove a field change that exists but is not linked."""
        reg_uuid, _ = _setup_regression_with_indicators(self.client, self.app, 1)
        other_fc_uuid = _setup_fieldchange(self.client, self.app)
        headers = _triage_headers(self.app)
        resp = self.client.delete(
            PREFIX + f'/regressions/{reg_uuid}/indicators/{other_fc_uuid}',
            headers=headers,
        )
        self.assertEqual(resp.status_code, 404)

    def test_invalid_cursor_returns_400(self):
        """An invalid cursor string should return 400."""
        reg_uuid, _ = _setup_regression_with_indicators(self.client, self.app, 1)
        resp = self.client.get(
            PREFIX + f'/regressions/{reg_uuid}/indicators'
                     '?cursor=not-a-valid-cursor!!!')
        self.assertEqual(resp.status_code, 400)


class TestRegressionZPagination(unittest.TestCase):
    """Exhaustive cursor pagination tests for GET /api/v5/{ts}/regressions."""
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.app = create_app(sys.argv[1])
        cls.client = create_client(cls.app)
        cls._reg_uuids = []
        for _ in range(5):
            reg_uuid, _ = _setup_regression_with_indicators(cls.client, cls.app, 1)
            cls._reg_uuids.append(reg_uuid)

    def _collect_all_pages(self):
        url = PREFIX + '/regressions?limit=2'
        return collect_all_pages(self, self.client, url, page_limit=100)

    def test_pagination_collects_all_items(self):
        """Paginating through all pages collects all created regressions."""
        all_items = self._collect_all_pages()
        collected_uuids = [item['uuid'] for item in all_items]
        for reg_uuid in self._reg_uuids:
            self.assertIn(reg_uuid, collected_uuids)

    def test_no_duplicate_items_across_pages(self):
        """No duplicate regression UUIDs across pages."""
        all_items = self._collect_all_pages()
        uuids = [item['uuid'] for item in all_items]
        self.assertEqual(len(uuids), len(set(uuids)))


class TestRegressionZIndicatorPagination(unittest.TestCase):
    """Exhaustive cursor pagination tests for GET /api/v5/{ts}/regressions/{uuid}/indicators."""
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.app = create_app(sys.argv[1])
        cls.client = create_client(cls.app)
        cls._reg_uuid, cls._fc_uuids = _setup_regression_with_indicators(
            cls.client, cls.app, num_indicators=5)

    def _collect_all_pages(self):
        url = PREFIX + f'/regressions/{self._reg_uuid}/indicators?limit=2'
        return collect_all_pages(self, self.client, url)

    def test_pagination_collects_all_items(self):
        """Paginating through all pages collects all 5 indicators."""
        all_items = self._collect_all_pages()
        self.assertEqual(len(all_items), 5)

    def test_no_duplicate_items_across_pages(self):
        """No duplicate field change UUIDs across pages."""
        all_items = self._collect_all_pages()
        fc_uuids = [item['field_change_uuid'] for item in all_items]
        self.assertEqual(len(fc_uuids), len(set(fc_uuids)))


class TestRegressionUnknownParams(unittest.TestCase):
    """Test that unknown query parameters are rejected with 400."""
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.app = create_app(sys.argv[1])
        cls.client = create_client(cls.app)

    def test_regressions_list_unknown_param_returns_400(self):
        resp = self.client.get(PREFIX + '/regressions?bogus=1')
        self.assertEqual(resp.status_code, 400)
        data = resp.get_json()
        self.assertIn('bogus', data['error']['message'])

    def test_regression_detail_unknown_param_returns_400(self):
        reg_uuid, _ = _setup_regression_with_indicators(self.client, self.app, 1)
        resp = self.client.get(
            PREFIX + f'/regressions/{reg_uuid}?bogus=1')
        self.assertEqual(resp.status_code, 400)

    def test_regression_indicators_unknown_param_returns_400(self):
        reg_uuid, _ = _setup_regression_with_indicators(self.client, self.app, 1)
        resp = self.client.get(
            PREFIX + f'/regressions/{reg_uuid}/indicators?bogus=1')
        self.assertEqual(resp.status_code, 400)


if __name__ == '__main__':
    unittest.main(argv=[sys.argv[0]], exit=True)

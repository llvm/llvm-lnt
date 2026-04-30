# Tests for the v5 regression endpoints.
#
# RUN: rm -rf %t.instance %t.pg.log
# RUN: %{utils}/with_postgres.sh %t.pg.log \
# RUN:     %{utils}/with_temporary_instance.py --db-version 5.0 %t.instance \
# RUN:         -- python %s %t.instance
# END.

import sys
import os
import unittest
import uuid

sys.path.insert(0, os.path.dirname(__file__))
from v5_test_helpers import (
    create_app, create_client, make_scoped_headers,
    collect_all_pages, submit_run, submit_regression,
)


TS = 'nts'
PREFIX = f'/api/v5/{TS}'


def _triage_headers(app):
    return make_scoped_headers(app, 'triage')


def _setup_regression_with_indicators(client, num_indicators=2,
                                      state='active', commit=None):
    """Create a regression with indicators via the API.

    Returns (regression_uuid, [indicator_uuid, ...]).
    """
    tag = uuid.uuid4().hex[:8]
    machine = f'reg-m-{tag}'
    tests = [f'reg/test/{tag}/{i}' for i in range(num_indicators)]

    # Ensure machine and tests exist by submitting a run
    submit_run(client, machine, f'reg-rev-{tag}',
               [{'name': t, 'execution_time': [1.0 + i]}
                for i, t in enumerate(tests)])

    indicators = [
        {'machine': machine, 'test': t, 'metric': 'execution_time'}
        for t in tests
    ]
    reg = submit_regression(client, indicators=indicators,
                            state=state, commit=commit)
    indicator_uuids = [ind['uuid'] for ind in reg['indicators']]
    return reg['uuid'], indicator_uuids


# ==========================================================================
# Regression List Tests
# ==========================================================================

def _find_in_list(items, uuid):
    """Find an item by UUID in a list response's items array."""
    for r in items:
        if r['uuid'] == uuid:
            return r
    return None


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
        reg_uuid, _ = _setup_regression_with_indicators(self.client, 1)
        resp = self.client.get(PREFIX + '/regressions?limit=500')
        data = resp.get_json()
        item = _find_in_list(data['items'], reg_uuid)
        self.assertIsNotNone(item)
        self.assertIn('uuid', item)
        self.assertIn('title', item)
        self.assertIn('bug', item)
        self.assertIn('state', item)
        self.assertIn('commit', item)
        self.assertIn('machine_count', item)
        self.assertIn('test_count', item)
        # List items should NOT have indicators embedded
        self.assertNotIn('indicators', item)

    def test_list_item_machine_and_test_counts(self):
        """Create a regression with 2 indicators (1 machine, 2 tests).
        Verify machine_count == 1 and test_count == 2."""
        reg_uuid, _ = _setup_regression_with_indicators(
            self.client, 2)
        resp = self.client.get(PREFIX + '/regressions?limit=500')
        data = resp.get_json()
        item = _find_in_list(data['items'], reg_uuid)
        self.assertIsNotNone(item)
        self.assertEqual(item['machine_count'], 1)
        self.assertEqual(item['test_count'], 2)

    def test_list_filter_by_state(self):
        _setup_regression_with_indicators(self.client, 1)
        resp = self.client.get(PREFIX + '/regressions?state=active')
        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        for r in data['items']:
            self.assertEqual(r['state'], 'active')

    def test_list_filter_by_state_multiple(self):
        tag = uuid.uuid4().hex[:8]
        machine = f'state-m-{tag}'
        test1 = f'state-test/{tag}/1'
        test2 = f'state-test/{tag}/2'

        submit_run(self.client, machine, f'state-rev-{tag}', [
            {'name': test1, 'execution_time': [1.0]},
            {'name': test2, 'execution_time': [1.0]},
        ])

        submit_regression(
            self.client,
            indicators=[{'machine': machine, 'test': test1,
                         'metric': 'execution_time'}],
            state='active')
        submit_regression(
            self.client,
            indicators=[{'machine': machine, 'test': test2,
                         'metric': 'execution_time'}],
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
            _setup_regression_with_indicators(self.client, 1)
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
    """Tests for machine, test, metric, commit, and has_commit filters."""

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
        test_name = f'filter/test/{tag}'

        submit_run(self.client, machine_name, f'filter-r1-{tag}',
                   [{'name': test_name, 'execution_time': [1.0]}])

        reg = submit_regression(
            self.client,
            indicators=[{'machine': machine_name, 'test': test_name,
                         'metric': 'execution_time'}])

        uuids = self._collect_filtered(f'machine={machine_name}')
        self.assertIn(reg['uuid'], uuids)

    def test_list_filter_by_test(self):
        """Filter by test name returns only regressions on that test."""
        tag = uuid.uuid4().hex[:8]
        machine_name = f'filter-tm-{tag}'
        test_name = f'filter/testname/{tag}'

        submit_run(self.client, machine_name, f'filter-tr1-{tag}',
                   [{'name': test_name, 'execution_time': [1.0]}])

        reg = submit_regression(
            self.client,
            indicators=[{'machine': machine_name, 'test': test_name,
                         'metric': 'execution_time'}])

        uuids = self._collect_filtered(f'test={test_name}')
        self.assertIn(reg['uuid'], uuids)

    def test_list_filter_by_metric(self):
        """Filter by metric returns only regressions with that metric."""
        tag = uuid.uuid4().hex[:8]
        machine_name = f'filter-mm-{tag}'
        test_ct = f'filter/compile/{tag}'
        test_et = f'filter/exec/{tag}'

        # Submit runs with both metrics
        submit_run(self.client, machine_name, f'filter-mr1-{tag}', [
            {'name': test_ct, 'compile_time': [5.0]},
            {'name': test_et, 'execution_time': [1.0]},
        ])

        # Create regression for compile_time
        reg_ct = submit_regression(
            self.client,
            indicators=[{'machine': machine_name, 'test': test_ct,
                         'metric': 'compile_time'}])

        # Create regression for execution_time
        reg_et = submit_regression(
            self.client,
            indicators=[{'machine': machine_name, 'test': test_et,
                         'metric': 'execution_time'}])

        # Filter by execution_time -- should include reg_et, exclude reg_ct
        uuids = self._collect_filtered('metric=execution_time')
        self.assertIn(reg_et['uuid'], uuids)
        self.assertNotIn(reg_ct['uuid'], uuids)

    def test_list_filter_by_metric_unknown_returns_400(self):
        """Filtering by a nonexistent metric returns 400."""
        resp = self.client.get(
            PREFIX + '/regressions?metric=nonexistent_metric')
        self.assertEqual(resp.status_code, 400)

    def test_list_filter_nonexistent_machine_404(self):
        """Filtering by a nonexistent machine name returns 404."""
        resp = self.client.get(
            PREFIX + '/regressions?machine=no-such-machine-xyz')
        self.assertEqual(resp.status_code, 404)

    def test_list_filter_nonexistent_test_404(self):
        """Filtering by a nonexistent test name returns 404."""
        resp = self.client.get(
            PREFIX + '/regressions?test=no/such/test/xyz')
        self.assertEqual(resp.status_code, 404)

    def test_list_filter_combined(self):
        """Combined machine + test + metric filter narrows results."""
        tag = uuid.uuid4().hex[:8]
        machine_name = f'filter-cm-{tag}'
        test_name = f'filter/combined/{tag}'

        submit_run(self.client, machine_name, f'filter-cr1-{tag}',
                   [{'name': test_name, 'execution_time': [1.0]}])

        reg = submit_regression(
            self.client,
            indicators=[{'machine': machine_name, 'test': test_name,
                         'metric': 'execution_time'}])

        uuids = self._collect_filtered(
            f'machine={machine_name}&test={test_name}'
            f'&metric=execution_time')
        self.assertIn(reg['uuid'], uuids)

    def test_list_filter_by_commit(self):
        """Filter by commit returns only regressions with that commit."""
        tag = uuid.uuid4().hex[:8]
        machine = f'fc-m-{tag}'
        test = f'fc/test/{tag}'
        rev1 = f'fc-rev1-{tag}'
        rev2 = f'fc-rev2-{tag}'

        submit_run(self.client, machine, rev1,
                   [{'name': test, 'execution_time': [1.0]}])
        submit_run(self.client, machine, rev2,
                   [{'name': test, 'execution_time': [2.0]}])

        reg1 = submit_regression(
            self.client,
            indicators=[{'machine': machine, 'test': test,
                         'metric': 'execution_time'}],
            commit=rev1)
        reg2 = submit_regression(
            self.client,
            indicators=[{'machine': machine, 'test': test,
                         'metric': 'execution_time'}],
            commit=rev2)

        uuids = self._collect_filtered(f'commit={rev1}')
        self.assertIn(reg1['uuid'], uuids)
        self.assertNotIn(reg2['uuid'], uuids)

    def test_list_filter_by_has_commit(self):
        """has_commit=true/false filters correctly."""
        tag = uuid.uuid4().hex[:8]
        machine = f'hc-m-{tag}'
        test1 = f'hc/test1/{tag}'
        test2 = f'hc/test2/{tag}'
        rev = f'hc-rev-{tag}'

        submit_run(self.client, machine, rev, [
            {'name': test1, 'execution_time': [1.0]},
            {'name': test2, 'execution_time': [1.0]},
        ])

        reg_with = submit_regression(
            self.client,
            indicators=[{'machine': machine, 'test': test1,
                         'metric': 'execution_time'}],
            commit=rev)
        reg_without = submit_regression(
            self.client,
            indicators=[{'machine': machine, 'test': test2,
                         'metric': 'execution_time'}])

        for filter_val, in_with, in_without in [
            ('true', True, False),
            ('false', False, True),
        ]:
            with self.subTest(has_commit=filter_val):
                uuids = self._collect_filtered(f'has_commit={filter_val}')
                check = self.assertIn if in_with else self.assertNotIn
                check(reg_with['uuid'], uuids)
                check = self.assertIn if in_without else self.assertNotIn
                check(reg_without['uuid'], uuids)

    def test_list_item_commit_value(self):
        """List item contains the commit string value."""
        tag = uuid.uuid4().hex[:8]
        machine = f'lcv-m-{tag}'
        test = f'lcv/test/{tag}'
        rev = f'lcv-rev-{tag}'

        submit_run(self.client, machine, rev,
                   [{'name': test, 'execution_time': [1.0]}])

        reg = submit_regression(
            self.client,
            indicators=[{'machine': machine, 'test': test,
                         'metric': 'execution_time'}],
            commit=rev)

        resp = self.client.get(PREFIX + '/regressions?limit=500')
        data = resp.get_json()
        item = _find_in_list(data['items'], reg['uuid'])
        self.assertIsNotNone(item)
        self.assertEqual(item['commit'], rev)


# ==========================================================================
# Regression Create Tests
# ==========================================================================

class TestRegressionCreate(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.app = create_app(sys.argv[1])
        cls.client = create_client(cls.app)

    def _setup_machine_and_test(self):
        """Create machine and test via a run, return (machine_name, test_name)."""
        tag = uuid.uuid4().hex[:8]
        machine = f'cr-m-{tag}'
        test = f'cr/test/{tag}'
        submit_run(self.client, machine, f'cr-rev-{tag}',
                   [{'name': test, 'execution_time': [1.0]}])
        return machine, test

    def test_create_regression(self):
        machine, test = self._setup_machine_and_test()
        headers = _triage_headers(self.app)
        resp = self.client.post(
            PREFIX + '/regressions',
            json={'indicators': [
                {'machine': machine, 'test': test, 'metric': 'execution_time'}
            ]},
            headers=headers,
        )
        self.assertEqual(resp.status_code, 201)
        data = resp.get_json()
        self.assertIn('uuid', data)
        self.assertIn('indicators', data)
        self.assertEqual(len(data['indicators']), 1)
        ind = data['indicators'][0]
        self.assertIn('uuid', ind)
        self.assertEqual(ind['machine'], machine)
        self.assertEqual(ind['test'], test)
        self.assertEqual(ind['metric'], 'execution_time')

    def test_create_with_custom_title(self):
        machine, test = self._setup_machine_and_test()
        headers = _triage_headers(self.app)
        resp = self.client.post(
            PREFIX + '/regressions',
            json={
                'indicators': [
                    {'machine': machine, 'test': test,
                     'metric': 'execution_time'}
                ],
                'title': 'Custom Title',
            },
            headers=headers,
        )
        self.assertEqual(resp.status_code, 201)
        data = resp.get_json()
        self.assertEqual(data['title'], 'Custom Title')

    def test_create_with_state(self):
        machine, test = self._setup_machine_and_test()
        headers = _triage_headers(self.app)
        resp = self.client.post(
            PREFIX + '/regressions',
            json={
                'indicators': [
                    {'machine': machine, 'test': test,
                     'metric': 'execution_time'}
                ],
                'state': 'active',
            },
            headers=headers,
        )
        self.assertEqual(resp.status_code, 201)
        data = resp.get_json()
        self.assertEqual(data['state'], 'active')

    def test_create_default_state_detected(self):
        machine, test = self._setup_machine_and_test()
        headers = _triage_headers(self.app)
        resp = self.client.post(
            PREFIX + '/regressions',
            json={'indicators': [
                {'machine': machine, 'test': test, 'metric': 'execution_time'}
            ]},
            headers=headers,
        )
        self.assertEqual(resp.status_code, 201)
        data = resp.get_json()
        self.assertEqual(data['state'], 'detected')

    def test_create_empty_body_succeeds(self):
        """Empty body (no indicators) should succeed with NULL title."""
        headers = _triage_headers(self.app)
        resp = self.client.post(
            PREFIX + '/regressions',
            json={},
            headers=headers,
        )
        self.assertEqual(resp.status_code, 201)
        data = resp.get_json()
        self.assertIn('uuid', data)
        self.assertIsNone(data['title'])
        self.assertEqual(len(data['indicators']), 0)

    def test_create_with_explicit_title(self):
        """Providing a title stores it."""
        headers = _triage_headers(self.app)
        resp = self.client.post(
            PREFIX + '/regressions',
            json={'title': 'My regression'},
            headers=headers,
        )
        self.assertEqual(resp.status_code, 201)
        data = resp.get_json()
        self.assertEqual(data['title'], 'My regression')

    def test_create_with_commit(self):
        """Create a regression with a commit field."""
        tag = uuid.uuid4().hex[:8]
        machine = f'cc-m-{tag}'
        test = f'cc/test/{tag}'
        rev = f'cc-rev-{tag}'
        submit_run(self.client, machine, rev,
                   [{'name': test, 'execution_time': [1.0]}])

        headers = _triage_headers(self.app)
        resp = self.client.post(
            PREFIX + '/regressions',
            json={
                'indicators': [
                    {'machine': machine, 'test': test,
                     'metric': 'execution_time'}
                ],
                'commit': rev,
            },
            headers=headers,
        )
        self.assertEqual(resp.status_code, 201)
        data = resp.get_json()
        self.assertEqual(data['commit'], rev)

    def test_create_with_notes(self):
        """Create a regression with notes field."""
        headers = _triage_headers(self.app)
        resp = self.client.post(
            PREFIX + '/regressions',
            json={'notes': 'Investigation notes here'},
            headers=headers,
        )
        self.assertEqual(resp.status_code, 201)
        data = resp.get_json()
        self.assertEqual(data['notes'], 'Investigation notes here')

    def test_create_nonexistent_machine_404(self):
        """Indicator referencing a nonexistent machine returns 404."""
        tag = uuid.uuid4().hex[:8]
        # Create a test but not a machine
        machine_ok = f'cnm-m-{tag}'
        test_name = f'cnm/test/{tag}'
        submit_run(self.client, machine_ok, f'cnm-rev-{tag}',
                   [{'name': test_name, 'execution_time': [1.0]}])

        headers = _triage_headers(self.app)
        resp = self.client.post(
            PREFIX + '/regressions',
            json={'indicators': [
                {'machine': 'nonexistent-machine-xyz',
                 'test': test_name, 'metric': 'execution_time'}
            ]},
            headers=headers,
        )
        self.assertEqual(resp.status_code, 404)

    def test_create_nonexistent_test_404(self):
        """Indicator referencing a nonexistent test returns 404."""
        tag = uuid.uuid4().hex[:8]
        machine = f'cnt-m-{tag}'
        submit_run(self.client, machine, f'cnt-rev-{tag}',
                   [{'name': f'cnt/test/{tag}', 'execution_time': [1.0]}])

        headers = _triage_headers(self.app)
        resp = self.client.post(
            PREFIX + '/regressions',
            json={'indicators': [
                {'machine': machine,
                 'test': 'nonexistent/test/xyz',
                 'metric': 'execution_time'}
            ]},
            headers=headers,
        )
        self.assertEqual(resp.status_code, 404)

    def test_create_unknown_metric_400(self):
        """Indicator referencing an unknown metric returns 400."""
        machine, test = self._setup_machine_and_test()
        headers = _triage_headers(self.app)
        resp = self.client.post(
            PREFIX + '/regressions',
            json={'indicators': [
                {'machine': machine, 'test': test,
                 'metric': 'nonexistent_metric'}
            ]},
            headers=headers,
        )
        self.assertEqual(resp.status_code, 400)

    def test_create_nonexistent_commit_404(self):
        """Commit field referencing a nonexistent commit returns 404."""
        headers = _triage_headers(self.app)
        resp = self.client.post(
            PREFIX + '/regressions',
            json={'commit': 'nonexistent-commit-xyz'},
            headers=headers,
        )
        self.assertEqual(resp.status_code, 404)

    def test_create_invalid_state_422(self):
        headers = _triage_headers(self.app)
        resp = self.client.post(
            PREFIX + '/regressions',
            json={'state': 'bogus_state'},
            headers=headers,
        )
        self.assertEqual(resp.status_code, 422)

    def test_create_no_auth_401(self):
        resp = self.client.post(
            PREFIX + '/regressions',
            json={},
        )
        self.assertEqual(resp.status_code, 401)

    def test_create_submit_scope_403(self):
        """Submit scope (one below triage) returns 403."""
        headers = make_scoped_headers(self.app, 'submit')
        resp = self.client.post(
            PREFIX + '/regressions',
            json={},
            headers=headers,
        )
        self.assertEqual(resp.status_code, 403)

    def test_create_triage_scope_201(self):
        """Triage scope (the required scope) succeeds."""
        headers = _triage_headers(self.app)
        resp = self.client.post(
            PREFIX + '/regressions',
            json={},
            headers=headers,
        )
        self.assertEqual(resp.status_code, 201)


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
        reg_uuid, _ = _setup_regression_with_indicators(
            self.client, 1)
        resp = self.client.get(PREFIX + f'/regressions/{reg_uuid}')
        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        self.assertEqual(data['uuid'], reg_uuid)
        self.assertIn('title', data)
        self.assertIn('bug', data)
        self.assertIn('notes', data)
        self.assertIn('state', data)
        self.assertIn('commit', data)
        self.assertIn('indicators', data)
        self.assertEqual(len(data['indicators']), 1)
        ind = data['indicators'][0]
        self.assertIn('uuid', ind)
        self.assertIn('test', ind)
        self.assertIn('machine', ind)
        self.assertIn('metric', ind)
        # Old fields should NOT be present
        self.assertNotIn('field_change_uuid', ind)
        self.assertNotIn('old_value', ind)
        self.assertNotIn('new_value', ind)
        self.assertNotIn('start_commit', ind)
        self.assertNotIn('end_commit', ind)

    def test_detail_nonexistent_404(self):
        resp = self.client.get(
            PREFIX + '/regressions/nonexistent-uuid-12345')
        self.assertEqual(resp.status_code, 404)

    def test_detail_state_is_string(self):
        reg_uuid, _ = _setup_regression_with_indicators(
            self.client, 1)
        resp = self.client.get(PREFIX + f'/regressions/{reg_uuid}')
        data = resp.get_json()
        self.assertIsInstance(data['state'], str)
        self.assertEqual(data['state'], 'active')


class TestRegressionDetailETag(unittest.TestCase):
    """ETag tests for GET /api/v5/{ts}/regressions/{uuid}."""
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.app = create_app(sys.argv[1])
        cls.client = create_client(cls.app)

    def test_etag_present_on_detail(self):
        """Regression detail response should include an ETag header."""
        reg_uuid, _ = _setup_regression_with_indicators(
            self.client, 1)
        resp = self.client.get(PREFIX + f'/regressions/{reg_uuid}')
        self.assertEqual(resp.status_code, 200)
        etag = resp.headers.get('ETag')
        self.assertIsNotNone(etag)
        self.assertTrue(etag.startswith('W/"'))

    def test_etag_304_on_match(self):
        """Sending If-None-Match with the same ETag returns 304."""
        reg_uuid, _ = _setup_regression_with_indicators(
            self.client, 1)
        resp = self.client.get(PREFIX + f'/regressions/{reg_uuid}')
        etag = resp.headers.get('ETag')

        resp2 = self.client.get(
            PREFIX + f'/regressions/{reg_uuid}',
            headers={'If-None-Match': etag},
        )
        self.assertEqual(resp2.status_code, 304)

    def test_etag_200_on_mismatch(self):
        """Sending If-None-Match with a different ETag returns 200."""
        reg_uuid, _ = _setup_regression_with_indicators(
            self.client, 1)
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
        reg_uuid, _ = _setup_regression_with_indicators(
            self.client, 1)
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
        reg_uuid, _ = _setup_regression_with_indicators(
            self.client, 1)
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
        reg_uuid, _ = _setup_regression_with_indicators(
            self.client, 1)
        headers = _triage_headers(self.app)
        resp = self.client.patch(
            PREFIX + f'/regressions/{reg_uuid}',
            json={'state': 'fixed'},
            headers=headers,
        )
        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        self.assertEqual(data['state'], 'fixed')

    def test_update_notes(self):
        reg_uuid, _ = _setup_regression_with_indicators(
            self.client, 1)
        headers = _triage_headers(self.app)
        resp = self.client.patch(
            PREFIX + f'/regressions/{reg_uuid}',
            json={'notes': 'Updated investigation notes'},
            headers=headers,
        )
        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        self.assertEqual(data['notes'], 'Updated investigation notes')

    def test_update_commit(self):
        tag = uuid.uuid4().hex[:8]
        machine = f'uc-m-{tag}'
        test = f'uc/test/{tag}'
        rev = f'uc-rev-{tag}'
        submit_run(self.client, machine, rev,
                   [{'name': test, 'execution_time': [1.0]}])

        reg_uuid, _ = _setup_regression_with_indicators(
            self.client, 1)
        headers = _triage_headers(self.app)
        resp = self.client.patch(
            PREFIX + f'/regressions/{reg_uuid}',
            json={'commit': rev},
            headers=headers,
        )
        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        self.assertEqual(data['commit'], rev)

    def test_clear_commit(self):
        """PATCH commit=null clears the commit."""
        tag = uuid.uuid4().hex[:8]
        machine = f'clc-m-{tag}'
        test = f'clc/test/{tag}'
        rev = f'clc-rev-{tag}'
        submit_run(self.client, machine, rev,
                   [{'name': test, 'execution_time': [1.0]}])

        reg_uuid, _ = _setup_regression_with_indicators(
            self.client, 1, commit=rev)
        headers = _triage_headers(self.app)
        resp = self.client.patch(
            PREFIX + f'/regressions/{reg_uuid}',
            json={'commit': None},
            headers=headers,
        )
        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        self.assertIsNone(data['commit'])

    def test_clear_notes(self):
        """PATCH notes=null clears the notes."""
        reg_uuid, _ = _setup_regression_with_indicators(
            self.client, 1)
        headers = _triage_headers(self.app)
        # Set notes first
        self.client.patch(
            PREFIX + f'/regressions/{reg_uuid}',
            json={'notes': 'Some notes'},
            headers=headers,
        )
        # Clear notes
        resp = self.client.patch(
            PREFIX + f'/regressions/{reg_uuid}',
            json={'notes': None},
            headers=headers,
        )
        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        self.assertIsNone(data['notes'])

    def test_update_state_any_transition(self):
        """State transitions are unconstrained -- any -> any."""
        reg_uuid, _ = _setup_regression_with_indicators(
            self.client, 1)
        headers = _triage_headers(self.app)
        # active -> false_positive
        resp = self.client.patch(
            PREFIX + f'/regressions/{reg_uuid}',
            json={'state': 'false_positive'},
            headers=headers,
        )
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.get_json()['state'], 'false_positive')
        # false_positive -> detected
        resp = self.client.patch(
            PREFIX + f'/regressions/{reg_uuid}',
            json={'state': 'detected'},
            headers=headers,
        )
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.get_json()['state'], 'detected')

    def test_update_invalid_state_422(self):
        reg_uuid, _ = _setup_regression_with_indicators(
            self.client, 1)
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
        reg_uuid, _ = _setup_regression_with_indicators(
            self.client, 1)
        resp = self.client.patch(
            PREFIX + f'/regressions/{reg_uuid}',
            json={'title': 'x'},
        )
        self.assertEqual(resp.status_code, 401)

    def test_update_submit_scope_403(self):
        """Submit scope (one below triage) returns 403."""
        reg_uuid, _ = _setup_regression_with_indicators(
            self.client, 1)
        headers = make_scoped_headers(self.app, 'submit')
        resp = self.client.patch(
            PREFIX + f'/regressions/{reg_uuid}',
            json={'title': 'x'},
            headers=headers,
        )
        self.assertEqual(resp.status_code, 403)

    def test_update_triage_scope_200(self):
        """Triage scope (the required scope) succeeds."""
        reg_uuid, _ = _setup_regression_with_indicators(
            self.client, 1)
        headers = _triage_headers(self.app)
        resp = self.client.patch(
            PREFIX + f'/regressions/{reg_uuid}',
            json={'title': 'Triage update'},
            headers=headers,
        )
        self.assertEqual(resp.status_code, 200)

    def test_update_returns_indicators(self):
        """PATCH response should include indicators."""
        reg_uuid, _ = _setup_regression_with_indicators(
            self.client, 2)
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
        reg_uuid, _ = _setup_regression_with_indicators(
            self.client, 1)
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
        reg_uuid, _ = _setup_regression_with_indicators(
            self.client, 1)
        resp = self.client.delete(
            PREFIX + f'/regressions/{reg_uuid}',
        )
        self.assertEqual(resp.status_code, 401)

    def test_delete_submit_scope_403(self):
        """Submit scope (one below triage) returns 403."""
        reg_uuid, _ = _setup_regression_with_indicators(
            self.client, 1)
        headers = make_scoped_headers(self.app, 'submit')
        resp = self.client.delete(
            PREFIX + f'/regressions/{reg_uuid}',
            headers=headers,
        )
        self.assertEqual(resp.status_code, 403)

    def test_delete_triage_scope_204(self):
        """Triage scope (the required scope) succeeds."""
        reg_uuid, _ = _setup_regression_with_indicators(
            self.client, 1)
        headers = _triage_headers(self.app)
        resp = self.client.delete(
            PREFIX + f'/regressions/{reg_uuid}',
            headers=headers,
        )
        self.assertEqual(resp.status_code, 204)


# ==========================================================================
# Regression Indicators Tests
# ==========================================================================

class TestRegressionIndicators(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.app = create_app(sys.argv[1])
        cls.client = create_client(cls.app)

    def test_add_indicator(self):
        """Add an indicator to an existing regression."""
        reg_uuid, _ = _setup_regression_with_indicators(
            self.client, 1)

        # Create a new test/machine for the new indicator
        tag = uuid.uuid4().hex[:8]
        machine = f'add-m-{tag}'
        test = f'add/test/{tag}'
        submit_run(self.client, machine, f'add-rev-{tag}',
                   [{'name': test, 'execution_time': [1.0]}])

        headers = _triage_headers(self.app)
        resp = self.client.post(
            PREFIX + f'/regressions/{reg_uuid}/indicators',
            json={'indicators': [
                {'machine': machine, 'test': test,
                 'metric': 'execution_time'}
            ]},
            headers=headers,
        )
        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        self.assertIn('indicators', data)
        self.assertEqual(len(data['indicators']), 2)

    def test_add_duplicate_silently_ignored(self):
        """Adding a duplicate indicator is silently ignored."""
        reg_uuid, ind_uuids = _setup_regression_with_indicators(
            self.client, 1)

        # Get the existing indicator details
        resp = self.client.get(PREFIX + f'/regressions/{reg_uuid}')
        data = resp.get_json()
        existing = data['indicators'][0]

        headers = _triage_headers(self.app)
        resp2 = self.client.post(
            PREFIX + f'/regressions/{reg_uuid}/indicators',
            json={'indicators': [
                {'machine': existing['machine'], 'test': existing['test'],
                 'metric': existing['metric']}
            ]},
            headers=headers,
        )
        self.assertEqual(resp2.status_code, 200)
        data2 = resp2.get_json()
        self.assertEqual(len(data2['indicators']), 1)

    def test_add_nonexistent_machine_404(self):
        reg_uuid, _ = _setup_regression_with_indicators(
            self.client, 1)
        headers = _triage_headers(self.app)
        resp = self.client.post(
            PREFIX + f'/regressions/{reg_uuid}/indicators',
            json={'indicators': [
                {'machine': 'nonexistent-machine-xyz',
                 'test': 'some/test', 'metric': 'execution_time'}
            ]},
            headers=headers,
        )
        self.assertEqual(resp.status_code, 404)

    def test_add_nonexistent_test_404(self):
        reg_uuid, _ = _setup_regression_with_indicators(
            self.client, 1)
        # Get the existing indicator machine name
        resp = self.client.get(PREFIX + f'/regressions/{reg_uuid}')
        existing_machine = resp.get_json()['indicators'][0]['machine']

        headers = _triage_headers(self.app)
        resp2 = self.client.post(
            PREFIX + f'/regressions/{reg_uuid}/indicators',
            json={'indicators': [
                {'machine': existing_machine,
                 'test': 'nonexistent/test/xyz',
                 'metric': 'execution_time'}
            ]},
            headers=headers,
        )
        self.assertEqual(resp2.status_code, 404)

    def test_add_unknown_metric_400(self):
        reg_uuid, _ = _setup_regression_with_indicators(
            self.client, 1)
        resp = self.client.get(PREFIX + f'/regressions/{reg_uuid}')
        existing = resp.get_json()['indicators'][0]

        headers = _triage_headers(self.app)
        resp2 = self.client.post(
            PREFIX + f'/regressions/{reg_uuid}/indicators',
            json={'indicators': [
                {'machine': existing['machine'],
                 'test': existing['test'],
                 'metric': 'nonexistent_metric'}
            ]},
            headers=headers,
        )
        self.assertEqual(resp2.status_code, 400)

    def test_add_indicator_no_auth_401(self):
        reg_uuid, _ = _setup_regression_with_indicators(
            self.client, 1)
        resp = self.client.post(
            PREFIX + f'/regressions/{reg_uuid}/indicators',
            json={'indicators': [
                {'machine': 'x', 'test': 'y', 'metric': 'z'}
            ]},
        )
        self.assertEqual(resp.status_code, 401)

    def test_add_indicator_submit_scope_403(self):
        """Submit scope (one below triage) returns 403."""
        reg_uuid, _ = _setup_regression_with_indicators(
            self.client, 1)
        headers = make_scoped_headers(self.app, 'submit')
        resp = self.client.post(
            PREFIX + f'/regressions/{reg_uuid}/indicators',
            json={'indicators': [
                {'machine': 'x', 'test': 'y', 'metric': 'z'}
            ]},
            headers=headers,
        )
        self.assertEqual(resp.status_code, 403)

    def test_add_empty_list_422(self):
        """POST with empty indicators list returns 422."""
        reg_uuid, _ = _setup_regression_with_indicators(
            self.client, 1)
        headers = _triage_headers(self.app)
        resp = self.client.post(
            PREFIX + f'/regressions/{reg_uuid}/indicators',
            json={'indicators': []},
            headers=headers,
        )
        self.assertEqual(resp.status_code, 422)

    def test_remove_indicator(self):
        """Remove indicators via batch DELETE."""
        reg_uuid, ind_uuids = _setup_regression_with_indicators(
            self.client, 2)
        headers = _triage_headers(self.app)
        resp = self.client.delete(
            PREFIX + f'/regressions/{reg_uuid}/indicators',
            json={'indicator_uuids': [ind_uuids[0]]},
            headers=headers,
        )
        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        self.assertEqual(len(data['indicators']), 1)

    def test_remove_multiple_batch(self):
        """Remove 2 of 3 indicators in one batch."""
        reg_uuid, ind_uuids = _setup_regression_with_indicators(
            self.client, 3)
        headers = _triage_headers(self.app)
        resp = self.client.delete(
            PREFIX + f'/regressions/{reg_uuid}/indicators',
            json={'indicator_uuids': ind_uuids[:2]},
            headers=headers,
        )
        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        self.assertEqual(len(data['indicators']), 1)

    def test_remove_unknown_uuid_silently_ignored(self):
        """Unknown UUIDs in batch remove are silently ignored."""
        reg_uuid, ind_uuids = _setup_regression_with_indicators(
            self.client, 1)
        headers = _triage_headers(self.app)
        resp = self.client.delete(
            PREFIX + f'/regressions/{reg_uuid}/indicators',
            json={'indicator_uuids': ['nonexistent-uuid-xyz']},
            headers=headers,
        )
        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        self.assertEqual(len(data['indicators']), 1)

    def test_remove_no_auth_401(self):
        reg_uuid, ind_uuids = _setup_regression_with_indicators(
            self.client, 1)
        resp = self.client.delete(
            PREFIX + f'/regressions/{reg_uuid}/indicators',
            json={'indicator_uuids': [ind_uuids[0]]},
        )
        self.assertEqual(resp.status_code, 401)

    def test_remove_submit_scope_403(self):
        """Submit scope (one below triage) returns 403."""
        reg_uuid, ind_uuids = _setup_regression_with_indicators(
            self.client, 1)
        headers = make_scoped_headers(self.app, 'submit')
        resp = self.client.delete(
            PREFIX + f'/regressions/{reg_uuid}/indicators',
            json={'indicator_uuids': [ind_uuids[0]]},
            headers=headers,
        )
        self.assertEqual(resp.status_code, 403)

    def test_remove_empty_list_422(self):
        """DELETE with empty indicator_uuids list returns 422."""
        reg_uuid, _ = _setup_regression_with_indicators(
            self.client, 1)
        headers = _triage_headers(self.app)
        resp = self.client.delete(
            PREFIX + f'/regressions/{reg_uuid}/indicators',
            json={'indicator_uuids': []},
            headers=headers,
        )
        self.assertEqual(resp.status_code, 422)


class TestRegressionZPagination(unittest.TestCase):
    """Exhaustive cursor pagination tests for GET /api/v5/{ts}/regressions."""
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.app = create_app(sys.argv[1])
        cls.client = create_client(cls.app)
        cls._reg_uuids = []
        for _ in range(5):
            reg_uuid, _ = _setup_regression_with_indicators(
                cls.client, 1)
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
        reg_uuid, _ = _setup_regression_with_indicators(
            self.client, 1)
        resp = self.client.get(
            PREFIX + f'/regressions/{reg_uuid}?bogus=1')
        self.assertEqual(resp.status_code, 400)


if __name__ == '__main__':
    unittest.main(argv=[sys.argv[0]], exit=True)

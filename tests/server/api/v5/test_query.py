# Tests for the v5 query endpoint (POST /api/v5/{ts}/query).
#
# RUN: rm -rf %t.instance %t.pg.log
# RUN: %{utils}/with_postgres.sh %t.pg.log \
# RUN:     %{utils}/with_temporary_instance.py --db-version 5.0 %t.instance \
# RUN:         -- python %s %t.instance
# END.

import datetime
import random
import sys
import os
import unittest
import uuid

sys.path.insert(0, os.path.dirname(__file__))
from v5_test_helpers import create_app, create_client, set_ordinal, submit_run

TS = 'nts'
PREFIX = f'/api/v5/{TS}'


def _setup_query_data(client, app, machine_name, test_name, num_points=5):
    """Create a machine, test, and several runs with samples.

    Returns a dict with the created entities for assertions.
    """
    rev_prefix = uuid.uuid4().hex[:6]
    # Use a random base to avoid ordinal collisions across test classes.
    ordinal_base = int(uuid.uuid4().hex[:6], 16)
    run_uuids = []
    commits = []
    for i in range(num_points):
        commit_str = f'{100 + i}-{rev_prefix}'
        data = submit_run(
            client, machine_name, commit_str,
            [{'name': test_name, 'execution_time': [float(i + 1) * 1.5]}])
        run_uuids.append(data['run_uuid'])
        commits.append(commit_str)

    # Assign ordinals via API (D11: ordinals set exclusively via PATCH)
    for i, commit_str in enumerate(commits):
        set_ordinal(client, commit_str, ordinal_base + i)

    # Set sequential timestamps via direct DB (no API for submitted_at)
    db = app.instance.get_database("default")
    session = db.make_session()
    ts = db.testsuite[TS]
    for i, run_uuid in enumerate(run_uuids):
        run = ts.get_run(session, uuid=run_uuid)
        run.submitted_at = datetime.datetime(2024, 1, 1 + i, 12, 0, 0, tzinfo=datetime.timezone.utc)
    session.commit()
    session.close()

    return {
        'machine': machine_name,
        'test': test_name,
        'run_uuids': run_uuids,
        'num_points': num_points,
        'commits': commits,
    }


class TestQueryNotFound(unittest.TestCase):
    """Tests for 404 responses when entities don't exist."""
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.app = create_app(sys.argv[1])
        cls.client = create_client(cls.app)

    def test_nonexistent_machine_returns_404(self):
        resp = self.client.post(
            PREFIX + '/query',
            json={'machine': 'nonexistent-machine-xyz',
                  'test': ['some_test'], 'metric': 'execution_time'})
        self.assertEqual(resp.status_code, 404)
        data = resp.get_json()
        self.assertIn('error', data)

    def test_nonexistent_test_returns_empty(self):
        # Create a real machine so only the test is missing.
        # With multi-value test support, unknown test names are silently
        # skipped, returning an empty result set instead of 404.
        unique = uuid.uuid4().hex[:8]
        name = f'series-nf-test-{unique}'
        submit_run(self.client, name, f'1-{unique}',
                   [{'name': f'dummy-{unique}', 'execution_time': [1.0]}])

        resp = self.client.post(
            PREFIX + '/query',
            json={'machine': name,
                  'test': ['nonexistent-test-xyz'], 'metric': 'execution_time'})
        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        self.assertEqual(len(data['items']), 0)

    def test_nonexistent_field_returns_400(self):
        unique = uuid.uuid4().hex[:8]
        mname = f'series-nf-field-m-{unique}'
        tname = f'series-nf-field-t/{unique}'
        submit_run(self.client, mname, f'1-{unique}',
                   [{'name': tname, 'execution_time': [1.0]}])

        resp = self.client.post(
            PREFIX + '/query',
            json={'machine': mname,
                  'test': [tname], 'metric': 'nonexistent_field'})
        self.assertEqual(resp.status_code, 400)


class TestQueryValidQuery(unittest.TestCase):
    """Tests for valid queries that return data."""
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.app = create_app(sys.argv[1])
        cls.client = create_client(cls.app)
        unique = uuid.uuid4().hex[:8]
        cls._data = _setup_query_data(
            cls.client,
            cls.app,
            machine_name=f'series-valid-m-{unique}',
            test_name=f'series-valid-t/{unique}',
            num_points=5,
        )

    def test_returns_200(self):
        d = self._data
        resp = self.client.post(
            PREFIX + '/query',
            json={'machine': d['machine'], 'test': [d['test']], 'metric': 'execution_time'})
        self.assertEqual(resp.status_code, 200)

    def test_returns_items(self):
        d = self._data
        resp = self.client.post(
            PREFIX + '/query',
            json={'machine': d['machine'], 'test': [d['test']], 'metric': 'execution_time'})
        data = resp.get_json()
        self.assertIn('items', data)
        self.assertEqual(len(data['items']), d['num_points'])

    def test_data_point_structure(self):
        """Each data point must have all required fields."""
        d = self._data
        resp = self.client.post(
            PREFIX + '/query',
            json={'machine': d['machine'], 'test': [d['test']], 'metric': 'execution_time'})
        data = resp.get_json()
        for item in data['items']:
            self.assertIn('test', item)
            self.assertIn('machine', item)
            self.assertIn('metric', item)
            self.assertIn('value', item)
            self.assertIn('commit', item)
            self.assertIn('run_uuid', item)
            self.assertIn('submitted_at', item)
            self.assertIsInstance(item['value'], (int, float))
            self.assertIsInstance(item['commit'], str)
            self.assertIsInstance(item['run_uuid'], str)
            self.assertEqual(item['test'], d['test'])
            self.assertEqual(item['machine'], d['machine'])
            self.assertEqual(item['metric'], 'execution_time')

    def test_commit_is_a_string(self):
        """Commit field should be a plain string (not a dict)."""
        d = self._data
        resp = self.client.post(
            PREFIX + '/query',
            json={'machine': d['machine'], 'test': [d['test']], 'metric': 'execution_time'})
        data = resp.get_json()
        for item in data['items']:
            self.assertIsInstance(item['commit'], str)

    def test_run_uuids_are_valid(self):
        """All run_uuid values should be from the runs we created."""
        d = self._data
        resp = self.client.post(
            PREFIX + '/query',
            json={'machine': d['machine'], 'test': [d['test']], 'metric': 'execution_time'})
        data = resp.get_json()
        returned_uuids = {item['run_uuid'] for item in data['items']}
        expected_uuids = set(d['run_uuids'])
        self.assertEqual(returned_uuids, expected_uuids)

    def test_values_are_correct(self):
        """Values should match what we inserted."""
        d = self._data
        resp = self.client.post(
            PREFIX + '/query',
            json={'machine': d['machine'], 'test': [d['test']], 'metric': 'execution_time'})
        data = resp.get_json()
        values = sorted([item['value'] for item in data['items']])
        expected = sorted([float(i + 1) * 1.5 for i in range(d['num_points'])])
        self.assertEqual(values, expected)

    def test_cursor_envelope(self):
        """Response should have cursor with next and previous."""
        d = self._data
        resp = self.client.post(
            PREFIX + '/query',
            json={'machine': d['machine'], 'test': [d['test']], 'metric': 'execution_time'})
        data = resp.get_json()
        self.assertIn('cursor', data)
        self.assertIn('next', data['cursor'])
        self.assertIn('previous', data['cursor'])

    def test_no_auth_required_for_read(self):
        """Query endpoint should work without auth (read scope)."""
        d = self._data
        resp = self.client.post(
            PREFIX + '/query',
            json={'machine': d['machine'], 'test': [d['test']], 'metric': 'execution_time'})
        self.assertEqual(resp.status_code, 200)


class TestQueryEmptyResult(unittest.TestCase):
    """Tests for queries that match no data."""
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.app = create_app(sys.argv[1])
        cls.client = create_client(cls.app)

    def test_valid_entities_no_samples_returns_empty(self):
        """When machine/test/field exist but no samples match, return empty."""
        unique = uuid.uuid4().hex[:8]
        mname = f'series-empty-m-{unique}'
        tname = f'series-empty-t/{unique}'

        # Create machine (and a dummy test) via submit_run, then query with
        # a different test name that has no samples for this machine.
        submit_run(self.client, mname, f'1-{unique}',
                   [{'name': f'dummy-{unique}', 'execution_time': [1.0]}])

        resp = self.client.post(
            PREFIX + '/query',
            json={'machine': mname, 'test': [tname], 'metric': 'execution_time'})
        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        self.assertEqual(len(data['items']), 0)
        self.assertIsNone(data['cursor']['next'])


class TestQueryOrdering(unittest.TestCase):
    """Tests that data points are returned in order."""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.app = create_app(sys.argv[1])
        cls.client = create_client(cls.app)
        unique = uuid.uuid4().hex[:8]
        mname = f'query-order-m-{unique}'
        tname = f'query-order-t/{unique}'

        # Create orders in sequential revision order
        revisions = ['100', '200', '300', '400', '500']
        rev_prefix = uuid.uuid4().hex[:6]
        for rev in revisions:
            submit_run(
                cls.client, mname, f'{rev}-{rev_prefix}',
                [{'name': tname, 'execution_time': [float(rev)]}],
            )

        # Assign ordinals via API (D11: ordinals set exclusively via PATCH)
        ordinal_base = int(uuid.uuid4().hex[:6], 16)
        for i, rev in enumerate(revisions):
            commit_str = f'{rev}-{rev_prefix}'
            set_ordinal(cls.client, commit_str, ordinal_base + i)

        cls._data = {
            'machine': mname,
            'test': tname,
            'expected_revisions': [f'{r}-{rev_prefix}' for r in revisions],
        }

    def test_data_sorted_by_ordinal(self):
        """Data points should be sorted by ordinal value."""
        d = self._data
        resp = self.client.post(
            PREFIX + '/query',
            json={'machine': d['machine'], 'test': [d['test']], 'metric': 'execution_time'})
        data = resp.get_json()
        ordinals = [item['ordinal'] for item in data['items']]
        self.assertEqual(ordinals, sorted(ordinals))


class TestQueryRangeFilters(unittest.TestCase):
    """Tests for after_commit/before_commit and after_time/before_time filtering."""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.app = create_app(sys.argv[1])
        cls.client = create_client(cls.app)
        unique = uuid.uuid4().hex[:8]
        mname = f'query-filter-m-{unique}'
        tname = f'query-filter-t/{unique}'

        cls._commits = []
        for i in range(10):
            rev = str(100 + i * 10)  # 100, 110, ..., 190
            submit_run(
                cls.client, mname, rev,
                [{'name': tname, 'execution_time': [float(100 + i * 10)]}],
            )
            cls._commits.append(rev)

        # Assign ordinals via API (D11: ordinals set exclusively via PATCH)
        ordinal_base = int(uuid.uuid4().hex[:6], 16)
        for i, commit_str in enumerate(cls._commits):
            set_ordinal(cls.client, commit_str, ordinal_base + i)

        # Set sequential timestamps via direct DB (no API for submitted_at)
        db = cls.app.instance.get_database("default")
        session = db.make_session()
        ts = db.testsuite[TS]
        for i, commit_str in enumerate(cls._commits):
            c = ts.get_commit(session, commit=commit_str)
            runs = ts.list_runs(session, commit_id=c.id)
            for run in runs:
                run.submitted_at = datetime.datetime(2024, 1, 1 + i, 12, 0, 0, tzinfo=datetime.timezone.utc)
        session.commit()
        session.close()

        cls._data = {
            'machine': mname,
            'test': tname,
        }

    def test_after_commit_filter(self):
        """Only data points after the given commit should be returned."""
        d = self._data
        resp = self.client.post(
            PREFIX + '/query',
            json={'machine': d['machine'], 'test': [d['test']],
                  'metric': 'execution_time', 'after_commit': '150'})
        self.assertEqual(resp.status_code, 200, resp.get_json())
        data = resp.get_json()
        self.assertGreater(len(data['items']), 0)
        for item in data['items']:
            rev = int(item['commit'])
            self.assertGreater(rev, 150)

    def test_before_commit_filter(self):
        """Only data points before the given commit should be returned."""
        d = self._data
        resp = self.client.post(
            PREFIX + '/query',
            json={'machine': d['machine'], 'test': [d['test']],
                  'metric': 'execution_time', 'before_commit': '150'})
        self.assertEqual(resp.status_code, 200, resp.get_json())
        data = resp.get_json()
        self.assertGreater(len(data['items']), 0)
        for item in data['items']:
            rev = int(item['commit'])
            self.assertLess(rev, 150)

    def test_after_commit_and_before_commit_combined(self):
        """Combining after_commit and before_commit narrows the range."""
        d = self._data
        resp = self.client.post(
            PREFIX + '/query',
            json={'machine': d['machine'], 'test': [d['test']],
                  'metric': 'execution_time', 'after_commit': '120',
                  'before_commit': '170'})
        self.assertEqual(resp.status_code, 200, resp.get_json())
        data = resp.get_json()
        for item in data['items']:
            rev = int(item['commit'])
            self.assertGreater(rev, 120)
            self.assertLess(rev, 170)
        self.assertGreater(len(data['items']), 0)

    def test_after_commit_nonexistent_returns_404(self):
        """Filtering with a non-existent commit value returns 404."""
        d = self._data
        resp = self.client.post(
            PREFIX + '/query',
            json={'machine': d['machine'], 'test': [d['test']],
                  'metric': 'execution_time', 'after_commit': '999999'})
        self.assertEqual(resp.status_code, 404)

    def test_before_commit_nonexistent_returns_404(self):
        """Filtering with a non-existent commit value returns 404."""
        d = self._data
        resp = self.client.post(
            PREFIX + '/query',
            json={'machine': d['machine'], 'test': [d['test']],
                  'metric': 'execution_time', 'before_commit': '999999'})
        self.assertEqual(resp.status_code, 404)

    def test_after_time_filter(self):
        """Only data points from runs after the given time should be returned."""
        d = self._data
        resp = self.client.post(
            PREFIX + '/query',
            json={'machine': d['machine'], 'test': [d['test']],
                  'metric': 'execution_time',
                  'after_time': '2024-01-06T00:00:00'})
        self.assertEqual(resp.status_code, 200, resp.get_json())
        data = resp.get_json()
        self.assertGreater(len(data['items']), 0)
        for item in data['items']:
            self.assertGreater(item['submitted_at'], '2024-01-06T00:00:00Z')

    def test_before_time_filter(self):
        """Only data points from runs before the given time should be returned."""
        d = self._data
        resp = self.client.post(
            PREFIX + '/query',
            json={'machine': d['machine'], 'test': [d['test']],
                  'metric': 'execution_time',
                  'before_time': '2024-01-04T00:00:00'})
        self.assertEqual(resp.status_code, 200, resp.get_json())
        data = resp.get_json()
        self.assertGreater(len(data['items']), 0)
        for item in data['items']:
            self.assertLess(item['submitted_at'], '2024-01-04T00:00:00Z')

    def test_after_time_and_before_time_combined(self):
        """Combining time range filters narrows the results."""
        d = self._data
        resp = self.client.post(
            PREFIX + '/query',
            json={'machine': d['machine'], 'test': [d['test']],
                  'metric': 'execution_time',
                  'after_time': '2024-01-03T00:00:00',
                  'before_time': '2024-01-07T00:00:00'})
        self.assertEqual(resp.status_code, 200, resp.get_json())
        data = resp.get_json()
        self.assertGreater(len(data['items']), 0)
        for item in data['items']:
            self.assertGreater(item['submitted_at'], '2024-01-03T00:00:00Z')
            self.assertLess(item['submitted_at'], '2024-01-07T00:00:00Z')

    def test_commit_and_time_filters_compose(self):
        """Both commit and time filters can be used together."""
        d = self._data
        resp = self.client.post(
            PREFIX + '/query',
            json={'machine': d['machine'], 'test': [d['test']],
                  'metric': 'execution_time',
                  'after_commit': '120',
                  'before_time': '2024-01-07T00:00:00'})
        self.assertEqual(resp.status_code, 200, resp.get_json())
        data = resp.get_json()
        for item in data['items']:
            rev = int(item['commit'])
            self.assertGreater(rev, 120)
            self.assertLess(item['submitted_at'], '2024-01-07T00:00:00Z')

    def test_after_time_future_returns_empty(self):
        """Filtering with after_time far in the future returns 0 items."""
        d = self._data
        resp = self.client.post(
            PREFIX + '/query',
            json={'machine': d['machine'], 'test': [d['test']],
                  'metric': 'execution_time',
                  'after_time': '2027-02-23T15:01:11'})
        self.assertEqual(resp.status_code, 200, resp.get_json())
        data = resp.get_json()
        self.assertEqual(len(data['items']), 0)

    def test_before_time_past_returns_empty(self):
        """Filtering with before_time far in the past returns 0 items."""
        d = self._data
        resp = self.client.post(
            PREFIX + '/query',
            json={'machine': d['machine'], 'test': [d['test']],
                  'metric': 'execution_time',
                  'before_time': '2020-01-01T00:00:00'})
        self.assertEqual(resp.status_code, 200, resp.get_json())
        data = resp.get_json()
        self.assertEqual(len(data['items']), 0)


class TestQueryLimit(unittest.TestCase):
    """Tests for the limit parameter."""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.app = create_app(sys.argv[1])
        cls.client = create_client(cls.app)
        unique = uuid.uuid4().hex[:8]
        cls._data = _setup_query_data(
            cls.client,
            cls.app,
            machine_name=f'series-limit-m-{unique}',
            test_name=f'series-limit-t/{unique}',
            num_points=10,
        )

    def test_limit_reduces_results(self):
        d = self._data
        resp = self.client.post(
            PREFIX + '/query',
            json={'machine': d['machine'], 'test': [d['test']],
                  'metric': 'execution_time', 'limit': 3})
        data = resp.get_json()
        self.assertEqual(len(data['items']), 3)

    def test_limit_with_next_cursor(self):
        """When limit truncates results, next cursor should be set."""
        d = self._data
        resp = self.client.post(
            PREFIX + '/query',
            json={'machine': d['machine'], 'test': [d['test']],
                  'metric': 'execution_time', 'limit': 3})
        data = resp.get_json()
        self.assertIsNotNone(data['cursor']['next'])

    def test_limit_larger_than_data(self):
        """When limit is larger than data, all data returned, no next cursor."""
        d = self._data
        resp = self.client.post(
            PREFIX + '/query',
            json={'machine': d['machine'], 'test': [d['test']],
                  'metric': 'execution_time', 'limit': 500})
        data = resp.get_json()
        self.assertEqual(len(data['items']), d['num_points'])
        self.assertIsNone(data['cursor']['next'])


class TestQueryPagination(unittest.TestCase):
    """Tests for cursor-based pagination."""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.app = create_app(sys.argv[1])
        cls.client = create_client(cls.app)
        unique = uuid.uuid4().hex[:8]
        cls._data = _setup_query_data(
            cls.client,
            cls.app,
            machine_name=f'series-page-m-{unique}',
            test_name=f'series-page-t/{unique}',
            num_points=7,
        )

    def test_pagination_collects_all_items(self):
        """Paginating through all pages should return all data points."""
        d = self._data
        all_items = []
        params = {'machine': d['machine'], 'test': [d['test']],
                  'metric': 'execution_time', 'limit': 3}

        # First page
        resp = self.client.post(PREFIX + '/query', json=params)
        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        all_items.extend(data['items'])
        cursor = data['cursor']['next']

        # Keep fetching until no next cursor
        pages = 1
        while cursor:
            resp = self.client.post(
                PREFIX + '/query', json={**params, 'cursor': cursor})
            self.assertEqual(resp.status_code, 200)
            data = resp.get_json()
            all_items.extend(data['items'])
            cursor = data['cursor']['next']
            pages += 1
            if pages > 10:
                self.fail("Too many pages; infinite loop detected")

        self.assertEqual(len(all_items), d['num_points'])

    def test_no_duplicate_items_across_pages(self):
        """Items should not appear on multiple pages."""
        d = self._data
        all_uuids = []
        params = {'machine': d['machine'], 'test': [d['test']],
                  'metric': 'execution_time', 'limit': 2}

        resp = self.client.post(PREFIX + '/query', json=params)
        data = resp.get_json()
        all_uuids.extend(item['run_uuid'] for item in data['items'])
        cursor = data['cursor']['next']

        pages = 1
        while cursor:
            resp = self.client.post(
                PREFIX + '/query', json={**params, 'cursor': cursor})
            data = resp.get_json()
            all_uuids.extend(item['run_uuid'] for item in data['items'])
            cursor = data['cursor']['next']
            pages += 1
            if pages > 10:
                break

        # Check no duplicates
        self.assertEqual(len(all_uuids), len(set(all_uuids)))

    def test_invalid_cursor_returns_400(self):
        """An invalid cursor string should return 400."""
        d = self._data
        resp = self.client.post(
            PREFIX + '/query',
            json={'machine': d['machine'], 'test': [d['test']],
                  'metric': 'execution_time',
                  'cursor': 'not-a-valid-cursor!!!'})
        self.assertEqual(resp.status_code, 400)


def _setup_multi_test_data(client, app, machine_name, test_names, num_orders=5):
    """Create a machine, multiple tests, and samples for each."""
    base = random.randint(100000, 999000)
    ordinal_base = int(uuid.uuid4().hex[:6], 16)
    commits = []
    for i in range(num_orders):
        tests = [
            {'name': tn, 'execution_time': [float((i + 1) * 10 + j)]}
            for j, tn in enumerate(test_names)
        ]
        commit_str = str(base + i)
        submit_run(
            client, machine_name, commit_str,
            tests,
        )
        commits.append(commit_str)

    # Assign ordinals via API (D11: ordinals set exclusively via PATCH)
    for i, commit_str in enumerate(commits):
        set_ordinal(client, commit_str, ordinal_base + i)

    # Set sequential timestamps via direct DB (no API for submitted_at)
    db = app.instance.get_database("default")
    session = db.make_session()
    ts = db.testsuite[TS]
    for i, commit_str in enumerate(commits):
        c = ts.get_commit(session, commit=commit_str)
        runs = ts.list_runs(session, commit_id=c.id)
        for run in runs:
            run.submitted_at = datetime.datetime(2024, 6, 1 + i, 12, 0, 0, tzinfo=datetime.timezone.utc)
    session.commit()
    session.close()

    return {
        'machine': machine_name,
        'test_names': test_names,
        'num_orders': num_orders,
        'commits': commits,
    }


class TestQueryOptionalParams(unittest.TestCase):
    """Verify each filter parameter is independently optional."""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.app = create_app(sys.argv[1])
        cls.client = create_client(cls.app)
        unique = uuid.uuid4().hex[:8]
        cls._data = _setup_multi_test_data(
            cls.client,
            cls.app,
            machine_name=f'query-opt-m-{unique}',
            test_names=[f'query-opt-t1/{unique}',
                        f'query-opt-t2/{unique}',
                        f'query-opt-t3/{unique}'],
            num_orders=3,
        )

    def test_omitting_test_returns_all_tests(self):
        d = self._data
        resp = self.client.post(
            PREFIX + '/query',
            json={'machine': d['machine'], 'metric': 'execution_time'})
        self.assertEqual(resp.status_code, 200, resp.get_json())
        data = resp.get_json()
        returned_tests = {item['test'] for item in data['items']}
        self.assertEqual(returned_tests, set(d['test_names']))

    def test_omitting_machine_returns_data(self):
        d = self._data
        resp = self.client.post(
            PREFIX + '/query',
            json={'test': [d['test_names'][0]], 'metric': 'execution_time'})
        self.assertEqual(resp.status_code, 200, resp.get_json())
        data = resp.get_json()
        self.assertGreater(len(data['items']), 0)

    def test_omitting_field_returns_422(self):
        d = self._data
        resp = self.client.post(
            PREFIX + '/query',
            json={'machine': d['machine'], 'test': [d['test_names'][0]]})
        self.assertEqual(resp.status_code, 422)

    def test_omitting_all_params_returns_422(self):
        resp = self.client.post(PREFIX + '/query', json={})
        self.assertEqual(resp.status_code, 422)

    def test_nonexistent_machine_returns_404(self):
        resp = self.client.post(
            PREFIX + '/query',
            json={'machine': 'nonexistent-machine-xyz',
                  'metric': 'execution_time'})
        self.assertEqual(resp.status_code, 404)

    def test_nonexistent_test_returns_empty(self):
        resp = self.client.post(
            PREFIX + '/query',
            json={'test': ['nonexistent-test-xyz'],
                  'metric': 'execution_time'})
        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        self.assertEqual(len(data['items']), 0)

    def test_nonexistent_field_returns_400(self):
        resp = self.client.post(
            PREFIX + '/query',
            json={'metric': 'nonexistent_field'})
        self.assertEqual(resp.status_code, 400)


class TestQueryResponseShape(unittest.TestCase):
    """Response shape is always the same regardless of filters."""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.app = create_app(sys.argv[1])
        cls.client = create_client(cls.app)
        unique = uuid.uuid4().hex[:8]
        cls._data = _setup_multi_test_data(
            cls.client,
            cls.app,
            machine_name=f'query-shape-m-{unique}',
            test_names=[f'query-shape-t/{unique}'],
            num_orders=3,
        )

    def _assert_item_shape(self, item):
        """Assert a single item has all required fields."""
        for key in ('test', 'machine', 'metric',
                    'value', 'commit', 'run_uuid', 'submitted_at'):
            self.assertIn(key, item, f"Missing key: {key}")

    def test_items_with_all_filters(self):
        d = self._data
        resp = self.client.post(
            PREFIX + '/query',
            json={'machine': d['machine'], 'test': [d['test_names'][0]],
                  'metric': 'execution_time'})
        data = resp.get_json()
        for item in data['items']:
            self._assert_item_shape(item)

    def test_items_with_no_filters_returns_422(self):
        resp = self.client.post(PREFIX + '/query', json={})
        self.assertEqual(resp.status_code, 422)

    def test_items_with_only_machine_returns_422(self):
        d = self._data
        resp = self.client.post(
            PREFIX + '/query',
            json={'machine': d['machine']})
        self.assertEqual(resp.status_code, 422)


class TestQueryMultiTestPagination(unittest.TestCase):
    """Pagination across multiple tests."""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.app = create_app(sys.argv[1])
        cls.client = create_client(cls.app)
        unique = uuid.uuid4().hex[:8]
        cls._data = _setup_multi_test_data(
            cls.client,
            cls.app,
            machine_name=f'query-mtp-m-{unique}',
            test_names=[f'query-mtp-t1/{unique}',
                        f'query-mtp-t2/{unique}',
                        f'query-mtp-t3/{unique}'],
            num_orders=5,
        )

    def test_pagination_collects_all_items(self):
        """Paginating should return all 3 tests * 5 orders = 15 items."""
        d = self._data
        all_items = []
        params = {'machine': d['machine'],
                  'metric': 'execution_time', 'limit': 4}

        resp = self.client.post(PREFIX + '/query', json=params)
        self.assertEqual(resp.status_code, 200, resp.get_json())
        data = resp.get_json()
        all_items.extend(data['items'])
        cursor = data['cursor']['next']

        pages = 1
        while cursor:
            resp = self.client.post(
                PREFIX + '/query', json={**params, 'cursor': cursor})
            self.assertEqual(resp.status_code, 200, resp.get_json())
            data = resp.get_json()
            all_items.extend(data['items'])
            cursor = data['cursor']['next']
            pages += 1
            if pages > 20:
                self.fail("Too many pages; infinite loop detected")

        expected = len(d['test_names']) * d['num_orders']
        self.assertEqual(len(all_items), expected)

    def test_no_duplicates_across_pages(self):
        d = self._data
        all_keys = []
        params = {'machine': d['machine'],
                  'metric': 'execution_time', 'limit': 4}

        resp = self.client.post(PREFIX + '/query', json=params)
        data = resp.get_json()
        all_keys.extend(
            (item['test'], item['commit'])
            for item in data['items'])
        cursor = data['cursor']['next']

        pages = 1
        while cursor:
            resp = self.client.post(
                PREFIX + '/query', json={**params, 'cursor': cursor})
            data = resp.get_json()
            all_keys.extend(
                (item['test'], item['commit'])
                for item in data['items'])
            cursor = data['cursor']['next']
            pages += 1
            if pages > 20:
                break

        self.assertEqual(len(all_keys), len(set(all_keys)))


class TestQuerySort(unittest.TestCase):
    """Tests for the sort parameter."""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.app = create_app(sys.argv[1])
        cls.client = create_client(cls.app)
        unique = uuid.uuid4().hex[:8]
        cls._data = _setup_multi_test_data(
            cls.client,
            cls.app,
            machine_name=f'query-sort-m-{unique}',
            test_names=[f'query-sort-a/{unique}',
                        f'query-sort-b/{unique}',
                        f'query-sort-c/{unique}'],
            num_orders=3,
        )

    def test_sort_by_test_commit(self):
        """sort=test,commit groups results by test name."""
        d = self._data
        resp = self.client.post(
            PREFIX + '/query',
            json={'machine': d['machine'],
                  'metric': 'execution_time', 'sort': 'test,commit'})
        data = resp.get_json()
        test_names = [item['test'] for item in data['items']]
        self.assertEqual(test_names, sorted(test_names))

    def test_sort_by_commit_test(self):
        """sort=commit,test is the default ordering."""
        d = self._data
        resp = self.client.post(
            PREFIX + '/query',
            json={'machine': d['machine'],
                  'metric': 'execution_time', 'sort': 'commit,test'})
        data = resp.get_json()
        # Items should be grouped by commit
        self.assertGreater(len(data['items']), 0)

    def test_sort_descending(self):
        """-commit,test returns newest commits first."""
        d = self._data
        resp = self.client.post(
            PREFIX + '/query',
            json={'machine': d['machine'], 'test': [d['test_names'][0]],
                  'metric': 'execution_time', 'sort': '-commit'})
        data = resp.get_json()
        commits = [
            item['commit']
            for item in data['items']
        ]
        self.assertEqual(commits, sorted(commits, reverse=True))

    def test_sort_invalid_field_returns_400(self):
        resp = self.client.post(
            PREFIX + '/query',
            json={'metric': 'execution_time', 'sort': 'invalid_field'})
        self.assertEqual(resp.status_code, 400)

    def test_sort_with_pagination(self):
        """Sort order is preserved across cursor pages."""
        d = self._data
        all_test_names = []
        params = {'machine': d['machine'],
                  'metric': 'execution_time', 'sort': 'test,commit',
                  'limit': 4}

        resp = self.client.post(PREFIX + '/query', json=params)
        data = resp.get_json()
        all_test_names.extend(item['test'] for item in data['items'])
        cursor = data['cursor']['next']

        pages = 1
        while cursor:
            resp = self.client.post(
                PREFIX + '/query', json={**params, 'cursor': cursor})
            data = resp.get_json()
            all_test_names.extend(item['test'] for item in data['items'])
            cursor = data['cursor']['next']
            pages += 1
            if pages > 20:
                break

        self.assertEqual(all_test_names, sorted(all_test_names))


class TestQueryCursorMixedAscDesc(unittest.TestCase):
    """Test cursor pagination with mixed ascending/descending sort."""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.app = create_app(sys.argv[1])
        cls.client = create_client(cls.app)
        unique = uuid.uuid4().hex[:8]
        cls._data = _setup_multi_test_data(
            cls.client,
            cls.app,
            machine_name=f'query-mixed-m-{unique}',
            test_names=[f'query-mixed-a/{unique}',
                        f'query-mixed-b/{unique}'],
            num_orders=5,
        )

    def test_desc_commit_pagination_collects_all(self):
        """Paginating with -commit,test collects all items."""
        d = self._data
        all_items = []
        params = {'machine': d['machine'],
                  'metric': 'execution_time', 'sort': '-commit,test',
                  'limit': 3}
        resp = self.client.post(PREFIX + '/query', json=params)
        self.assertEqual(resp.status_code, 200, resp.get_json())
        data = resp.get_json()
        all_items.extend(data['items'])
        cursor = data['cursor']['next']
        pages = 1
        while cursor:
            resp = self.client.post(
                PREFIX + '/query', json={**params, 'cursor': cursor})
            self.assertEqual(resp.status_code, 200, resp.get_json())
            data = resp.get_json()
            all_items.extend(data['items'])
            cursor = data['cursor']['next']
            pages += 1
            if pages > 20:
                self.fail("Too many pages")
        expected = len(d['test_names']) * d['num_orders']
        self.assertEqual(len(all_items), expected)

    def test_desc_commit_pagination_no_duplicates(self):
        """No duplicates across pages with -commit,test."""
        d = self._data
        all_keys = []
        params = {'machine': d['machine'],
                  'metric': 'execution_time', 'sort': '-commit,test',
                  'limit': 3}
        resp = self.client.post(PREFIX + '/query', json=params)
        data = resp.get_json()
        all_keys.extend(
            (item['test'], item['commit'])
            for item in data['items'])
        cursor = data['cursor']['next']
        pages = 1
        while cursor:
            resp = self.client.post(
                PREFIX + '/query', json={**params, 'cursor': cursor})
            data = resp.get_json()
            all_keys.extend(
                (item['test'], item['commit'])
                for item in data['items'])
            cursor = data['cursor']['next']
            pages += 1
            if pages > 20:
                break
        self.assertEqual(len(all_keys), len(set(all_keys)))

    def test_desc_commit_is_actually_descending(self):
        """Results with -commit are in descending order."""
        d = self._data
        resp = self.client.post(
            PREFIX + '/query',
            json={'machine': d['machine'], 'test': [d['test_names'][0]],
                  'metric': 'execution_time', 'sort': '-commit'})
        data = resp.get_json()
        commits = [
            int(item['commit'])
            for item in data['items']
        ]
        self.assertEqual(commits, sorted(commits, reverse=True))


class TestQueryMalformedTimestamp(unittest.TestCase):
    """Test error handling for malformed timestamp filters."""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.app = create_app(sys.argv[1])
        cls.client = create_client(cls.app)

    def test_malformed_after_time_returns_400(self):
        resp = self.client.post(
            PREFIX + '/query',
            json={'metric': 'execution_time', 'after_time': 'not-a-date'})
        self.assertEqual(resp.status_code, 400)
        data = resp.get_json()
        self.assertIn('error', data)

    def test_malformed_before_time_returns_400(self):
        resp = self.client.post(
            PREFIX + '/query',
            json={'metric': 'execution_time', 'before_time': 'yesterday'})
        self.assertEqual(resp.status_code, 400)
        data = resp.get_json()
        self.assertIn('error', data)


class TestQueryMetricRequired(unittest.TestCase):
    """Test that omitting the metric parameter returns 422."""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.app = create_app(sys.argv[1])
        cls.client = create_client(cls.app)
        unique = uuid.uuid4().hex[:8]
        mname = f'query-mreq-m-{unique}'
        tname = f'query-mreq-t/{unique}'
        rev_prefix = uuid.uuid4().hex[:6]
        commits = []
        for i in range(3):
            commit_str = f'{2000 + i}-{rev_prefix}'
            submit_run(
                cls.client, mname, commit_str,
                [{'name': tname, 'execution_time': [float(i + 1)]}],
            )
            commits.append(commit_str)

        # Assign ordinals via API (D11: ordinals set exclusively via PATCH)
        ordinal_base = int(uuid.uuid4().hex[:6], 16)
        for i, cs in enumerate(commits):
            set_ordinal(cls.client, cs, ordinal_base + i)
        cls._data = {'machine': mname, 'test': tname}

    def test_omitting_metric_returns_422(self):
        """Omitting the metric parameter should return 422."""
        d = self._data
        resp = self.client.post(
            PREFIX + '/query',
            json={'machine': d['machine'], 'test': [d['test']],
                  'limit': 2})
        self.assertEqual(resp.status_code, 422)

    def test_with_metric_returns_200(self):
        """Providing metric should return 200 with data."""
        d = self._data
        resp = self.client.post(
            PREFIX + '/query',
            json={'machine': d['machine'], 'test': [d['test']],
                  'metric': 'execution_time', 'limit': 2})
        self.assertEqual(resp.status_code, 200, resp.get_json())
        data = resp.get_json()
        self.assertGreater(len(data['items']), 0)


class TestQueryOrderRangeBoundaries(unittest.TestCase):
    """Test boundary conditions for commit range filters."""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.app = create_app(sys.argv[1])
        cls.client = create_client(cls.app)
        unique = uuid.uuid4().hex[:8]
        mname = f'query-orb-m-{unique}'
        tname = f'query-orb-t/{unique}'
        cls._commits = []
        for i in range(5):
            rev = str(3000 + i * 10)  # 3000, 3010, 3020, 3030, 3040
            submit_run(
                cls.client, mname, rev,
                [{'name': tname, 'execution_time': [float(3000 + i * 10)]}],
            )
            cls._commits.append(rev)

        # Assign ordinals via API (D11: ordinals set exclusively via PATCH)
        ordinal_base = int(uuid.uuid4().hex[:6], 16)
        for i, commit_str in enumerate(cls._commits):
            set_ordinal(cls.client, commit_str, ordinal_base + i)

        # Set sequential timestamps via direct DB (no API for submitted_at)
        db = cls.app.instance.get_database("default")
        session = db.make_session()
        ts = db.testsuite[TS]
        for i, commit_str in enumerate(cls._commits):
            c = ts.get_commit(session, commit=commit_str)
            runs = ts.list_runs(session, commit_id=c.id)
            for run in runs:
                run.submitted_at = datetime.datetime(2024, 7, 1 + i, 12, 0, 0, tzinfo=datetime.timezone.utc)
        session.commit()
        session.close()

        cls._data = {'machine': mname, 'test': tname}

    def test_same_after_and_before_commit_returns_empty(self):
        d = self._data
        resp = self.client.post(
            PREFIX + '/query',
            json={'machine': d['machine'], 'test': [d['test']],
                  'metric': 'execution_time', 'after_commit': '3020',
                  'before_commit': '3020'})
        self.assertEqual(resp.status_code, 200, resp.get_json())
        data = resp.get_json()
        self.assertEqual(len(data['items']), 0)

    def test_inverted_commit_range_returns_empty(self):
        d = self._data
        resp = self.client.post(
            PREFIX + '/query',
            json={'machine': d['machine'], 'test': [d['test']],
                  'metric': 'execution_time', 'after_commit': '3040',
                  'before_commit': '3000'})
        self.assertEqual(resp.status_code, 200, resp.get_json())
        data = resp.get_json()
        self.assertEqual(len(data['items']), 0)

    def test_exact_commit_filter(self):
        """The commit param returns data at exactly that commit."""
        d = self._data
        resp = self.client.post(
            PREFIX + '/query',
            json={'machine': d['machine'], 'test': [d['test']],
                  'metric': 'execution_time', 'commit': '3020'})
        self.assertEqual(resp.status_code, 200, resp.get_json())
        data = resp.get_json()
        self.assertEqual(len(data['items']), 1)
        self.assertEqual(data['items'][0]['commit'], '3020')

    def test_exact_commit_nonexistent_returns_404(self):
        d = self._data
        resp = self.client.post(
            PREFIX + '/query',
            json={'machine': d['machine'], 'test': [d['test']],
                  'metric': 'execution_time', 'commit': '999999'})
        self.assertEqual(resp.status_code, 404)

    def test_commit_with_after_commit_returns_400(self):
        d = self._data
        resp = self.client.post(
            PREFIX + '/query',
            json={'machine': d['machine'], 'test': [d['test']],
                  'metric': 'execution_time', 'commit': '3020',
                  'after_commit': '3000'})
        self.assertEqual(resp.status_code, 400)

    def test_commit_with_before_commit_returns_400(self):
        d = self._data
        resp = self.client.post(
            PREFIX + '/query',
            json={'machine': d['machine'], 'test': [d['test']],
                  'metric': 'execution_time', 'commit': '3020',
                  'before_commit': '3040'})
        self.assertEqual(resp.status_code, 400)

    def test_exact_commit_with_time_filter(self):
        """The commit param can be combined with time filters."""
        d = self._data
        resp = self.client.post(
            PREFIX + '/query',
            json={'machine': d['machine'], 'test': [d['test']],
                  'metric': 'execution_time', 'commit': '3020',
                  'after_time': '2024-07-01T00:00:00',
                  'before_time': '2024-07-10T00:00:00'})
        self.assertEqual(resp.status_code, 200, resp.get_json())
        data = resp.get_json()
        self.assertEqual(len(data['items']), 1)

    def test_exact_commit_no_samples_for_machine(self):
        """Commit exists but has no data for the given machine -- 200 empty."""
        d = self._data
        resp = self.client.post(
            PREFIX + '/query',
            json={'machine': 'nonexistent-machine-' + d['machine'],
                  'test': [d['test']], 'metric': 'execution_time',
                  'commit': '3020'})
        # Machine doesn't exist -> 404 from _resolve_machine
        self.assertEqual(resp.status_code, 404)


class TestQueryLimitBoundaries(unittest.TestCase):
    """Test boundary conditions for the limit parameter."""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.app = create_app(sys.argv[1])
        cls.client = create_client(cls.app)
        unique = uuid.uuid4().hex[:8]
        cls._data = _setup_query_data(
            cls.client,
            cls.app,
            machine_name=f'query-limb-m-{unique}',
            test_name=f'query-limb-t/{unique}',
            num_points=5,
        )

    def test_limit_one_returns_one_item(self):
        d = self._data
        resp = self.client.post(
            PREFIX + '/query',
            json={'machine': d['machine'], 'test': [d['test']],
                  'metric': 'execution_time', 'limit': 1})
        data = resp.get_json()
        self.assertEqual(len(data['items']), 1)
        self.assertIsNotNone(data['cursor']['next'])

    def test_limit_exceeding_max_is_clamped(self):
        d = self._data
        resp = self.client.post(
            PREFIX + '/query',
            json={'machine': d['machine'], 'test': [d['test']],
                  'metric': 'execution_time', 'limit': 99999})
        self.assertEqual(resp.status_code, 200)
        # Should not error; returns all 5 items (clamped limit > data size)
        data = resp.get_json()
        self.assertEqual(len(data['items']), d['num_points'])

    def test_limit_non_integer_uses_default(self):
        d = self._data
        resp = self.client.post(
            PREFIX + '/query',
            json={'machine': d['machine'], 'test': [d['test']],
                  'metric': 'execution_time', 'limit': 'abc'})
        # Marshmallow validates limit as Integer; non-integer values -> 422
        self.assertEqual(resp.status_code, 422)

    def test_limit_zero_is_clamped_to_one(self):
        d = self._data
        resp = self.client.post(
            PREFIX + '/query',
            json={'machine': d['machine'], 'test': [d['test']],
                  'metric': 'execution_time', 'limit': 0})
        data = resp.get_json()
        self.assertEqual(len(data['items']), 1)


class TestQueryCursorEdgeCases(unittest.TestCase):
    """Test cursor edge cases."""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.app = create_app(sys.argv[1])
        cls.client = create_client(cls.app)
        unique = uuid.uuid4().hex[:8]
        cls._data = _setup_query_data(
            cls.client,
            cls.app,
            machine_name=f'query-cec-m-{unique}',
            test_name=f'query-cec-t/{unique}',
            num_points=3,
        )

    def test_cursor_wrong_field_count_returns_400(self):
        """Cursor with wrong number of fields should be rejected."""
        import base64
        import json
        # Default sort is commit,test -> 2 fields. Encode 3 fields.
        bad_cursor = base64.urlsafe_b64encode(
            json.dumps([1, "x", "extra"]).encode()).decode()
        d = self._data
        resp = self.client.post(
            PREFIX + '/query',
            json={'machine': d['machine'], 'test': [d['test']],
                  'metric': 'execution_time', 'cursor': bad_cursor})
        self.assertEqual(resp.status_code, 400)

    def test_cursor_from_different_sort_order_is_rejected(self):
        """Cursor from sort=commit,test used with sort=test,commit should fail
        gracefully since the cursor values don't match the sort columns."""
        d = self._data
        # Get cursor from sort=commit,test (default)
        resp = self.client.post(
            PREFIX + '/query',
            json={'machine': d['machine'], 'test': [d['test']],
                  'metric': 'execution_time', 'limit': 1})
        cursor = resp.get_json()['cursor']['next']
        # Use with sort=test,commit -- mismatched cursor
        resp2 = self.client.post(
            PREFIX + '/query',
            json={'machine': d['machine'], 'test': [d['test']],
                  'metric': 'execution_time', 'sort': 'test,commit',
                  'cursor': cursor})
        self.assertEqual(resp2.status_code, 400)


class TestQuerySortValidation(unittest.TestCase):
    """Test sort parameter validation edge cases."""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.app = create_app(sys.argv[1])
        cls.client = create_client(cls.app)

    def test_sort_duplicate_field_is_deduplicated(self):
        resp = self.client.post(
            PREFIX + '/query',
            json={'metric': 'execution_time', 'sort': 'commit,commit,test'})
        self.assertEqual(resp.status_code, 200)

    def test_sort_empty_string_uses_default(self):
        resp = self.client.post(
            PREFIX + '/query',
            json={'metric': 'execution_time', 'sort': ''})
        # Empty sort string should use default (commit,test)
        self.assertEqual(resp.status_code, 200)

    def test_sort_dash_invalid_field_returns_400(self):
        resp = self.client.post(
            PREFIX + '/query',
            json={'metric': 'execution_time', 'sort': '-bogus'})
        self.assertEqual(resp.status_code, 400)


class TestQueryErrorResponseFormat(unittest.TestCase):
    """Test that all error responses use the standard JSON format."""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.app = create_app(sys.argv[1])
        cls.client = create_client(cls.app)

    def _assert_error_format(self, resp):
        """Assert the response body has the standard error format."""
        data = resp.get_json()
        self.assertIsNotNone(data, "Response body should be JSON")
        self.assertIn('error', data)
        self.assertIn('code', data['error'])
        self.assertIn('message', data['error'])

    def test_404_nonexistent_machine_has_error_format(self):
        resp = self.client.post(
            PREFIX + '/query',
            json={'machine': 'nonexistent-xyz', 'metric': 'execution_time'})
        self.assertEqual(resp.status_code, 404)
        self._assert_error_format(resp)

    def test_nonexistent_test_returns_empty(self):
        """Unknown test names are silently skipped, returning empty results."""
        resp = self.client.post(
            PREFIX + '/query',
            json={'test': ['nonexistent-xyz'], 'metric': 'execution_time'})
        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        self.assertEqual(len(data['items']), 0)

    def test_400_nonexistent_field_has_error_format(self):
        resp = self.client.post(
            PREFIX + '/query',
            json={'metric': 'nonexistent_xyz'})
        self.assertEqual(resp.status_code, 400)
        self._assert_error_format(resp)

    def test_400_invalid_sort_has_error_format(self):
        resp = self.client.post(
            PREFIX + '/query',
            json={'metric': 'execution_time', 'sort': 'invalid'})
        self.assertEqual(resp.status_code, 400)
        self._assert_error_format(resp)

    def test_400_invalid_cursor_has_error_format(self):
        resp = self.client.post(
            PREFIX + '/query',
            json={'metric': 'execution_time',
                  'cursor': '!!!invalid!!!'})
        self.assertEqual(resp.status_code, 400)
        self._assert_error_format(resp)

    def test_400_malformed_time_has_error_format(self):
        resp = self.client.post(
            PREFIX + '/query',
            json={'metric': 'execution_time', 'after_time': 'not-a-date'})
        self.assertEqual(resp.status_code, 400)
        self._assert_error_format(resp)


class TestQueryNoInternalFieldsLeak(unittest.TestCase):
    """Test that no internal fields (starting with _) leak in response."""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.app = create_app(sys.argv[1])
        cls.client = create_client(cls.app)
        unique = uuid.uuid4().hex[:8]
        cls._data = _setup_query_data(
            cls.client,
            cls.app,
            machine_name=f'query-noleak-m-{unique}',
            test_name=f'query-noleak-t/{unique}',
            num_points=3,
        )

    def test_no_underscore_prefixed_fields(self):
        d = self._data
        resp = self.client.post(
            PREFIX + '/query',
            json={'machine': d['machine'], 'test': [d['test']],
                  'metric': 'execution_time'})
        data = resp.get_json()
        for item in data['items']:
            internal_keys = [k for k in item.keys() if k.startswith('_')]
            self.assertEqual(internal_keys, [],
                             f"Internal fields leaked: {internal_keys}")


class TestQueryUnknownParameters(unittest.TestCase):
    """Test that unknown query parameters are rejected with 422."""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.app = create_app(sys.argv[1])
        cls.client = create_client(cls.app)
        unique = uuid.uuid4().hex[:8]
        cls._data = _setup_query_data(
            cls.client,
            cls.app,
            machine_name=f'query-unknown-m-{unique}',
            test_name=f'query-unknown-t/{unique}',
            num_points=3,
        )

    def test_single_unknown_param_returns_422(self):
        """A single unknown parameter should be rejected."""
        resp = self.client.post(
            PREFIX + '/query',
            json={'metric': 'execution_time', 'bogus': 'value'})
        self.assertEqual(resp.status_code, 422)
        data = resp.get_json()
        self.assertIn('error', data)
        self.assertIn('bogus', data['error']['message'])

    def test_multiple_unknown_params_returns_422(self):
        """Multiple unknown parameters should all be mentioned."""
        resp = self.client.post(
            PREFIX + '/query',
            json={'metric': 'execution_time',
                  'metric_name': 'execution_time',
                  'after_timestamp': '2027-02-23T15:01:11'})
        self.assertEqual(resp.status_code, 422)
        data = resp.get_json()
        self.assertIn('metric_name', data['error']['message'])
        self.assertIn('after_timestamp', data['error']['message'])

    def test_unknown_mixed_with_valid_returns_422(self):
        """Unknown params mixed with valid ones should still be rejected."""
        d = self._data
        resp = self.client.post(
            PREFIX + '/query',
            json={'machine': d['machine'],
                  'metric': 'execution_time', 'bad_param': '1'})
        self.assertEqual(resp.status_code, 422)
        data = resp.get_json()
        self.assertIn('bad_param', data['error']['message'])

    def test_error_message_mentions_unknown_field(self):
        """The error message should mention the unknown field name."""
        resp = self.client.post(
            PREFIX + '/query',
            json={'metric': 'execution_time', 'bogus': 1})
        data = resp.get_json()
        msg = data['error']['message']
        self.assertIn('bogus', msg)

    def test_error_response_has_standard_format(self):
        """Unknown param error should use the standard error format."""
        resp = self.client.post(
            PREFIX + '/query',
            json={'metric': 'execution_time', 'unknown': 1})
        self.assertEqual(resp.status_code, 422)
        data = resp.get_json()
        self.assertIn('error', data)
        self.assertIn('code', data['error'])
        self.assertIn('message', data['error'])
        self.assertEqual(data['error']['code'], 'validation_error')

    def test_valid_params_still_work(self):
        """All valid parameters should still be accepted."""
        d = self._data
        resp = self.client.post(
            PREFIX + '/query',
            json={'machine': d['machine'], 'test': [d['test']],
                  'metric': 'execution_time', 'sort': 'commit',
                  'limit': 10})
        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        self.assertIn('items', data)
        self.assertEqual(len(data['items']), d['num_points'])

    def test_no_params_returns_422(self):
        """Query with no parameters should return 422 (metric is required)."""
        resp = self.client.post(PREFIX + '/query', json={})
        self.assertEqual(resp.status_code, 422)


class TestQueryMultiValueTest(unittest.TestCase):
    """Tests for multi-value test= parameter (disjunction)."""
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.app = create_app(sys.argv[1])
        cls.client = create_client(cls.app)
        cls._prefix = uuid.uuid4().hex[:8]
        rev_prefix = uuid.uuid4().hex[:6]

        cls.machine_name = f'mv-m-{cls._prefix}'
        cls.test_a = f'mv-test-alpha-{cls._prefix}'
        cls.test_b = f'mv-test-beta-{cls._prefix}'
        cls.test_c = f'mv-test-gamma-{cls._prefix}'

        for i, tname in enumerate([cls.test_a, cls.test_b, cls.test_c]):
            submit_run(
                cls.client, cls.machine_name, f'{500 + i}-{rev_prefix}',
                [{'name': tname, 'execution_time': [float(i + 1) * 2.0]}],
            )

        # Assign ordinals via API (D11: ordinals set exclusively via PATCH)
        ordinal_base = int(uuid.uuid4().hex[:6], 16)
        for i in range(3):
            set_ordinal(cls.client, f'{500 + i}-{rev_prefix}',
                        ordinal_base + i)

    def test_single_test_param_returns_only_that_test(self):
        resp = self.client.post(
            PREFIX + '/query',
            json={'machine': self.machine_name, 'test': [self.test_a],
                  'metric': 'execution_time'})
        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        tests = {item['test'] for item in data['items']}
        self.assertEqual(tests, {self.test_a})

    def test_two_test_params_returns_both(self):
        resp = self.client.post(
            PREFIX + '/query',
            json={'machine': self.machine_name,
                  'test': [self.test_a, self.test_b],
                  'metric': 'execution_time'})
        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        tests = {item['test'] for item in data['items']}
        self.assertEqual(tests, {self.test_a, self.test_b})

    def test_three_test_params_returns_all_three(self):
        resp = self.client.post(
            PREFIX + '/query',
            json={'machine': self.machine_name,
                  'test': [self.test_a, self.test_b, self.test_c],
                  'metric': 'execution_time'})
        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        tests = {item['test'] for item in data['items']}
        self.assertEqual(tests, {self.test_a, self.test_b, self.test_c})

    def test_unknown_test_names_silently_skipped(self):
        resp = self.client.post(
            PREFIX + '/query',
            json={'machine': self.machine_name,
                  'test': [self.test_a, 'nonexistent-xyz-999'],
                  'metric': 'execution_time'})
        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        tests = {item['test'] for item in data['items']}
        self.assertEqual(tests, {self.test_a})

    def test_all_unknown_returns_empty(self):
        resp = self.client.post(
            PREFIX + '/query',
            json={'machine': self.machine_name,
                  'test': ['nonexistent-1', 'nonexistent-2'],
                  'metric': 'execution_time'})
        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        self.assertEqual(len(data['items']), 0)

    def test_no_test_param_returns_all_tests(self):
        resp = self.client.post(
            PREFIX + '/query',
            json={'machine': self.machine_name,
                  'metric': 'execution_time'})
        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        tests = {item['test'] for item in data['items']}
        self.assertTrue(
            {self.test_a, self.test_b, self.test_c}.issubset(tests))


if __name__ == '__main__':
    unittest.main(argv=[sys.argv[0]], exit=True)

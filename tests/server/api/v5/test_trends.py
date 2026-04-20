# Tests for the v5 trends endpoint (POST /api/v5/{ts}/trends).
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
    create_app, create_client,
    create_machine, create_commit, create_run,
    create_test, create_sample,
)

TS = 'nts'
PREFIX = f'/api/v5/{TS}'


def _setup_trends_data(app, unique=None):
    """Create two machines, two tests, and several runs with samples.

    Uses direct DB helpers for timestamp control.  All commits are assigned
    ordinals so they participate in trends queries.

    Returns a dict with metadata for assertions.
    """
    if unique is None:
        unique = uuid.uuid4().hex[:8]

    machine_a_name = f'trends-m-a-{unique}'
    machine_b_name = f'trends-m-b-{unique}'
    test1_name = f'trends-t1/{unique}'
    test2_name = f'trends-t2/{unique}'

    db = app.instance.get_database("default")
    session = db.make_session()
    ts = db.testsuite[TS]

    machine_a = create_machine(session, ts, name=machine_a_name)
    machine_b = create_machine(session, ts, name=machine_b_name)
    test1 = create_test(session, ts, name=test1_name)
    test2 = create_test(session, ts, name=test2_name)

    # Machine A: 3 commits, each with 2 tests
    # Commit ordinal 10000: test1=4.0, test2=16.0  -> geomean = 8.0
    # Commit ordinal 10001: test1=9.0, test2=9.0   -> geomean = 9.0
    # Commit ordinal 10002: test1=1.0, test2=100.0 -> geomean = 10.0
    for i, (v1, v2) in enumerate([(4.0, 16.0), (9.0, 9.0), (1.0, 100.0)]):
        commit = create_commit(
            session, ts, commit=f'{100 + i}-{unique}')
        commit.ordinal = 10000 + i
        run = create_run(
            session, ts, machine_a, commit,
            submitted_at=datetime.datetime(2024, 6, 1 + i, 12, 0, 0, tzinfo=datetime.timezone.utc))
        create_sample(session, ts, run, test1, execution_time=v1)
        create_sample(session, ts, run, test2, execution_time=v2)

    # Machine B: 1 commit with 1 test (earlier ordinal)
    commit_b = create_commit(
        session, ts, commit=f'200-{unique}')
    commit_b.ordinal = 9000
    run_b = create_run(
        session, ts, machine_b, commit_b,
        submitted_at=datetime.datetime(2024, 5, 1, 12, 0, 0, tzinfo=datetime.timezone.utc))
    create_sample(session, ts, run_b, test1, execution_time=25.0)

    session.commit()
    session.close()

    return {
        'machine_a': machine_a_name,
        'machine_b': machine_b_name,
        'test1': test1_name,
        'test2': test2_name,
    }


def _setup_single_commit(app, *, values, commit_prefix, submitted_at,
                         ordinal):
    """Create a machine with two tests and one commit for edge-case testing.

    *values* is a dict mapping test suffix ('t1', 't2') to sample value.
    *ordinal* is the commit's ordinal position (required for trends).
    Returns the machine name.
    """
    unique = uuid.uuid4().hex[:8]
    machine_name = f'trends-{commit_prefix}-m-{unique}'

    db = app.instance.get_database("default")
    session = db.make_session()
    ts = db.testsuite[TS]

    machine = create_machine(session, ts, name=machine_name)
    test1 = create_test(session, ts, name=f'trends-{commit_prefix}-t1/{unique}')
    test2 = create_test(session, ts, name=f'trends-{commit_prefix}-t2/{unique}')
    commit = create_commit(session, ts, commit=f'{commit_prefix}-{unique}')
    commit.ordinal = ordinal
    run = create_run(
        session, ts, machine, commit, submitted_at=submitted_at)
    create_sample(session, ts, run, test1, execution_time=values['t1'])
    create_sample(session, ts, run, test2, execution_time=values['t2'])

    session.commit()
    session.close()
    return machine_name


class TestTrendsErrors(unittest.TestCase):
    """Tests for error responses from the trends endpoint."""
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.app = create_app(sys.argv[1])
        cls.client = create_client(cls.app)

    def test_unknown_metric_returns_400(self):
        resp = self.client.post(
            PREFIX + '/trends',
            json={'metric': 'nonexistent_metric'})
        self.assertEqual(resp.status_code, 400)
        data = resp.get_json()
        self.assertIn('error', data)

    def test_unknown_machine_returns_404(self):
        resp = self.client.post(
            PREFIX + '/trends',
            json={'metric': 'execution_time',
                  'machine': ['nonexistent-machine-xyz']})
        self.assertEqual(resp.status_code, 404)
        data = resp.get_json()
        self.assertIn('error', data)

    def test_unknown_fields_rejected(self):
        resp = self.client.post(
            PREFIX + '/trends',
            json={'metric': 'execution_time', 'bogus_field': 'value'})
        self.assertEqual(resp.status_code, 422)

    def test_invalid_last_n_zero_returns_422(self):
        resp = self.client.post(
            PREFIX + '/trends',
            json={'metric': 'execution_time', 'last_n': 0})
        self.assertEqual(resp.status_code, 422)

    def test_invalid_last_n_negative_returns_422(self):
        resp = self.client.post(
            PREFIX + '/trends',
            json={'metric': 'execution_time', 'last_n': -1})
        self.assertEqual(resp.status_code, 422)

    def test_non_integer_last_n_returns_422(self):
        resp = self.client.post(
            PREFIX + '/trends',
            json={'metric': 'execution_time', 'last_n': 'abc'})
        self.assertEqual(resp.status_code, 422)

    def test_old_after_time_param_rejected(self):
        """Sending the removed after_time parameter returns 422."""
        resp = self.client.post(
            PREFIX + '/trends',
            json={'metric': 'execution_time',
                  'after_time': '2024-01-01T00:00:00Z'})
        self.assertEqual(resp.status_code, 422)

    def test_old_before_time_param_rejected(self):
        """Sending the removed before_time parameter returns 422."""
        resp = self.client.post(
            PREFIX + '/trends',
            json={'metric': 'execution_time',
                  'before_time': '2024-01-01T00:00:00Z'})
        self.assertEqual(resp.status_code, 422)

    def test_missing_metric_returns_422(self):
        resp = self.client.post(
            PREFIX + '/trends', json={})
        self.assertEqual(resp.status_code, 422)

    def test_non_numeric_metric_returns_400(self):
        resp = self.client.post(
            PREFIX + '/trends',
            json={'metric': 'hash'})
        self.assertEqual(resp.status_code, 400)
        data = resp.get_json()
        self.assertIn('error', data)
        self.assertIn("'real'", data['error']['message'])


class TestTrendsValidQuery(unittest.TestCase):
    """Tests for valid queries that return aggregated trends data."""
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.app = create_app(sys.argv[1])
        cls.client = create_client(cls.app)
        cls._data = _setup_trends_data(cls.app)

    def test_returns_200(self):
        d = self._data
        resp = self.client.post(
            PREFIX + '/trends',
            json={'metric': 'execution_time',
                  'machine': [d['machine_a']]})
        self.assertEqual(resp.status_code, 200)

    def test_response_structure(self):
        d = self._data
        resp = self.client.post(
            PREFIX + '/trends',
            json={'metric': 'execution_time',
                  'machine': [d['machine_a']]})
        data = resp.get_json()
        self.assertIn('metric', data)
        self.assertEqual(data['metric'], 'execution_time')
        self.assertIn('items', data)
        self.assertIsInstance(data['items'], list)

    def test_item_structure(self):
        d = self._data
        resp = self.client.post(
            PREFIX + '/trends',
            json={'metric': 'execution_time',
                  'machine': [d['machine_a']]})
        data = resp.get_json()
        self.assertGreater(len(data['items']), 0)
        item = data['items'][0]
        self.assertIn('machine', item)
        self.assertIn('commit', item)
        self.assertIn('ordinal', item)
        self.assertIn('submitted_at', item)
        self.assertIn('value', item)
        self.assertIsInstance(item['commit'], str)
        # ordinal is always present (never null) for trends
        self.assertIsNotNone(item['ordinal'])
        self.assertIsInstance(item['ordinal'], int)

    def test_geomean_correctness(self):
        """Verify geomean is computed correctly from known values."""
        d = self._data
        resp = self.client.post(
            PREFIX + '/trends',
            json={'metric': 'execution_time',
                  'machine': [d['machine_a']]})
        data = resp.get_json()
        items = data['items']
        self.assertEqual(len(items), 3)

        # Items should be sorted by ordinal
        # Commit ordinal 100: geomean(4, 16) = 8.0
        # Commit ordinal 101: geomean(9, 9) = 9.0
        # Commit ordinal 102: geomean(1, 100) = 10.0
        values = [item['value'] for item in items]
        self.assertAlmostEqual(values[0], 8.0, places=5)
        self.assertAlmostEqual(values[1], 9.0, places=5)
        self.assertAlmostEqual(values[2], 10.0, places=5)

    def test_machine_filter(self):
        """Only requested machines are included."""
        d = self._data
        resp = self.client.post(
            PREFIX + '/trends',
            json={'metric': 'execution_time',
                  'machine': [d['machine_a']]})
        data = resp.get_json()
        machines = {item['machine'] for item in data['items']}
        self.assertEqual(machines, {d['machine_a']})

    def test_no_machine_filter_returns_all(self):
        """Omitting machine returns data for all machines."""
        d = self._data
        resp = self.client.post(
            PREFIX + '/trends',
            json={'metric': 'execution_time'})
        data = resp.get_json()
        machines = {item['machine'] for item in data['items']}
        self.assertIn(d['machine_a'], machines)
        self.assertIn(d['machine_b'], machines)

    def test_multiple_machines(self):
        """Multiple machines in a single request."""
        d = self._data
        resp = self.client.post(
            PREFIX + '/trends',
            json={'metric': 'execution_time',
                  'machine': [d['machine_a'], d['machine_b']]})
        data = resp.get_json()
        machines = {item['machine'] for item in data['items']}
        self.assertEqual(machines, {d['machine_a'], d['machine_b']})

    def test_last_n_filter(self):
        """last_n limits to the most recent N commits by ordinal."""
        d = self._data
        # Ordinals: machine_b has 9000, machine_a has 10000, 10001, 10002
        # last_n=3 should return ordinals 10000, 10001, 10002 (top 3),
        # excluding 9000
        resp = self.client.post(
            PREFIX + '/trends',
            json={'metric': 'execution_time',
                  'last_n': 3,
                  'machine': [d['machine_a'], d['machine_b']]})
        data = resp.get_json()
        machines = {item['machine'] for item in data['items']}
        self.assertIn(d['machine_a'], machines)
        self.assertNotIn(d['machine_b'], machines)
        # Machine A should have all 3 commits
        a_items = [i for i in data['items'] if i['machine'] == d['machine_a']]
        self.assertEqual(len(a_items), 3)

    def test_last_n_with_no_matching_data(self):
        """last_n=1 with machine filter that has no data at top commit."""
        d = self._data
        # last_n=1 returns ordinal 10002 only; machine_b has no data there
        resp = self.client.post(
            PREFIX + '/trends',
            json={'metric': 'execution_time',
                  'last_n': 1,
                  'machine': [d['machine_b']]})
        data = resp.get_json()
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(len(data['items']), 0)

    def test_last_n_none_returns_all_ordered(self):
        """Omitting last_n returns all commits with ordinals."""
        d = self._data
        resp = self.client.post(
            PREFIX + '/trends',
            json={'metric': 'execution_time',
                  'machine': [d['machine_a'], d['machine_b']]})
        data = resp.get_json()
        # Should include all 4 items: 3 from machine_a + 1 from machine_b
        self.assertEqual(len(data['items']), 4)

    def test_sorted_by_machine_then_ordinal(self):
        """Items are sorted by machine name ascending, then ordinal."""
        d = self._data
        resp = self.client.post(
            PREFIX + '/trends',
            json={'metric': 'execution_time',
                  'machine': [d['machine_a'], d['machine_b']]})
        data = resp.get_json()
        items = data['items']

        # Check overall ordering: machine names should be non-decreasing
        machine_names = [item['machine'] for item in items]
        self.assertEqual(machine_names, sorted(machine_names))

        # Within each machine, ordinals should be ascending
        from itertools import groupby
        for _, group in groupby(items, key=lambda x: x['machine']):
            ordinals = [item['ordinal'] for item in group]
            self.assertEqual(ordinals, sorted(ordinals))

    def test_unordered_commits_excluded(self):
        """Commits without ordinals are excluded from trends results."""
        unique = uuid.uuid4().hex[:8]
        machine_name = f'trends-unord-m-{unique}'

        db = self.app.instance.get_database("default")
        session = db.make_session()
        ts = db.testsuite[TS]

        machine = create_machine(session, ts, name=machine_name)
        test = create_test(session, ts, name=f'trends-unord-t/{unique}')
        # Create commit WITHOUT setting ordinal
        commit = create_commit(session, ts, commit=f'unord-{unique}')
        run = create_run(session, ts, machine, commit)
        create_sample(session, ts, run, test, execution_time=42.0)
        session.commit()
        session.close()

        resp = self.client.post(
            PREFIX + '/trends',
            json={'metric': 'execution_time',
                  'machine': [machine_name]})
        data = resp.get_json()
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(len(data['items']), 0)


class TestTrendsEdgeCases(unittest.TestCase):
    """Tests for edge cases: zero values, etc."""
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.app = create_app(sys.argv[1])
        cls.client = create_client(cls.app)
        # One commit with test1=0.0 (should be excluded) and test2=25.0
        cls._machine_name = _setup_single_commit(
            cls.app,
            values={'t1': 0.0, 't2': 25.0},
            commit_prefix='edge',
            ordinal=300,
            submitted_at=datetime.datetime(2024, 7, 1, 12, 0, 0, tzinfo=datetime.timezone.utc))

    def test_geomean_excludes_zero_values(self):
        """Zero values are excluded from the geomean computation."""
        resp = self.client.post(
            PREFIX + '/trends',
            json={'metric': 'execution_time',
                  'machine': [self._machine_name]})
        data = resp.get_json()
        self.assertEqual(len(data['items']), 1)
        # Only test2=25.0 is included (test1=0.0 is excluded)
        self.assertAlmostEqual(data['items'][0]['value'], 25.0, places=5)


class TestTrendsAllZeroGroup(unittest.TestCase):
    """Test that a group where ALL values are zero/negative is excluded."""
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.app = create_app(sys.argv[1])
        cls.client = create_client(cls.app)
        # Commit with all-zero values -- should produce no result
        cls._machine_name = _setup_single_commit(
            cls.app,
            values={'t1': 0.0, 't2': 0.0},
            commit_prefix='allzero',
            ordinal=400,
            submitted_at=datetime.datetime(2024, 8, 1, 12, 0, 0, tzinfo=datetime.timezone.utc))

    def test_all_zero_group_excluded(self):
        """A group where every sample is zero produces no result."""
        resp = self.client.post(
            PREFIX + '/trends',
            json={'metric': 'execution_time',
                  'machine': [self._machine_name]})
        data = resp.get_json()
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(len(data['items']), 0)


class TestTrendsNegativeValues(unittest.TestCase):
    """Test that negative values are excluded from the geomean."""
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.app = create_app(sys.argv[1])
        cls.client = create_client(cls.app)
        # One negative, one positive -- geomean should use only the positive
        cls._machine_name = _setup_single_commit(
            cls.app,
            values={'t1': -5.0, 't2': 16.0},
            commit_prefix='neg',
            ordinal=500,
            submitted_at=datetime.datetime(2024, 8, 2, 12, 0, 0, tzinfo=datetime.timezone.utc))

    def test_negative_values_excluded(self):
        """Negative values are excluded; geomean uses only positive values."""
        resp = self.client.post(
            PREFIX + '/trends',
            json={'metric': 'execution_time',
                  'machine': [self._machine_name]})
        data = resp.get_json()
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(len(data['items']), 1)
        # Only test2=16.0 contributes
        self.assertAlmostEqual(data['items'][0]['value'], 16.0, places=5)


if __name__ == '__main__':
    unittest.main(argv=[sys.argv[0]])

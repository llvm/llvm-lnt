# Tests for the v5 trends endpoint (POST /api/v5/{ts}/trends).
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
    create_app, create_client, submit_run,
)

TS = 'nts'
PREFIX = f'/api/v5/{TS}'


def _setup_trends_data(client, unique=None):
    """Create two machines, two tests, and several runs with samples.

    Returns a dict with metadata for assertions.
    """
    if unique is None:
        unique = uuid.uuid4().hex[:8]

    machine_a_name = f'trends-m-a-{unique}'
    machine_b_name = f'trends-m-b-{unique}'
    test1_name = f'trends-t1/{unique}'
    test2_name = f'trends-t2/{unique}'

    # Machine A: 3 orders, each with 2 tests
    # Order 100: test1=4.0, test2=16.0  -> geomean = 8.0
    # Order 101: test1=9.0, test2=9.0   -> geomean = 9.0
    # Order 102: test1=1.0, test2=100.0 -> geomean = 10.0
    for i, (v1, v2) in enumerate([(4.0, 16.0), (9.0, 9.0), (1.0, 100.0)]):
        submit_run(client, machine_a_name, f'{100 + i}-{unique}',
                   [{'name': test1_name, 'execution_time': [v1]},
                    {'name': test2_name, 'execution_time': [v2]}],
                   start_time=f'2024-06-0{1 + i}T12:00:00',
                   end_time=f'2024-06-0{1 + i}T12:30:00')

    # Machine B: 1 order with 1 test (earlier date, outside some time ranges)
    submit_run(client, machine_b_name, f'200-{unique}',
               [{'name': test1_name, 'execution_time': [25.0]}],
               start_time='2024-05-01T12:00:00',
               end_time='2024-05-01T12:30:00')

    return {
        'machine_a': machine_a_name,
        'machine_b': machine_b_name,
        'test1': test1_name,
        'test2': test2_name,
    }


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

    def test_malformed_after_time_returns_400(self):
        resp = self.client.post(
            PREFIX + '/trends',
            json={'metric': 'execution_time',
                  'after_time': 'not-a-date'})
        self.assertEqual(resp.status_code, 400)
        data = resp.get_json()
        self.assertIn('error', data)

    def test_malformed_before_time_returns_400(self):
        resp = self.client.post(
            PREFIX + '/trends',
            json={'metric': 'execution_time',
                  'before_time': 'not-a-date'})
        self.assertEqual(resp.status_code, 400)
        data = resp.get_json()
        self.assertIn('error', data)

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
        self.assertIn('numeric', data['error']['message'])


class TestTrendsValidQuery(unittest.TestCase):
    """Tests for valid queries that return aggregated trends data."""
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.app = create_app(sys.argv[1])
        cls.client = create_client(cls.app)
        cls._data = _setup_trends_data(cls.client)

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
        self.assertIn('order', item)
        self.assertIn('timestamp', item)
        self.assertIn('value', item)
        self.assertIsInstance(item['order'], dict)

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

        # Items should be sorted by timestamp
        # Order 100: geomean(4, 16) = 8.0
        # Order 101: geomean(9, 9) = 9.0
        # Order 102: geomean(1, 100) = 10.0
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

    def test_time_range_filter(self):
        """after_time/before_time correctly filters results."""
        d = self._data
        # Machine B's data is from 2024-05-01, Machine A from 2024-06-01+
        # Filter to only June — should exclude Machine B
        resp = self.client.post(
            PREFIX + '/trends',
            json={'metric': 'execution_time',
                  'after_time': '2024-05-15T00:00:00Z',
                  'machine': [d['machine_a'], d['machine_b']]})
        data = resp.get_json()
        machines = {item['machine'] for item in data['items']}
        self.assertIn(d['machine_a'], machines)
        self.assertNotIn(d['machine_b'], machines)

    def test_empty_result(self):
        """Time range with no data returns empty items."""
        d = self._data
        resp = self.client.post(
            PREFIX + '/trends',
            json={'metric': 'execution_time',
                  'after_time': '2099-01-01T00:00:00Z',
                  'machine': [d['machine_a']]})
        data = resp.get_json()
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(len(data['items']), 0)

    def test_sorted_by_machine_then_timestamp(self):
        """Items are sorted by machine name ascending, then timestamp."""
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

        # Within each machine, timestamps should be ascending
        from itertools import groupby
        for _, group in groupby(items, key=lambda x: x['machine']):
            timestamps = [item['timestamp'] for item in group]
            self.assertEqual(timestamps, sorted(timestamps))


class TestTrendsEdgeCases(unittest.TestCase):
    """Tests for edge cases: zero values, etc."""
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.app = create_app(sys.argv[1])
        cls.client = create_client(cls.app)

        unique = uuid.uuid4().hex[:8]
        cls._machine_name = f'trends-edge-m-{unique}'

        # One order with test1=0.0 (should be excluded) and test2=25.0
        submit_run(cls.client, cls._machine_name, f'edge-{unique}',
                   [{'name': f'trends-edge-t1/{unique}', 'execution_time': [0.0]},
                    {'name': f'trends-edge-t2/{unique}', 'execution_time': [25.0]}],
                   start_time='2024-07-01T12:00:00',
                   end_time='2024-07-01T12:30:00')

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

        unique = uuid.uuid4().hex[:8]
        cls._machine_name = f'trends-allzero-m-{unique}'

        # Order with all-zero values — should produce no result
        submit_run(cls.client, cls._machine_name, f'allzero-{unique}',
                   [{'name': f'trends-allzero-t1/{unique}', 'execution_time': [0.0]},
                    {'name': f'trends-allzero-t2/{unique}', 'execution_time': [0.0]}],
                   start_time='2024-08-01T12:00:00',
                   end_time='2024-08-01T12:30:00')

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

        unique = uuid.uuid4().hex[:8]
        cls._machine_name = f'trends-neg-m-{unique}'

        # One negative, one positive — geomean should use only the positive
        submit_run(cls.client, cls._machine_name, f'neg-{unique}',
                   [{'name': f'trends-neg-t1/{unique}', 'execution_time': [-5.0]},
                    {'name': f'trends-neg-t2/{unique}', 'execution_time': [16.0]}],
                   start_time='2024-08-02T12:00:00',
                   end_time='2024-08-02T12:30:00')

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

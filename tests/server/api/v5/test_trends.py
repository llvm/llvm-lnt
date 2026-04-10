# Tests for the v5 trends endpoint (POST /api/v5/{ts}/trends).
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
    create_app, create_client,
    create_machine, create_order, create_run, create_test, create_sample,
)

TS = 'nts'
PREFIX = f'/api/v5/{TS}'


def _setup_trends_data(app, unique=None):
    """Create two machines, two tests, and several runs with samples.

    Returns a dict with metadata for assertions.
    """
    if unique is None:
        unique = uuid.uuid4().hex[:8]
    db = app.instance.get_database("default")
    session = db.make_session()
    ts = db.testsuite[TS]

    machine_a = create_machine(session, ts, name=f'trends-m-a-{unique}')
    machine_b = create_machine(session, ts, name=f'trends-m-b-{unique}')
    test1 = create_test(session, ts, name=f'trends-t1/{unique}')
    test2 = create_test(session, ts, name=f'trends-t2/{unique}')

    # Machine A: 3 orders, each with 2 tests
    # Order 100: test1=4.0, test2=16.0  -> geomean = 8.0
    # Order 101: test1=9.0, test2=9.0   -> geomean = 9.0
    # Order 102: test1=1.0, test2=100.0 -> geomean = 10.0
    for i, (v1, v2) in enumerate([(4.0, 16.0), (9.0, 9.0), (1.0, 100.0)]):
        order = create_order(session, ts, revision=str(100 + i))
        run = create_run(
            session, ts, machine_a, order,
            start_time=datetime.datetime(2024, 6, 1 + i, 12, 0, 0),
            end_time=datetime.datetime(2024, 6, 1 + i, 12, 30, 0),
        )
        create_sample(session, ts, run, test1, execution_time=v1)
        create_sample(session, ts, run, test2, execution_time=v2)

    # Machine B: 1 order with 1 test (earlier date, outside some time ranges)
    order_b = create_order(session, ts, revision='200')
    run_b = create_run(
        session, ts, machine_b, order_b,
        start_time=datetime.datetime(2024, 5, 1, 12, 0, 0),
        end_time=datetime.datetime(2024, 5, 1, 12, 30, 0),
    )
    create_sample(session, ts, run_b, test1, execution_time=25.0)

    session.commit()
    session.close()

    return {
        'machine_a': f'trends-m-a-{unique}',
        'machine_b': f'trends-m-b-{unique}',
        'test1': f'trends-t1/{unique}',
        'test2': f'trends-t2/{unique}',
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

        db = cls.app.instance.get_database("default")
        session = db.make_session()
        ts = db.testsuite[TS]

        machine = create_machine(session, ts, name=cls._machine_name)
        test1 = create_test(session, ts, name=f'trends-edge-t1/{unique}')
        test2 = create_test(session, ts, name=f'trends-edge-t2/{unique}')

        # One order with test1=0.0 (should be excluded) and test2=25.0
        order = create_order(session, ts, revision=f'edge-{unique}')
        run = create_run(
            session, ts, machine, order,
            start_time=datetime.datetime(2024, 7, 1, 12, 0, 0),
        )
        create_sample(session, ts, run, test1, execution_time=0.0)
        create_sample(session, ts, run, test2, execution_time=25.0)

        session.commit()
        session.close()

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


if __name__ == '__main__':
    unittest.main(argv=[sys.argv[0]])

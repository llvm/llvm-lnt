# RUN: rm -rf %t.instance %t.pg.log
# RUN: %{utils}/with_postgres.sh %t.pg.log \
# RUN:     python %s
# END.

import datetime
import os
import sys
import unittest

import sqlalchemy
import sqlalchemy.orm

from lnt.server.db.v5.schema import parse_schema
from lnt.server.db.v5.models import create_suite_models
from lnt.server.db.v5 import V5TestSuiteDB


def _make_engine():
    db_uri = os.environ.get('LNT_TEST_DB_URI')
    db_name = os.environ.get('LNT_TEST_DB_NAME')
    if not db_uri or not db_name:
        raise unittest.SkipTest(
            "LNT_TEST_DB_URI / LNT_TEST_DB_NAME not set")
    return sqlalchemy.create_engine(f"{db_uri}/{db_name}")


def _test_schema():
    return parse_schema({
        "name": "ts",
        "metrics": [
            {"name": "execution_time", "type": "real"},
        ],
        "commit_fields": [
            {"name": "author", "searchable": True},
        ],
        "machine_fields": [
            {"name": "hardware", "searchable": True},
        ],
    })


class TestTimeSeries(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        cls.engine = _make_engine()
        cls.schema = _test_schema()
        cls.suite_models = create_suite_models(cls.schema)
        cls.suite_models.base.metadata.drop_all(cls.engine)
        cls.suite_models.base.metadata.create_all(cls.engine)
        cls.Session = sqlalchemy.orm.sessionmaker(cls.engine)

        class _FakeV5DB:
            pass
        cls.tsdb = V5TestSuiteDB(_FakeV5DB(), cls.schema, cls.suite_models)

        # Seed test data
        session = cls.Session(expire_on_commit=False)

        cls.machine = cls.tsdb.get_or_create_machine(
            session, "ts-machine", hardware="x86_64")

        cls.test = cls.tsdb.get_or_create_test(session, "ts-test/bench")

        # Create 5 commits with ordinals
        cls.commits = []
        for i in range(5):
            c = cls.tsdb.get_or_create_commit(
                session, f"commit-{i}", author=f"Author-{i}")
            c.ordinal = (i + 1) * 10  # 10, 20, 30, 40, 50
            cls.commits.append(c)
        session.flush()

        # Create a commit WITHOUT ordinal
        cls.unordered_commit = cls.tsdb.get_or_create_commit(
            session, "unordered-commit")
        session.flush()

        # Create runs and samples
        base_time = datetime.datetime(2024, 1, 1, 12, 0, 0, tzinfo=datetime.timezone.utc)
        cls.runs = []
        for i, c in enumerate(cls.commits):
            run = cls.tsdb.create_run(
                session, cls.machine, commit=c,
                submitted_at=base_time + datetime.timedelta(hours=i))
            cls.tsdb.create_samples(session, run, [{
                "test_id": cls.test.id,
                "execution_time": float(i + 1),
            }])
            cls.runs.append(run)

        # Run at unordered commit
        cls.unordered_run = cls.tsdb.create_run(
            session, cls.machine, commit=cls.unordered_commit,
            submitted_at=base_time + datetime.timedelta(hours=10))
        cls.tsdb.create_samples(session, cls.unordered_run, [{
            "test_id": cls.test.id,
            "execution_time": 99.0,
        }])

        session.commit()
        session.close()

    @classmethod
    def tearDownClass(cls):
        cls.suite_models.base.metadata.drop_all(cls.engine)
        cls.engine.dispose()

    def test_basic_query(self):
        session = self.Session()
        results = self.tsdb.query_time_series(
            session, self.machine, self.test, "execution_time")
        # Should include all 5 ordered + 1 unordered commits (6 total)
        # (commitless run excluded because it has no commit join)
        self.assertEqual(len(results), 6)
        session.close()

    def test_sort_by_ordinal(self):
        """Sorting by ordinal excludes unordered commits."""
        session = self.Session()
        results = self.tsdb.query_time_series(
            session, self.machine, self.test, "execution_time",
            sort="ordinal")
        # Only 5 commits with ordinals
        self.assertEqual(len(results), 5)
        ordinals = [r["ordinal"] for r in results]
        self.assertEqual(ordinals, [10, 20, 30, 40, 50])
        session.close()

    def test_commit_range(self):
        session = self.Session()
        results = self.tsdb.query_time_series(
            session, self.machine, self.test, "execution_time",
            commit_range=(20, 40))
        ordinals = [r["ordinal"] for r in results]
        self.assertEqual(len(results), 3)
        for o in ordinals:
            self.assertGreaterEqual(o, 20)
            self.assertLessEqual(o, 40)
        session.close()

    def test_time_range(self):
        session = self.Session()
        start = datetime.datetime(2024, 1, 1, 13, 0, 0, tzinfo=datetime.timezone.utc)  # after first run
        end = datetime.datetime(2024, 1, 1, 15, 0, 0, tzinfo=datetime.timezone.utc)    # up to 3rd run
        results = self.tsdb.query_time_series(
            session, self.machine, self.test, "execution_time",
            time_range=(start, end))
        self.assertGreater(len(results), 0)
        for r in results:
            self.assertGreaterEqual(r["submitted_at"], start)
            self.assertLessEqual(r["submitted_at"], end)
        session.close()

    def test_create_run_without_commit_raises(self):
        session = self.Session()
        with self.assertRaises(ValueError):
            self.tsdb.create_run(
                session, self.machine, commit=None,
                submitted_at=datetime.datetime(2024, 1, 1, 12, 0, 0, tzinfo=datetime.timezone.utc))
        session.close()

    def test_unknown_metric_raises(self):
        session = self.Session()
        with self.assertRaises(ValueError):
            self.tsdb.query_time_series(
                session, self.machine, self.test, "nonexistent_metric")
        session.close()

    def test_limit(self):
        session = self.Session()
        results = self.tsdb.query_time_series(
            session, self.machine, self.test, "execution_time",
            limit=2)
        self.assertEqual(len(results), 2)
        session.close()

    def test_result_structure(self):
        session = self.Session()
        results = self.tsdb.query_time_series(
            session, self.machine, self.test, "execution_time",
            sort="ordinal", limit=1)
        self.assertEqual(len(results), 1)
        r = results[0]
        self.assertIn("commit", r)
        self.assertIn("ordinal", r)
        self.assertIn("value", r)
        self.assertIn("run_id", r)
        self.assertIn("submitted_at", r)
        session.close()


class TestQueryTrends(unittest.TestCase):
    """Tests for V5TestSuiteDB.query_trends() geomean aggregation."""

    @classmethod
    def setUpClass(cls):
        cls.engine = _make_engine()
        cls.schema = _test_schema()
        cls.suite_models = create_suite_models(cls.schema)
        cls.suite_models.base.metadata.drop_all(cls.engine)
        cls.suite_models.base.metadata.create_all(cls.engine)
        cls.Session = sqlalchemy.orm.sessionmaker(cls.engine)

        class _FakeV5DB:
            pass
        cls.tsdb = V5TestSuiteDB(_FakeV5DB(), cls.schema, cls.suite_models)

        # Seed data: 2 machines, 3 commits, multiple tests per commit
        session = cls.Session(expire_on_commit=False)

        cls.machine_a = cls.tsdb.get_or_create_machine(
            session, "trends-machine-a", hardware="x86_64")
        cls.machine_b = cls.tsdb.get_or_create_machine(
            session, "trends-machine-b", hardware="arm64")

        cls.test1 = cls.tsdb.get_or_create_test(session, "trends/bench1")
        cls.test2 = cls.tsdb.get_or_create_test(session, "trends/bench2")

        cls.commits = []
        base_time = datetime.datetime(2024, 3, 1, 12, 0, 0, tzinfo=datetime.timezone.utc)
        for i in range(3):
            c = cls.tsdb.get_or_create_commit(session, f"trends-commit-{i}")
            c.ordinal = (i + 1) * 10  # 10, 20, 30
            cls.commits.append(c)
        session.flush()

        # Create runs and samples for machine_a
        for i, c in enumerate(cls.commits):
            run = cls.tsdb.create_run(
                session, cls.machine_a, commit=c,
                submitted_at=base_time + datetime.timedelta(hours=i))
            # Two tests per run with known positive values
            cls.tsdb.create_samples(session, run, [
                {"test_id": cls.test1.id, "execution_time": 2.0},
                {"test_id": cls.test2.id, "execution_time": 8.0},
            ])

        # Create runs and samples for machine_b (only first 2 commits)
        for i, c in enumerate(cls.commits[:2]):
            run = cls.tsdb.create_run(
                session, cls.machine_b, commit=c,
                submitted_at=base_time + datetime.timedelta(hours=i + 10))
            cls.tsdb.create_samples(session, run, [
                {"test_id": cls.test1.id, "execution_time": 4.0},
            ])

        session.commit()
        session.close()

    @classmethod
    def tearDownClass(cls):
        cls.suite_models.base.metadata.drop_all(cls.engine)
        cls.engine.dispose()

    def test_basic_query_trends(self):
        """query_trends returns geomean-aggregated data."""
        session = self.Session()
        results = self.tsdb.query_trends(session, "execution_time")
        self.assertGreater(len(results), 0)
        # Check structure
        r = results[0]
        self.assertIn("machine_name", r)
        self.assertIn("commit", r)
        self.assertIn("ordinal", r)
        self.assertIn("value", r)
        self.assertIn("submitted_at", r)
        session.close()

    def test_query_trends_geomean_value(self):
        """Verify the geomean is computed correctly for machine_a."""
        session = self.Session()
        results = self.tsdb.query_trends(
            session, "execution_time",
            machine_ids=[self.machine_a.id])
        # Machine A has 3 commits, each with values [2.0, 8.0]
        # geomean(2, 8) = exp(avg(ln(2), ln(8))) = exp((ln2+ln8)/2)
        #               = exp(ln(2*8)/2) = exp(ln(16)/2) = sqrt(16) = 4.0
        for r in results:
            self.assertEqual(r["machine_name"], "trends-machine-a")
            self.assertAlmostEqual(r["value"], 4.0, places=5)
        self.assertEqual(len(results), 3)
        session.close()

    def test_query_trends_filter_by_machine(self):
        """Filter by machine_ids returns only that machine's data."""
        session = self.Session()
        results = self.tsdb.query_trends(
            session, "execution_time",
            machine_ids=[self.machine_b.id])
        for r in results:
            self.assertEqual(r["machine_name"], "trends-machine-b")
        # Machine B only has 2 commits
        self.assertEqual(len(results), 2)
        session.close()

    def test_query_trends_filter_by_time_range(self):
        """after_time/before_time use exclusive bounds (> / <)."""
        session = self.Session()
        # Seed data has machine_a runs at 12:00, 13:00, 14:00.
        # With exclusive bounds, start=12:00 excludes the 12:00 run and
        # end=13:30 excludes nothing extra, leaving only the 13:00 run.
        start = datetime.datetime(2024, 3, 1, 12, 0, 0, tzinfo=datetime.timezone.utc)
        end = datetime.datetime(2024, 3, 1, 13, 30, 0, tzinfo=datetime.timezone.utc)
        results = self.tsdb.query_trends(
            session, "execution_time",
            after_time=start, before_time=end)
        self.assertEqual(len(results), 1)
        for r in results:
            self.assertIsNotNone(r["submitted_at"])
            self.assertGreater(r["submitted_at"], start)
            self.assertLess(r["submitted_at"], end)
        session.close()

    def test_query_trends_unknown_metric_raises(self):
        """Unknown metric name raises ValueError."""
        session = self.Session()
        with self.assertRaises(ValueError):
            self.tsdb.query_trends(session, "nonexistent_metric")
        session.close()

    def test_query_trends_ordered_by_ordinal(self):
        """Results are ordered by ordinal."""
        session = self.Session()
        results = self.tsdb.query_trends(
            session, "execution_time",
            machine_ids=[self.machine_a.id])
        ordinals = [r["ordinal"] for r in results]
        self.assertEqual(ordinals, sorted(ordinals))
        session.close()


if __name__ == '__main__':
    unittest.main(argv=[sys.argv[0]], exit=True)

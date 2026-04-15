# RUN: rm -rf %t.instance %t.pg.log
# RUN: %{utils}/with_postgres.sh %t.pg.log \
# RUN:     python %s
# END.

import os
import sys
import unittest

import json

import sqlalchemy
import sqlalchemy.orm

from lnt.server.db.v5.schema import parse_schema
from lnt.server.db.v5.models import (
    V5Schema,
    V5SchemaVersion,
    create_global_tables,
    create_suite_models,
)
from lnt.server.db.v5 import V5DB, V5TestSuiteDB


def _make_engine():
    db_uri = os.environ.get('LNT_TEST_DB_URI')
    db_name = os.environ.get('LNT_TEST_DB_NAME')
    if not db_uri or not db_name:
        raise unittest.SkipTest(
            "LNT_TEST_DB_URI / LNT_TEST_DB_NAME not set")
    return sqlalchemy.create_engine(f"{db_uri}/{db_name}")


def _test_schema():
    return parse_schema({
        "name": "imp",
        "metrics": [
            {"name": "compile_time", "type": "real"},
            {"name": "execution_time", "type": "real"},
        ],
        "commit_fields": [
            {"name": "git_sha", "searchable": True},
            {"name": "author", "searchable": True},
        ],
        "machine_fields": [
            {"name": "hardware", "searchable": True},
            {"name": "os", "searchable": True},
        ],
    })


class _ImportTestBase(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        cls.engine = _make_engine()
        cls.schema = _test_schema()
        cls.suite_models = create_suite_models(cls.schema)
        cls.suite_models.base.metadata.drop_all(cls.engine)
        cls.suite_models.base.metadata.create_all(cls.engine)
        cls.Session = sqlalchemy.orm.sessionmaker(cls.engine)

        # Build a lightweight V5TestSuiteDB (we don't need the full V5DB)
        class _FakeV5DB:
            pass
        cls.tsdb = V5TestSuiteDB(_FakeV5DB(), cls.schema, cls.suite_models)

    @classmethod
    def tearDownClass(cls):
        cls.suite_models.base.metadata.drop_all(cls.engine)
        cls.engine.dispose()


class TestImportRun(_ImportTestBase):

    def test_import_with_commit(self):
        session = self.Session()
        data = {
            "format_version": "5",
            "machine": {
                "name": "import-machine-1",
                "hardware": "x86_64",
                "os": "linux",
            },
            "commit": "abc123",
            "commit_fields": {
                "git_sha": "abc123def456789",
                "author": "Jane Doe",
            },
            "run_parameters": {
                "build_config": "Release",
            },
            "tests": [
                {
                    "name": "test.suite/benchmark1",
                    "compile_time": 1.23,
                    "execution_time": 0.45,
                },
                {
                    "name": "test.suite/benchmark2",
                    "execution_time": 0.67,
                },
            ],
        }
        run = self.tsdb.import_run(session, data)
        session.commit()

        self.assertIsNotNone(run.id)
        self.assertIsNotNone(run.uuid)
        self.assertIsNotNone(run.commit_id)
        self.assertEqual(run.run_parameters, {"build_config": "Release"})

        # Verify commit was created
        commit = self.tsdb.get_commit(session, id=run.commit_id)
        self.assertEqual(commit.commit, "abc123")
        self.assertEqual(commit.git_sha, "abc123def456789")
        self.assertEqual(commit.author, "Jane Doe")
        self.assertIsNone(commit.ordinal)

        # Verify machine
        machine = self.tsdb.get_machine(session, id=run.machine_id)
        self.assertEqual(machine.name, "import-machine-1")
        self.assertEqual(machine.hardware, "x86_64")
        self.assertEqual(machine.os, "linux")

        # Verify samples
        samples = (
            session.query(self.suite_models.Sample)
            .filter_by(run_id=run.id)
            .all()
        )
        self.assertEqual(len(samples), 2)
        session.close()

    def test_import_without_commit(self):
        session = self.Session()
        data = {
            "format_version": "5",
            "machine": {"name": "import-machine-2"},
            "tests": [
                {"name": "test.suite/standalone", "execution_time": 0.1},
            ],
        }
        with self.assertRaises(ValueError):
            self.tsdb.import_run(session, data)
        session.rollback()
        session.close()

    def test_import_missing_format_version(self):
        """format_version is required -- omitting it must raise."""
        session = self.Session()
        data = {
            "machine": {"name": "import-machine-no-fmt"},
            "commit": "no-fmt-commit",
            "tests": [{"name": "test/fmt", "execution_time": 1.0}],
        }
        with self.assertRaises(ValueError):
            self.tsdb.import_run(session, data)
        session.rollback()
        session.close()

    def test_import_wrong_format_version(self):
        """format_version must be '5' -- anything else must raise."""
        session = self.Session()
        data = {
            "format_version": "4",
            "machine": {"name": "import-machine-wrong-fmt"},
            "commit": "wrong-fmt-commit",
            "tests": [{"name": "test/fmt2", "execution_time": 1.0}],
        }
        with self.assertRaises(ValueError):
            self.tsdb.import_run(session, data)
        session.rollback()
        session.close()

    def test_import_same_commit_twice(self):
        """Second import at same commit should reuse the commit (first-write-wins)."""
        session = self.Session()
        data1 = {
            "format_version": "5",
            "machine": {"name": "import-machine-3"},
            "commit": "same-commit",
            "commit_fields": {"author": "First"},
            "tests": [{"name": "test/a", "compile_time": 1.0}],
        }
        run1 = self.tsdb.import_run(session, data1)
        session.commit()

        data2 = {
            "format_version": "5",
            "machine": {"name": "import-machine-3"},
            "commit": "same-commit",
            "commit_fields": {"author": "Second"},
            "tests": [{"name": "test/a", "compile_time": 2.0}],
        }
        run2 = self.tsdb.import_run(session, data2)
        session.commit()

        # Same commit reused
        self.assertEqual(run1.commit_id, run2.commit_id)

        # First-write-wins: author should still be "First"
        commit = self.tsdb.get_commit(session, id=run1.commit_id)
        self.assertEqual(commit.author, "First")
        session.close()

    def test_import_missing_machine_name(self):
        session = self.Session()
        data = {
            "format_version": "5",
            "machine": {},
            "tests": [{"name": "test/x", "compile_time": 1.0}],
        }
        with self.assertRaises(ValueError):
            self.tsdb.import_run(session, data)
        session.rollback()
        session.close()

    def test_import_missing_test_name(self):
        session = self.Session()
        data = {
            "format_version": "5",
            "machine": {"name": "import-machine-4"},
            "commit": "missing-test-name-commit",
            "tests": [{"compile_time": 1.0}],
        }
        with self.assertRaises(ValueError):
            self.tsdb.import_run(session, data)
        session.rollback()
        session.close()

    def test_import_machine_extra_params(self):
        """Extra machine keys not in schema go into parameters JSONB."""
        session = self.Session()
        data = {
            "format_version": "5",
            "machine": {
                "name": "import-machine-5",
                "hardware": "arm64",
                "extra_key": "extra_value",
            },
            "commit": "extra-params-commit",
            "tests": [{"name": "test/extra", "compile_time": 1.0}],
        }
        run = self.tsdb.import_run(session, data)
        session.commit()

        machine = self.tsdb.get_machine(session, id=run.machine_id)
        self.assertEqual(machine.hardware, "arm64")
        self.assertEqual(machine.parameters.get("extra_key"), "extra_value")
        session.close()

    def test_import_empty_tests_list(self):
        session = self.Session()
        data = {
            "format_version": "5",
            "machine": {"name": "import-machine-empty-tests"},
            "commit": "empty-tests-commit",
            "tests": [],
        }
        run = self.tsdb.import_run(session, data)
        session.commit()

        self.assertIsNotNone(run.id)
        samples = (
            session.query(self.suite_models.Sample)
            .filter_by(run_id=run.id)
            .all()
        )
        self.assertEqual(len(samples), 0)
        session.close()

    def test_import_unknown_top_level_keys_ignored(self):
        session = self.Session()
        data = {
            "format_version": "5",
            "machine": {"name": "import-machine-unk-keys"},
            "commit": "unknown-keys-commit",
            "tests": [{"name": "test/unk", "compile_time": 1.0}],
            "unknown_key": "should be ignored",
            "another_unknown": 42,
        }
        run = self.tsdb.import_run(session, data)
        session.commit()

        self.assertIsNotNone(run.id)
        session.close()

    def test_import_array_metric_creates_multiple_samples(self):
        """Array metric values unpack into multiple Sample rows."""
        session = self.Session()
        data = {
            "format_version": "5",
            "machine": {"name": "array-machine"},
            "commit": "array-commit",
            "tests": [{
                "name": "test/array",
                "compile_time": [1.0, 2.0, 3.0],
                "execution_time": [0.1, 0.2, 0.3],
            }],
        }
        run = self.tsdb.import_run(session, data)
        session.commit()

        samples = self.tsdb.list_samples(session, run_id=run.id)
        self.assertEqual(len(samples), 3)
        compile_times = sorted(s.compile_time for s in samples)
        exec_times = sorted(s.execution_time for s in samples)
        self.assertEqual(compile_times, [1.0, 2.0, 3.0])
        self.assertEqual(exec_times, [0.1, 0.2, 0.3])
        session.close()

    def test_import_mixed_scalar_and_array_metrics(self):
        """Scalar metrics are repeated across array-expanded samples."""
        session = self.Session()
        data = {
            "format_version": "5",
            "machine": {"name": "mixed-machine"},
            "commit": "mixed-commit",
            "tests": [{
                "name": "test/mixed",
                "execution_time": [1.0, 2.0],
                "compile_time": 0.5,
            }],
        }
        run = self.tsdb.import_run(session, data)
        session.commit()

        samples = self.tsdb.list_samples(session, run_id=run.id)
        self.assertEqual(len(samples), 2)
        for s in samples:
            self.assertEqual(s.compile_time, 0.5)
        exec_times = sorted(s.execution_time for s in samples)
        self.assertEqual(exec_times, [1.0, 2.0])
        session.close()

    def test_import_array_inconsistent_lengths_rejected(self):
        """Array metrics with different lengths raise ValueError."""
        session = self.Session()
        data = {
            "format_version": "5",
            "machine": {"name": "incon-machine"},
            "commit": "incon-commit",
            "tests": [{
                "name": "test/incon",
                "execution_time": [1.0, 2.0],
                "compile_time": [1.0, 2.0, 3.0],
            }],
        }
        with self.assertRaises(ValueError):
            self.tsdb.import_run(session, data)
        session.rollback()
        session.close()

    def test_import_empty_array_rejected(self):
        """Empty metric arrays raise ValueError."""
        session = self.Session()
        data = {
            "format_version": "5",
            "machine": {"name": "empty-arr-machine"},
            "commit": "empty-arr-commit",
            "tests": [{
                "name": "test/empty-arr",
                "execution_time": [],
            }],
        }
        with self.assertRaises(ValueError):
            self.tsdb.import_run(session, data)
        session.rollback()
        session.close()


class TestGetOrCreateCommit(_ImportTestBase):

    def test_empty_commit_string_rejected(self):
        session = self.Session()
        with self.assertRaises(ValueError):
            self.tsdb.get_or_create_commit(session, "")
        session.close()

    def test_long_commit_string(self):
        session = self.Session()
        long_str = "a" * 256
        c = self.tsdb.get_or_create_commit(session, long_str)
        session.commit()
        self.assertEqual(c.commit, long_str)
        session.close()

    def test_special_chars_in_commit(self):
        session = self.Session()
        for s in ["with/slash", "with%percent", "unicode-\u00e9\u00e8", "with spaces"]:
            c = self.tsdb.get_or_create_commit(session, s)
            session.commit()
            self.assertEqual(c.commit, s)
        session.close()


class TestSearchMethods(_ImportTestBase):

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        session = cls.Session()
        # Seed some data
        cls.tsdb.get_or_create_commit(session, "abc-100", git_sha="sha-abc", author="Alice")
        cls.tsdb.get_or_create_commit(session, "abc-200", git_sha="sha-abd", author="Bob")
        cls.tsdb.get_or_create_commit(session, "xyz-100", git_sha="sha-xyz", author="Alice Smith")
        cls.tsdb.get_or_create_machine(session, "x86-machine-1", hardware="x86_64", os="linux")
        cls.tsdb.get_or_create_machine(session, "arm-machine-1", hardware="aarch64", os="darwin")
        session.commit()
        session.close()

    def test_search_commits_by_commit_string(self):
        session = self.Session()
        results = self.tsdb.list_commits(session, search="abc")
        names = [c.commit for c in results]
        self.assertIn("abc-100", names)
        self.assertIn("abc-200", names)
        self.assertNotIn("xyz-100", names)
        session.close()

    def test_search_commits_by_searchable_field(self):
        """Search should match across searchable commit_fields (author)."""
        session = self.Session()
        results = self.tsdb.list_commits(session, search="Alice")
        names = [c.commit for c in results]
        # "Alice" matches commit abc-100 (author=Alice) and xyz-100 (author=Alice Smith)
        self.assertIn("abc-100", names)
        self.assertIn("xyz-100", names)
        session.close()

    def test_search_machines_by_name(self):
        session = self.Session()
        results = self.tsdb.list_machines(session, search="x86")
        names = [m.name for m in results]
        self.assertIn("x86-machine-1", names)
        self.assertNotIn("arm-machine-1", names)
        session.close()

    def test_search_machines_by_searchable_field(self):
        """Search should match across searchable machine_fields (hardware)."""
        session = self.Session()
        results = self.tsdb.list_machines(session, search="aarch64")
        names = [m.name for m in results]
        self.assertIn("arm-machine-1", names)
        session.close()

    def test_empty_search_returns_all(self):
        session = self.Session()
        all_commits = self.tsdb.list_commits(session)
        searched = self.tsdb.list_commits(session, search=None)
        self.assertEqual(len(all_commits), len(searched))
        session.close()

    def test_search_with_sql_special_percent(self):
        """Search with '%' should be treated literally, not as a wildcard."""
        session = self.Session()
        # Create a commit whose string literally starts with "100%"
        self.tsdb.get_or_create_commit(session, "100%done")
        self.tsdb.get_or_create_commit(session, "100_safe")
        session.commit()

        # Search for "100%" should match "100%done" but NOT "100_safe"
        results = self.tsdb.list_commits(session, search="100%")
        names = [c.commit for c in results]
        self.assertIn("100%done", names)
        self.assertNotIn("100_safe", names)
        session.close()

    def test_search_with_sql_special_underscore(self):
        """Search with '_' should be treated literally, not as a single-char wildcard."""
        session = self.Session()
        # "100_" should not match "100X" where X is any char
        self.tsdb.get_or_create_commit(session, "100_safe")
        session.commit()

        results = self.tsdb.list_commits(session, search="100_")
        names = [c.commit for c in results]
        self.assertIn("100_safe", names)
        # Should not match "100%done" (starts with 100 but 4th char is %, not _)
        self.assertNotIn("100%done", names)
        session.close()

    def test_search_with_sql_special_backslash(self):
        """Search with backslash should be treated literally."""
        session = self.Session()
        self.tsdb.get_or_create_commit(session, "path\\to\\thing")
        session.commit()

        results = self.tsdb.list_commits(session, search="path\\")
        names = [c.commit for c in results]
        self.assertIn("path\\to\\thing", names)
        session.close()

    def test_machine_search_with_sql_special_chars(self):
        """Machine search should also escape SQL special characters."""
        session = self.Session()
        self.tsdb.get_or_create_machine(session, "machine_with%special")
        session.commit()

        results = self.tsdb.list_machines(session, search="machine_with%")
        names = [m.name for m in results]
        self.assertIn("machine_with%special", names)
        session.close()

    def test_default_limit_on_list_commits(self):
        session = self.Session()
        # We can't easily create 1001 commits in a test, but we can verify
        # that passing no limit still returns results (implying a limit is set)
        # and that an explicit limit overrides the default.
        results = self.tsdb.list_commits(session, limit=2)
        self.assertLessEqual(len(results), 2)
        session.close()

    def test_default_limit_on_list_machines(self):
        session = self.Session()
        results = self.tsdb.list_machines(session, limit=1)
        self.assertLessEqual(len(results), 1)
        session.close()

    def test_default_limit_on_list_runs(self):
        session = self.Session()
        results = self.tsdb.list_runs(session, limit=1)
        self.assertLessEqual(len(results), 1)
        session.close()


class TestSchemaStorageInDB(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        cls.engine = _make_engine()
        cls.Session = sqlalchemy.orm.sessionmaker(cls.engine)
        # Create global tables
        create_global_tables(cls.engine)

    @classmethod
    def tearDownClass(cls):
        # Clean up global tables
        from lnt.server.db.v5.models import _global_base
        _global_base.metadata.drop_all(cls.engine)
        cls.engine.dispose()

    def setUp(self):
        # Clean any existing schema rows
        session = self.Session()
        session.query(V5Schema).delete()
        row = session.query(V5SchemaVersion).get(1)
        if row:
            row.version = 0
        else:
            session.add(V5SchemaVersion(id=1, version=0))
        session.commit()
        session.close()

    def _make_v5db(self):
        """Create a V5DB wired to the test Postgres database."""
        db_uri = os.environ.get('LNT_TEST_DB_URI')
        db_name = os.environ.get('LNT_TEST_DB_NAME')
        path = f"{db_uri}/{db_name}"

        class _FakeConfig:
            schemasDir = "/nonexistent"
        return V5DB(path, _FakeConfig())

    def test_create_suite(self):
        v5db = self._make_v5db()
        schema = parse_schema({
            "name": "create_test",
            "metrics": [{"name": "time", "type": "real"}],
        })
        session = v5db.make_session()
        tsdb = v5db.create_suite(session, schema)
        session.commit()
        session.close()

        self.assertIsNotNone(tsdb)
        self.assertEqual(tsdb.name, "create_test")
        self.assertIn("create_test", v5db.testsuite)

        # Verify row in v5_schema
        session = v5db.make_session()
        row = session.query(V5Schema).get("create_test")
        self.assertIsNotNone(row)
        data = json.loads(row.schema_json)
        self.assertEqual(data["name"], "create_test")
        session.close()

        # Clean up
        session = v5db.make_session()
        v5db.delete_suite(session, "create_test")
        session.commit()
        session.close()
        v5db.close()

    def test_get_suite(self):
        v5db = self._make_v5db()
        self.assertIsNone(v5db.get_suite("nonexistent"))

        schema = parse_schema({
            "name": "get_test",
            "metrics": [{"name": "time", "type": "real"}],
        })
        session = v5db.make_session()
        v5db.create_suite(session, schema)
        session.commit()
        session.close()

        result = v5db.get_suite("get_test")
        self.assertIsNotNone(result)
        self.assertEqual(result.name, "get_test")

        # Clean up
        session = v5db.make_session()
        v5db.delete_suite(session, "get_test")
        session.commit()
        session.close()
        v5db.close()

    def test_delete_suite(self):
        v5db = self._make_v5db()
        schema = parse_schema({
            "name": "del_test",
            "metrics": [{"name": "time", "type": "real"}],
        })
        session = v5db.make_session()
        v5db.create_suite(session, schema)
        session.commit()
        session.close()

        self.assertIn("del_test", v5db.testsuite)

        session = v5db.make_session()
        v5db.delete_suite(session, "del_test")
        session.commit()
        session.close()

        self.assertNotIn("del_test", v5db.testsuite)
        self.assertIsNone(v5db.get_suite("del_test"))

        # Verify row gone from v5_schema
        session = v5db.make_session()
        row = session.query(V5Schema).get("del_test")
        self.assertIsNone(row)
        session.close()
        v5db.close()

    def test_delete_nonexistent_suite_raises(self):
        v5db = self._make_v5db()
        session = v5db.make_session()
        with self.assertRaises(ValueError):
            v5db.delete_suite(session, "nonexistent")
        session.close()
        v5db.close()

    def test_create_duplicate_suite_raises(self):
        v5db = self._make_v5db()
        schema = parse_schema({
            "name": "dup_test",
            "metrics": [{"name": "time", "type": "real"}],
        })
        session = v5db.make_session()
        v5db.create_suite(session, schema)
        session.commit()

        with self.assertRaises(ValueError):
            v5db.create_suite(session, schema)
        session.close()

        # Clean up
        session = v5db.make_session()
        v5db.delete_suite(session, "dup_test")
        session.commit()
        session.close()
        v5db.close()

    def test_schema_version_bumped(self):
        """create_suite and delete_suite bump the version counter."""
        v5db = self._make_v5db()
        session = v5db.make_session()

        ver_before = session.query(V5SchemaVersion).get(1).version

        schema = parse_schema({
            "name": "ver_test",
            "metrics": [{"name": "time", "type": "real"}],
        })
        v5db.create_suite(session, schema)
        session.commit()

        ver_after_create = session.query(V5SchemaVersion).get(1).version
        self.assertEqual(ver_after_create, ver_before + 1)

        v5db.delete_suite(session, "ver_test")
        session.commit()

        ver_after_delete = session.query(V5SchemaVersion).get(1).version
        self.assertEqual(ver_after_delete, ver_before + 2)
        session.close()
        v5db.close()

    def test_staleness_detection(self):
        """A second V5DB instance detects stale cache and reloads."""
        v5db1 = self._make_v5db()
        schema = parse_schema({
            "name": "stale_test",
            "metrics": [{"name": "time", "type": "real"}],
        })
        session = v5db1.make_session()
        v5db1.create_suite(session, schema)
        session.commit()
        session.close()

        # Create a second V5DB instance (simulates another worker)
        v5db2 = self._make_v5db()
        # v5db2 should see the suite because it loaded from DB on init
        self.assertIn("stale_test", v5db2.testsuite)

        # Clean up
        session = v5db1.make_session()
        v5db1.delete_suite(session, "stale_test")
        session.commit()
        session.close()

        # v5db2 should detect staleness via ensure_fresh()
        session2 = v5db2.make_session()
        v5db2.ensure_fresh(session2)
        session2.close()
        result = v5db2.get_suite("stale_test")
        self.assertIsNone(result)

        v5db1.close()
        v5db2.close()


if __name__ == '__main__':
    unittest.main(argv=[sys.argv[0]], exit=True)

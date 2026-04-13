# RUN: rm -rf %t.instance %t.pg.log
# RUN: %{utils}/with_postgres.sh %t.pg.log \
# RUN:     python %s
# END.

import datetime
import os
import sys
import unittest

import sqlalchemy
import sqlalchemy.exc

from lnt.server.db.v5.schema import parse_schema
from lnt.server.db.v5.models import create_suite_models


def _make_engine():
    db_uri = os.environ.get('LNT_TEST_DB_URI')
    db_name = os.environ.get('LNT_TEST_DB_NAME')
    if not db_uri or not db_name:
        raise unittest.SkipTest(
            "LNT_TEST_DB_URI / LNT_TEST_DB_NAME not set "
            "(run via with_postgres.sh)")
    return sqlalchemy.create_engine(f"{db_uri}/{db_name}")


def _test_schema():
    return parse_schema({
        "name": "t",
        "metrics": [
            {"name": "compile_time", "type": "real"},
            {"name": "execution_time", "type": "real"},
            {"name": "compile_status", "type": "status"},
        ],
        "commit_fields": [
            {"name": "git_sha", "searchable": True},
            {"name": "author", "searchable": True},
            {"name": "message", "type": "text"},
        ],
        "machine_fields": [
            {"name": "hardware", "searchable": True},
            {"name": "os", "searchable": True},
        ],
    })


class TestModelCreation(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        cls.engine = _make_engine()
        cls.schema = _test_schema()
        cls.models = create_suite_models(cls.schema)
        cls.models.base.metadata.create_all(cls.engine)
        cls.Session = sqlalchemy.orm.sessionmaker(cls.engine)

    @classmethod
    def tearDownClass(cls):
        cls.models.base.metadata.drop_all(cls.engine)
        cls.engine.dispose()

    def test_commit_table_exists(self):
        insp = sqlalchemy.inspect(self.engine)
        self.assertIn("t_Commit", insp.get_table_names())

    def test_commit_has_dynamic_columns(self):
        """Dynamic commit_fields should appear as columns."""
        insp = sqlalchemy.inspect(self.engine)
        cols = {c['name'] for c in insp.get_columns("t_Commit")}
        self.assertIn("git_sha", cols)
        self.assertIn("author", cols)
        self.assertIn("message", cols)

    def test_machine_table_has_parameters(self):
        insp = sqlalchemy.inspect(self.engine)
        cols = {c['name'] for c in insp.get_columns("t_Machine")}
        self.assertIn("parameters", cols)
        self.assertIn("hardware", cols)
        self.assertIn("os", cols)

    def test_sample_table_has_metric_columns(self):
        """Schema-defined metrics should appear as dynamic columns."""
        insp = sqlalchemy.inspect(self.engine)
        cols = {c['name'] for c in insp.get_columns("t_Sample")}
        self.assertIn("compile_time", cols)
        self.assertIn("execution_time", cols)
        self.assertIn("compile_status", cols)

    def test_all_tables_created(self):
        """All 8 per-suite tables should exist."""
        insp = sqlalchemy.inspect(self.engine)
        tables = set(insp.get_table_names())
        expected = {
            "t_Commit", "t_Machine", "t_Run", "t_Test",
            "t_Sample", "t_FieldChange", "t_Regression",
            "t_RegressionIndicator",
        }
        self.assertTrue(expected.issubset(tables), f"Missing: {expected - tables}")


class TestCommitCRUD(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        cls.engine = _make_engine()
        cls.schema = _test_schema()
        cls.models = create_suite_models(cls.schema)
        cls.models.base.metadata.drop_all(cls.engine)
        cls.models.base.metadata.create_all(cls.engine)
        cls.Session = sqlalchemy.orm.sessionmaker(cls.engine)

    @classmethod
    def tearDownClass(cls):
        cls.models.base.metadata.drop_all(cls.engine)
        cls.engine.dispose()

    def test_create_commit(self):
        session = self.Session()
        c = self.models.Commit()
        c.commit = "abc123"
        c.git_sha = "abc123def456"
        c.author = "Jane"
        session.add(c)
        session.commit()
        self.assertIsNotNone(c.id)
        self.assertIsNone(c.ordinal)  # ordinal always NULL on creation
        session.close()

    def test_unique_commit_string(self):
        """Duplicate commit strings should raise IntegrityError."""
        session = self.Session()
        c1 = self.models.Commit()
        c1.commit = "unique_test_1"
        session.add(c1)
        session.commit()

        c2 = self.models.Commit()
        c2.commit = "unique_test_1"
        session.add(c2)
        with self.assertRaises(sqlalchemy.exc.IntegrityError):
            session.commit()
        session.rollback()
        session.close()

    def test_ordinal_unique(self):
        session = self.Session()
        c1 = self.models.Commit()
        c1.commit = "ord_test_1"
        c1.ordinal = 42
        session.add(c1)
        session.commit()

        c2 = self.models.Commit()
        c2.commit = "ord_test_2"
        c2.ordinal = 42
        session.add(c2)
        with self.assertRaises(sqlalchemy.exc.IntegrityError):
            session.commit()
        session.rollback()
        session.close()

    def test_ordinal_nullable(self):
        """Ordinal can be NULL (multiple commits with NULL ordinal OK)."""
        session = self.Session()
        for i in range(3):
            c = self.models.Commit()
            c.commit = f"null_ord_{i}"
            session.add(c)
        session.commit()

        nulls = (
            session.query(self.models.Commit)
            .filter(self.models.Commit.commit.like("null_ord_%"))
            .all()
        )
        self.assertEqual(len(nulls), 3)
        for c in nulls:
            self.assertIsNone(c.ordinal)
        session.close()


class TestMachineCRUD(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        cls.engine = _make_engine()
        cls.schema = _test_schema()
        cls.models = create_suite_models(cls.schema)
        cls.models.base.metadata.drop_all(cls.engine)
        cls.models.base.metadata.create_all(cls.engine)
        cls.Session = sqlalchemy.orm.sessionmaker(cls.engine)

    @classmethod
    def tearDownClass(cls):
        cls.models.base.metadata.drop_all(cls.engine)
        cls.engine.dispose()

    def test_create_machine(self):
        session = self.Session()
        m = self.models.Machine()
        m.name = "test-machine-1"
        m.parameters = {"key": "value"}
        m.hardware = "x86_64"
        m.os = "linux"
        session.add(m)
        session.commit()
        self.assertIsNotNone(m.id)
        session.close()

    def test_machine_name_unique(self):
        session = self.Session()
        m1 = self.models.Machine()
        m1.name = "unique-machine"
        m1.parameters = {}
        session.add(m1)
        session.commit()

        m2 = self.models.Machine()
        m2.name = "unique-machine"
        m2.parameters = {}
        session.add(m2)
        with self.assertRaises(sqlalchemy.exc.IntegrityError):
            session.commit()
        session.rollback()
        session.close()

    def test_parameters_default_empty(self):
        """Machine parameters should default to empty dict on the server side."""
        session = self.Session()
        m = self.models.Machine()
        m.name = "default-params-machine"
        session.add(m)
        session.commit()

        fetched = session.query(self.models.Machine).filter_by(
            name="default-params-machine").one()
        self.assertEqual(fetched.parameters, {})
        session.close()

    def test_jsonb_nested_parameters(self):
        session = self.Session()
        m = self.models.Machine()
        m.name = "nested-params-machine"
        m.parameters = {
            "config": {"threads": 4, "flags": ["-O2", "-march=native"]},
            "tags": ["ci", "nightly"],
        }
        session.add(m)
        session.commit()

        fetched = session.query(self.models.Machine).filter_by(
            name="nested-params-machine").one()
        self.assertEqual(fetched.parameters["config"]["threads"], 4)
        self.assertEqual(fetched.parameters["tags"], ["ci", "nightly"])
        session.close()


class TestRunCRUD(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        cls.engine = _make_engine()
        cls.schema = _test_schema()
        cls.models = create_suite_models(cls.schema)
        cls.models.base.metadata.drop_all(cls.engine)
        cls.models.base.metadata.create_all(cls.engine)
        cls.Session = sqlalchemy.orm.sessionmaker(cls.engine)

    @classmethod
    def tearDownClass(cls):
        cls.models.base.metadata.drop_all(cls.engine)
        cls.engine.dispose()

    def _make_machine(self, session, name="run-test-machine"):
        m = self.models.Machine()
        m.name = name
        m.parameters = {}
        session.add(m)
        session.flush()
        return m

    def _make_commit(self, session, commit_str="test-commit"):
        c = self.models.Commit()
        c.commit = commit_str
        session.add(c)
        session.flush()
        return c

    def test_create_run_with_commit(self):
        session = self.Session()
        machine = self._make_machine(session, "run-m-1")
        commit = self._make_commit(session, "run-c-1")
        run = self.models.Run()
        run.uuid = "aaaaaaaa-1111-2222-3333-444444444444"
        run.machine_id = machine.id
        run.commit_id = commit.id
        run.submitted_at = datetime.datetime(2024, 1, 1, 12, 0, 0)
        run.run_parameters = {"build": "Release"}
        session.add(run)
        session.commit()
        self.assertIsNotNone(run.id)
        self.assertEqual(run.commit_id, commit.id)
        session.close()

    def test_create_run_without_commit_fails(self):
        """Creating a run with NULL commit_id should raise IntegrityError."""
        session = self.Session()
        machine = self._make_machine(session, "run-m-2")
        run = self.models.Run()
        run.uuid = "bbbbbbbb-1111-2222-3333-444444444444"
        run.machine_id = machine.id
        run.commit_id = None
        run.submitted_at = datetime.datetime(2024, 1, 1, 12, 0, 0)
        run.run_parameters = {}
        session.add(run)
        with self.assertRaises(sqlalchemy.exc.IntegrityError):
            session.commit()
        session.rollback()
        session.close()

    def test_uuid_unique(self):
        session = self.Session()
        machine = self._make_machine(session, "run-m-3")
        commit = self._make_commit(session, "run-c-3")
        r1 = self.models.Run()
        r1.uuid = "cccccccc-1111-2222-3333-444444444444"
        r1.machine_id = machine.id
        r1.commit_id = commit.id
        r1.submitted_at = datetime.datetime.utcnow()
        r1.run_parameters = {}
        session.add(r1)
        session.commit()

        r2 = self.models.Run()
        r2.uuid = "cccccccc-1111-2222-3333-444444444444"  # same
        r2.machine_id = machine.id
        r2.commit_id = commit.id
        r2.submitted_at = datetime.datetime.utcnow()
        r2.run_parameters = {}
        session.add(r2)
        with self.assertRaises(sqlalchemy.exc.IntegrityError):
            session.commit()
        session.rollback()
        session.close()

    def test_run_parameters_jsonb(self):
        session = self.Session()
        machine = self._make_machine(session, "run-m-4")
        commit = self._make_commit(session, "run-c-4")
        run = self.models.Run()
        run.uuid = "dddddddd-1111-2222-3333-444444444444"
        run.machine_id = machine.id
        run.commit_id = commit.id
        run.submitted_at = datetime.datetime.utcnow()
        run.run_parameters = {
            "nested": {"key": [1, 2, 3]},
            "null_value": None,
        }
        session.add(run)
        session.commit()

        fetched = session.query(self.models.Run).filter_by(
            uuid="dddddddd-1111-2222-3333-444444444444").one()
        self.assertEqual(fetched.run_parameters["nested"]["key"], [1, 2, 3])
        self.assertIsNone(fetched.run_parameters["null_value"])
        session.close()


class TestSampleCreation(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        cls.engine = _make_engine()
        cls.schema = _test_schema()
        cls.models = create_suite_models(cls.schema)
        cls.models.base.metadata.drop_all(cls.engine)
        cls.models.base.metadata.create_all(cls.engine)
        cls.Session = sqlalchemy.orm.sessionmaker(cls.engine)

    @classmethod
    def tearDownClass(cls):
        cls.models.base.metadata.drop_all(cls.engine)
        cls.engine.dispose()

    def test_create_sample_with_metrics(self):
        session = self.Session()

        m = self.models.Machine()
        m.name = "sample-machine"
        m.parameters = {}
        session.add(m)
        session.flush()

        c = self.models.Commit()
        c.commit = "sample-commit"
        session.add(c)
        session.flush()

        t = self.models.Test()
        t.name = "test.suite/benchmark"
        session.add(t)
        session.flush()

        r = self.models.Run()
        r.uuid = "sample-run-uuid-00000000000000000"[:36]
        r.machine_id = m.id
        r.commit_id = c.id
        r.submitted_at = datetime.datetime.utcnow()
        r.run_parameters = {}
        session.add(r)
        session.flush()

        s = self.models.Sample()
        s.run_id = r.id
        s.test_id = t.id
        s.compile_time = 1.5
        s.execution_time = 0.3
        s.compile_status = 0
        session.add(s)
        session.commit()

        fetched = session.query(self.models.Sample).filter_by(run_id=r.id).one()
        self.assertAlmostEqual(fetched.compile_time, 1.5)
        self.assertAlmostEqual(fetched.execution_time, 0.3)
        self.assertEqual(fetched.compile_status, 0)
        session.close()

    def test_test_name_unique(self):
        session = self.Session()
        t1 = self.models.Test()
        t1.name = "unique-test"
        session.add(t1)
        session.commit()

        t2 = self.models.Test()
        t2.name = "unique-test"
        session.add(t2)
        with self.assertRaises(sqlalchemy.exc.IntegrityError):
            session.commit()
        session.rollback()
        session.close()


class TestFieldChangeAndRegression(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        cls.engine = _make_engine()
        cls.schema = _test_schema()
        cls.models = create_suite_models(cls.schema)
        cls.models.base.metadata.drop_all(cls.engine)
        cls.models.base.metadata.create_all(cls.engine)
        cls.Session = sqlalchemy.orm.sessionmaker(cls.engine)

    @classmethod
    def tearDownClass(cls):
        cls.models.base.metadata.drop_all(cls.engine)
        cls.engine.dispose()

    def _setup(self, session, suffix=""):
        m = self.models.Machine()
        m.name = f"fc-machine{suffix}"
        m.parameters = {}
        session.add(m)

        t = self.models.Test()
        t.name = f"fc-test{suffix}"
        session.add(t)

        c1 = self.models.Commit()
        c1.commit = f"fc-start{suffix}"
        session.add(c1)

        c2 = self.models.Commit()
        c2.commit = f"fc-end{suffix}"
        session.add(c2)

        session.flush()
        return m, t, c1, c2

    def test_create_field_change(self):
        session = self.Session()
        m, t, c1, c2 = self._setup(session, "-create")

        fc = self.models.FieldChange()
        fc.uuid = "fc-uuid-0000000000000000000000000"[:36]
        fc.machine_id = m.id
        fc.test_id = t.id
        fc.field_name = "compile_time"
        fc.start_commit_id = c1.id
        fc.end_commit_id = c2.id
        fc.old_value = 1.0
        fc.new_value = 2.0
        session.add(fc)
        session.commit()
        self.assertIsNotNone(fc.id)
        session.close()

    def test_regression_indicator_unique_constraint(self):
        """Duplicate (regression_id, field_change_id) should fail."""
        session = self.Session()
        m, t, c1, c2 = self._setup(session, "-uniq")

        fc = self.models.FieldChange()
        fc.uuid = "fc-uuid-uniq00000000000000000000"[:36]
        fc.machine_id = m.id
        fc.test_id = t.id
        fc.field_name = "execution_time"
        fc.start_commit_id = c1.id
        fc.end_commit_id = c2.id
        fc.old_value = 1.0
        fc.new_value = 2.0
        session.add(fc)
        session.flush()

        reg = self.models.Regression()
        reg.uuid = "reg-uuid-uniq0000000000000000000"[:36]
        reg.title = "Test Regression"
        reg.state = 0
        session.add(reg)
        session.flush()

        ri1 = self.models.RegressionIndicator()
        ri1.regression_id = reg.id
        ri1.field_change_id = fc.id
        session.add(ri1)
        session.flush()

        ri2 = self.models.RegressionIndicator()
        ri2.regression_id = reg.id
        ri2.field_change_id = fc.id
        session.add(ri2)
        with self.assertRaises(sqlalchemy.exc.IntegrityError):
            session.flush()
        session.rollback()
        session.close()


class TestCascadingDeletes(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        cls.engine = _make_engine()
        cls.schema = _test_schema()
        cls.models = create_suite_models(cls.schema)
        cls.models.base.metadata.drop_all(cls.engine)
        cls.models.base.metadata.create_all(cls.engine)
        cls.Session = sqlalchemy.orm.sessionmaker(cls.engine)

    @classmethod
    def tearDownClass(cls):
        cls.models.base.metadata.drop_all(cls.engine)
        cls.engine.dispose()

    def test_delete_run_keeps_commit(self):
        """Deleting a run should NOT delete the commit."""
        session = self.Session()

        m = self.models.Machine()
        m.name = "cascade-machine"
        m.parameters = {}
        session.add(m)

        c = self.models.Commit()
        c.commit = "cascade-commit"
        session.add(c)
        session.flush()

        r = self.models.Run()
        r.uuid = "cascade-run-uuid00000000000000000"[:36]
        r.machine_id = m.id
        r.commit_id = c.id
        r.submitted_at = datetime.datetime.utcnow()
        r.run_parameters = {}
        session.add(r)
        session.flush()

        run_id = r.id
        commit_id = c.id

        session.delete(r)
        session.commit()

        # Run is gone
        self.assertIsNone(
            session.query(self.models.Run).get(run_id))
        # Commit survives
        self.assertIsNotNone(
            session.query(self.models.Commit).get(commit_id))
        session.close()

    def test_delete_machine_cascades_to_runs(self):
        """Deleting a machine should cascade-delete its runs."""
        session = self.Session()

        m = self.models.Machine()
        m.name = "cascade-machine-2"
        m.parameters = {}
        session.add(m)

        c = self.models.Commit()
        c.commit = "cascade-machine-commit"
        session.add(c)
        session.flush()

        r = self.models.Run()
        r.uuid = "cascade-m-run-uuid0000000000000000"[:36]
        r.machine_id = m.id
        r.commit_id = c.id
        r.submitted_at = datetime.datetime.utcnow()
        r.run_parameters = {}
        session.add(r)
        session.flush()
        run_id = r.id

        session.delete(m)
        session.commit()

        self.assertIsNone(
            session.query(self.models.Run).get(run_id))
        session.close()


if __name__ == '__main__':
    unittest.main(argv=[sys.argv[0]], exit=True)

# RUN: rm -rf %t.instance %t.pg.log
# RUN: %{utils}/with_postgres.sh %t.pg.log \
# RUN:     python %s
# END.

import os
import sys
import unittest

import sqlalchemy
import sqlalchemy.exc
import sqlalchemy.orm

from lnt.server.db.v5.schema import parse_schema
from lnt.server.db.v5.models import create_suite_models
from lnt.server.db.v5 import V5TestSuiteDB, VALID_REGRESSION_STATES


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


class _CRUDTestBase(unittest.TestCase):
    """Shared setup for CRUD method tests."""

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

    @classmethod
    def tearDownClass(cls):
        cls.suite_models.base.metadata.drop_all(cls.engine)
        cls.engine.dispose()


class TestUpdateCommit(unittest.TestCase):

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

    @classmethod
    def tearDownClass(cls):
        cls.suite_models.base.metadata.drop_all(cls.engine)
        cls.engine.dispose()

    def test_set_ordinal(self):
        session = self.Session()
        c = self.tsdb.get_or_create_commit(session, "uc-ord-1")
        self.assertIsNone(c.ordinal)

        self.tsdb.update_commit(session, c, ordinal=100)
        session.commit()

        fetched = self.tsdb.get_commit(session, commit="uc-ord-1")
        self.assertEqual(fetched.ordinal, 100)
        session.close()

    def test_clear_ordinal(self):
        session = self.Session()
        c = self.tsdb.get_or_create_commit(session, "uc-ord-2")
        self.tsdb.update_commit(session, c, ordinal=200)
        session.commit()
        self.assertEqual(c.ordinal, 200)

        self.tsdb.update_commit(session, c, clear_ordinal=True)
        session.commit()

        fetched = self.tsdb.get_commit(session, commit="uc-ord-2")
        self.assertIsNone(fetched.ordinal)
        session.close()

    def test_set_metadata(self):
        session = self.Session()
        c = self.tsdb.get_or_create_commit(session, "uc-meta-1")
        self.assertIsNone(c.author)

        self.tsdb.update_commit(session, c, author="Alice")
        session.commit()

        fetched = self.tsdb.get_commit(session, commit="uc-meta-1")
        self.assertEqual(fetched.author, "Alice")
        session.close()

    def test_overwrite_metadata(self):
        session = self.Session()
        c = self.tsdb.get_or_create_commit(session, "uc-meta-2", author="Bob")
        session.commit()
        self.assertEqual(c.author, "Bob")

        self.tsdb.update_commit(session, c, author="Charlie")
        session.commit()

        fetched = self.tsdb.get_commit(session, commit="uc-meta-2")
        self.assertEqual(fetched.author, "Charlie")
        session.close()

    def test_set_ordinal_and_metadata_together(self):
        session = self.Session()
        c = self.tsdb.get_or_create_commit(session, "uc-both-1")
        self.tsdb.update_commit(session, c, ordinal=300, author="Dave")
        session.commit()

        fetched = self.tsdb.get_commit(session, commit="uc-both-1")
        self.assertEqual(fetched.ordinal, 300)
        self.assertEqual(fetched.author, "Dave")
        session.close()

    def test_unknown_metadata_ignored(self):
        """update_commit ignores keywords that are not in commit_fields."""
        session = self.Session()
        c = self.tsdb.get_or_create_commit(session, "uc-ignore-1")
        # Should not raise
        self.tsdb.update_commit(session, c, nonexistent_field="value")
        session.commit()
        session.close()


class TestFieldChangeCRUD(unittest.TestCase):

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

    @classmethod
    def tearDownClass(cls):
        cls.suite_models.base.metadata.drop_all(cls.engine)
        cls.engine.dispose()

    def test_field_change_crud(self):
        session = self.Session()
        machine = self.tsdb.get_or_create_machine(session, "fc-crud-m")
        test = self.tsdb.get_or_create_test(session, "fc-crud-test")
        c1 = self.tsdb.get_or_create_commit(session, "fc-crud-c1")
        c2 = self.tsdb.get_or_create_commit(session, "fc-crud-c2")

        fc = self.tsdb.create_field_change(
            session, machine, test, "execution_time", c1, c2, 1.0, 2.0)
        session.commit()

        # Fetch by uuid
        fetched = self.tsdb.get_field_change(session, uuid=fc.uuid)
        self.assertIsNotNone(fetched)
        self.assertEqual(fetched.field_name, "execution_time")
        self.assertEqual(fetched.old_value, 1.0)
        self.assertEqual(fetched.new_value, 2.0)

        # List
        all_fcs = self.tsdb.list_field_changes(session, machine=machine)
        self.assertGreater(len(all_fcs), 0)
        session.close()

    def test_regression_crud(self):
        session = self.Session()
        machine = self.tsdb.get_or_create_machine(session, "reg-crud-m")
        test = self.tsdb.get_or_create_test(session, "reg-crud-test")
        c1 = self.tsdb.get_or_create_commit(session, "reg-crud-c1")
        c2 = self.tsdb.get_or_create_commit(session, "reg-crud-c2")
        fc = self.tsdb.create_field_change(
            session, machine, test, "execution_time", c1, c2, 1.0, 3.0)
        session.flush()

        reg = self.tsdb.create_regression(
            session, "Perf regression", [fc.id], bug="BUG-123", state=0)
        session.commit()
        self.assertIsNotNone(reg.uuid)

        # Update
        self.tsdb.update_regression(
            session, reg, title="Updated title", state=1)
        session.commit()
        fetched = self.tsdb.get_regression(session, uuid=reg.uuid)
        self.assertEqual(fetched.title, "Updated title")
        self.assertEqual(fetched.state, 1)

        # List
        all_regs = self.tsdb.list_regressions(session)
        self.assertGreater(len(all_regs), 0)

        # Delete
        reg_id = reg.id
        self.tsdb.delete_regression(session, reg_id)
        session.commit()
        self.assertIsNone(self.tsdb.get_regression(session, id=reg_id))
        session.close()

    def test_regression_with_empty_field_change_ids(self):
        session = self.Session()
        reg = self.tsdb.create_regression(
            session, "Empty regression", [], state=0)
        session.commit()

        self.assertIsNotNone(reg.id)
        self.assertIsNotNone(reg.uuid)

        # Verify no indicators were created
        indicators = (
            session.query(self.tsdb.RegressionIndicator)
            .filter_by(regression_id=reg.id)
            .all()
        )
        self.assertEqual(len(indicators), 0)

        # Cleanup
        self.tsdb.delete_regression(session, reg.id)
        session.commit()
        session.close()


class TestDeleteCommit(unittest.TestCase):
    """Deletion cascades to runs/samples but is blocked by FieldChanges."""

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

    @classmethod
    def tearDownClass(cls):
        cls.suite_models.base.metadata.drop_all(cls.engine)
        cls.engine.dispose()

    def test_delete_commit_cascades_to_runs_and_samples(self):
        session = self.Session()
        machine = self.tsdb.get_or_create_machine(session, "del-commit-m")
        commit = self.tsdb.get_or_create_commit(session, "del-commit-c1")
        test = self.tsdb.get_or_create_test(session, "del-commit-test")
        run = self.tsdb.create_run(
            session, machine, commit=commit)
        self.tsdb.create_samples(session, run, [{
            "test_id": test.id,
            "execution_time": 1.0,
        }])
        session.flush()

        commit_id = commit.id
        run_id = run.id

        self.tsdb.delete_commit(session, commit_id)
        session.commit()

        # Commit, run, and samples are gone
        self.assertIsNone(
            session.query(self.tsdb.Commit).get(commit_id))
        self.assertIsNone(
            session.query(self.tsdb.Run).get(run_id))
        samples = (
            session.query(self.tsdb.Sample)
            .filter_by(run_id=run_id)
            .all()
        )
        self.assertEqual(len(samples), 0)
        session.close()

    def test_delete_commit_blocked_by_field_changes(self):
        """Cannot delete a commit referenced by FieldChanges."""
        session = self.Session()
        machine = self.tsdb.get_or_create_machine(session, "del-commit-m2")
        test = self.tsdb.get_or_create_test(session, "del-commit-test2")
        c1 = self.tsdb.get_or_create_commit(session, "del-commit-fc-c1")
        c2 = self.tsdb.get_or_create_commit(session, "del-commit-fc-c2")

        self.tsdb.create_field_change(
            session, machine, test, "execution_time", c1, c2, 1.0, 2.0)
        session.flush()

        # Cannot delete c1 (start_commit_id)
        with self.assertRaises(ValueError):
            self.tsdb.delete_commit(session, c1.id)

        # Cannot delete c2 (end_commit_id)
        with self.assertRaises(ValueError):
            self.tsdb.delete_commit(session, c2.id)

        session.close()

    def test_delete_nonexistent_commit(self):
        session = self.Session()
        self.tsdb.delete_commit(session, 999999)
        session.close()


class TestGetAndListTests(_CRUDTestBase):

    def test_get_test_by_name(self):
        session = self.Session()
        self.tsdb.get_or_create_test(session, "get-test-1")
        session.commit()

        fetched = self.tsdb.get_test(session, name="get-test-1")
        self.assertIsNotNone(fetched)
        self.assertEqual(fetched.name, "get-test-1")
        session.close()

    def test_get_test_by_id(self):
        session = self.Session()
        t = self.tsdb.get_or_create_test(session, "get-test-2")
        session.commit()

        fetched = self.tsdb.get_test(session, id=t.id)
        self.assertIsNotNone(fetched)
        self.assertEqual(fetched.name, "get-test-2")
        session.close()

    def test_get_test_not_found(self):
        session = self.Session()
        self.assertIsNone(self.tsdb.get_test(session, name="nonexistent"))
        session.close()

    def test_get_test_no_args_raises(self):
        session = self.Session()
        with self.assertRaises(ValueError):
            self.tsdb.get_test(session)
        session.close()

    def test_list_tests(self):
        session = self.Session()
        self.tsdb.get_or_create_test(session, "list-test-a")
        self.tsdb.get_or_create_test(session, "list-test-b")
        session.commit()

        results = self.tsdb.list_tests(session)
        names = [t.name for t in results]
        self.assertIn("list-test-a", names)
        self.assertIn("list-test-b", names)
        session.close()

    def test_list_tests_with_search(self):
        session = self.Session()
        self.tsdb.get_or_create_test(session, "search-test-alpha")
        self.tsdb.get_or_create_test(session, "search-test-beta")
        self.tsdb.get_or_create_test(session, "other-test")
        session.commit()

        results = self.tsdb.list_tests(session, search="search-test")
        names = [t.name for t in results]
        self.assertIn("search-test-alpha", names)
        self.assertIn("search-test-beta", names)
        self.assertNotIn("other-test", names)
        session.close()

    def test_list_tests_with_limit(self):
        session = self.Session()
        results = self.tsdb.list_tests(session, limit=1)
        self.assertLessEqual(len(results), 1)
        session.close()


class TestListSamples(_CRUDTestBase):

    def test_list_samples_by_run(self):
        session = self.Session()
        machine = self.tsdb.get_or_create_machine(session, "ls-m")
        commit = self.tsdb.get_or_create_commit(session, "ls-c")
        test = self.tsdb.get_or_create_test(session, "ls-test")
        run = self.tsdb.create_run(session, machine, commit=commit)
        self.tsdb.create_samples(session, run, [
            {"test_id": test.id, "execution_time": 1.0},
        ])
        session.commit()

        results = self.tsdb.list_samples(session, run_id=run.id)
        self.assertEqual(len(results), 1)
        self.assertAlmostEqual(results[0].execution_time, 1.0)
        session.close()

    def test_list_samples_by_test(self):
        session = self.Session()
        machine = self.tsdb.get_or_create_machine(session, "ls-m2")
        commit = self.tsdb.get_or_create_commit(session, "ls-c2")
        test_a = self.tsdb.get_or_create_test(session, "ls-test-a")
        test_b = self.tsdb.get_or_create_test(session, "ls-test-b")
        run = self.tsdb.create_run(session, machine, commit=commit)
        self.tsdb.create_samples(session, run, [
            {"test_id": test_a.id, "execution_time": 1.0},
            {"test_id": test_b.id, "execution_time": 2.0},
        ])
        session.commit()

        results = self.tsdb.list_samples(session, test_id=test_a.id)
        test_ids = [s.test_id for s in results]
        self.assertTrue(all(tid == test_a.id for tid in test_ids))
        session.close()

    def test_list_samples_empty(self):
        session = self.Session()
        results = self.tsdb.list_samples(session, run_id=999999)
        self.assertEqual(len(results), 0)
        session.close()


class TestUpdateMachine(_CRUDTestBase):

    def test_update_machine_name(self):
        session = self.Session()
        m = self.tsdb.get_or_create_machine(session, "upd-m-1")
        session.commit()

        self.tsdb.update_machine(session, m, name="upd-m-1-renamed")
        session.commit()

        self.assertEqual(m.name, "upd-m-1-renamed")
        fetched = self.tsdb.get_machine(session, name="upd-m-1-renamed")
        self.assertIsNotNone(fetched)
        session.close()

    def test_update_machine_fields(self):
        session = self.Session()
        m = self.tsdb.get_or_create_machine(session, "upd-m-2", hardware="x86")
        session.commit()
        self.assertEqual(m.hardware, "x86")

        self.tsdb.update_machine(session, m, hardware="arm64")
        session.commit()

        fetched = self.tsdb.get_machine(session, name="upd-m-2")
        self.assertEqual(fetched.hardware, "arm64")
        session.close()

    def test_update_machine_parameters(self):
        session = self.Session()
        m = self.tsdb.get_or_create_machine(
            session, "upd-m-3", parameters={"old": "value"})
        session.commit()

        self.tsdb.update_machine(
            session, m, parameters={"new": "value"})
        session.commit()

        fetched = self.tsdb.get_machine(session, name="upd-m-3")
        self.assertEqual(fetched.parameters, {"new": "value"})
        session.close()

    def test_update_machine_ignores_unknown_fields(self):
        session = self.Session()
        m = self.tsdb.get_or_create_machine(session, "upd-m-4")
        session.commit()

        # Should not raise
        self.tsdb.update_machine(session, m, nonexistent_field="value")
        session.commit()
        session.close()


class TestDeleteFieldChange(_CRUDTestBase):

    def test_delete_field_change(self):
        session = self.Session()
        machine = self.tsdb.get_or_create_machine(session, "dfc-m")
        test = self.tsdb.get_or_create_test(session, "dfc-test")
        c1 = self.tsdb.get_or_create_commit(session, "dfc-c1")
        c2 = self.tsdb.get_or_create_commit(session, "dfc-c2")
        fc = self.tsdb.create_field_change(
            session, machine, test, "execution_time", c1, c2, 1.0, 2.0)
        session.commit()
        fc_id = fc.id

        self.tsdb.delete_field_change(session, fc_id)
        session.commit()

        self.assertIsNone(self.tsdb.get_field_change(session, id=fc_id))
        session.close()

    def test_delete_field_change_cascades_to_indicators(self):
        session = self.Session()
        machine = self.tsdb.get_or_create_machine(session, "dfc-m2")
        test = self.tsdb.get_or_create_test(session, "dfc-test2")
        c1 = self.tsdb.get_or_create_commit(session, "dfc-c3")
        c2 = self.tsdb.get_or_create_commit(session, "dfc-c4")
        fc = self.tsdb.create_field_change(
            session, machine, test, "execution_time", c1, c2, 1.0, 2.0)
        reg = self.tsdb.create_regression(
            session, "test reg", [fc.id], state=0)
        session.commit()

        fc_id = fc.id
        reg_id = reg.id

        # Delete field change -- should also remove the indicator
        self.tsdb.delete_field_change(session, fc_id)
        session.commit()

        indicators = (
            session.query(self.tsdb.RegressionIndicator)
            .filter_by(regression_id=reg_id)
            .all()
        )
        self.assertEqual(len(indicators), 0)
        session.close()

    def test_delete_nonexistent_field_change(self):
        session = self.Session()
        # Should not raise
        self.tsdb.delete_field_change(session, 999999)
        session.close()


class TestRegressionIndicatorManagement(_CRUDTestBase):

    def _make_fc(self, session, suffix=""):
        machine = self.tsdb.get_or_create_machine(session, f"ri-m{suffix}")
        test = self.tsdb.get_or_create_test(session, f"ri-test{suffix}")
        c1 = self.tsdb.get_or_create_commit(session, f"ri-c1{suffix}")
        c2 = self.tsdb.get_or_create_commit(session, f"ri-c2{suffix}")
        return self.tsdb.create_field_change(
            session, machine, test, "execution_time", c1, c2, 1.0, 2.0)

    def test_add_regression_indicator(self):
        session = self.Session()
        fc = self._make_fc(session, "-add")
        reg = self.tsdb.create_regression(session, "add-ind", [], state=0)
        session.flush()

        ri = self.tsdb.add_regression_indicator(session, reg, fc)
        session.commit()

        self.assertIsNotNone(ri.id)
        indicators = (
            session.query(self.tsdb.RegressionIndicator)
            .filter_by(regression_id=reg.id)
            .all()
        )
        self.assertEqual(len(indicators), 1)
        session.close()

    def test_add_duplicate_indicator_rejected(self):
        session = self.Session()
        fc = self._make_fc(session, "-dup")
        reg = self.tsdb.create_regression(session, "dup-ind", [fc.id], state=0)
        session.commit()

        # Adding the same indicator again should fail
        with self.assertRaises(sqlalchemy.exc.IntegrityError):
            self.tsdb.add_regression_indicator(session, reg, fc)
        session.rollback()
        session.close()

    def test_remove_regression_indicator(self):
        session = self.Session()
        fc = self._make_fc(session, "-rem")
        reg = self.tsdb.create_regression(session, "rem-ind", [fc.id], state=0)
        session.commit()

        removed = self.tsdb.remove_regression_indicator(
            session, reg.id, fc.id)
        session.commit()
        self.assertTrue(removed)

        indicators = (
            session.query(self.tsdb.RegressionIndicator)
            .filter_by(regression_id=reg.id)
            .all()
        )
        self.assertEqual(len(indicators), 0)
        session.close()

    def test_remove_nonexistent_indicator(self):
        session = self.Session()
        removed = self.tsdb.remove_regression_indicator(session, 999, 999)
        self.assertFalse(removed)
        session.close()


class TestRegressionStateValidation(_CRUDTestBase):

    def test_create_with_invalid_state(self):
        session = self.Session()
        with self.assertRaises(ValueError):
            self.tsdb.create_regression(session, "bad state", [], state=99)
        session.close()

    def test_update_with_invalid_state(self):
        session = self.Session()
        reg = self.tsdb.create_regression(
            session, "valid", [], state=0)
        session.commit()

        with self.assertRaises(ValueError):
            self.tsdb.update_regression(session, reg, state=-1)
        session.close()

    def test_all_valid_states_accepted(self):
        session = self.Session()
        for state_val in sorted(VALID_REGRESSION_STATES):
            reg = self.tsdb.create_regression(
                session, f"state-{state_val}", [], state=state_val)
            self.assertEqual(reg.state, state_val)
        session.commit()
        session.close()


if __name__ == '__main__':
    unittest.main(argv=[sys.argv[0]], exit=True)

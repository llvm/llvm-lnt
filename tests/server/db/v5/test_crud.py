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


class TestRegressionCRUD(_CRUDTestBase):

    def test_create_regression_with_indicators(self):
        """Create a regression with machine/test/metric indicators."""
        session = self.Session()
        machine = self.tsdb.get_or_create_machine(session, "reg-m")
        test = self.tsdb.get_or_create_test(session, "reg-test")
        session.flush()

        reg = self.tsdb.create_regression(
            session, "Perf regression",
            [{"machine_id": machine.id, "test_id": test.id,
              "metric": "execution_time"}],
            bug="BUG-123", state=0)
        session.commit()

        self.assertIsNotNone(reg.uuid)
        self.assertEqual(reg.title, "Perf regression")
        self.assertEqual(reg.bug, "BUG-123")
        self.assertEqual(reg.state, 0)
        self.assertIsNone(reg.notes)
        self.assertIsNone(reg.commit_id)

        indicators = (
            session.query(self.tsdb.RegressionIndicator)
            .filter_by(regression_id=reg.id)
            .all()
        )
        self.assertEqual(len(indicators), 1)
        self.assertEqual(indicators[0].machine_id, machine.id)
        self.assertEqual(indicators[0].test_id, test.id)
        self.assertEqual(indicators[0].metric, "execution_time")
        self.assertIsNotNone(indicators[0].uuid)
        session.close()

    def test_create_regression_with_notes_and_commit(self):
        session = self.Session()
        commit = self.tsdb.get_or_create_commit(session, "reg-commit-1")
        session.flush()

        reg = self.tsdb.create_regression(
            session, "Noted regression", [],
            notes="Caused by vectorizer change",
            commit=commit,
            state=1)
        session.commit()

        self.assertEqual(reg.notes, "Caused by vectorizer change")
        self.assertEqual(reg.commit_id, commit.id)
        session.close()

    def test_create_regression_with_empty_indicators(self):
        session = self.Session()
        reg = self.tsdb.create_regression(
            session, "Empty regression", [], state=0)
        session.commit()
        self.assertIsNotNone(reg.id)
        indicators = (
            session.query(self.tsdb.RegressionIndicator)
            .filter_by(regression_id=reg.id)
            .all()
        )
        self.assertEqual(len(indicators), 0)
        session.close()

    def test_update_regression_notes(self):
        session = self.Session()
        reg = self.tsdb.create_regression(
            session, "title", [], state=0)
        session.commit()

        self.tsdb.update_regression(
            session, reg, notes="New notes")
        session.commit()

        fetched = self.tsdb.get_regression(session, id=reg.id)
        self.assertEqual(fetched.notes, "New notes")
        session.close()

    def test_update_regression_commit(self):
        session = self.Session()
        commit = self.tsdb.get_or_create_commit(session, "upd-reg-c")
        reg = self.tsdb.create_regression(
            session, "title", [], state=0)
        session.commit()

        self.tsdb.update_regression(
            session, reg, commit=commit)
        session.commit()
        self.assertEqual(reg.commit_id, commit.id)

        self.tsdb.update_regression(
            session, reg, commit=None)
        session.commit()
        self.assertIsNone(reg.commit_id)
        session.close()

    def test_update_regression_state_and_title(self):
        session = self.Session()
        reg = self.tsdb.create_regression(
            session, "original", [], state=0)
        session.commit()

        self.tsdb.update_regression(
            session, reg, title="Updated", state=1)
        session.commit()

        fetched = self.tsdb.get_regression(session, uuid=reg.uuid)
        self.assertEqual(fetched.title, "Updated")
        self.assertEqual(fetched.state, 1)
        session.close()

    def test_delete_regression_cascades_to_indicators(self):
        session = self.Session()
        machine = self.tsdb.get_or_create_machine(session, "del-reg-m")
        test = self.tsdb.get_or_create_test(session, "del-reg-test")
        session.flush()

        reg = self.tsdb.create_regression(
            session, "to delete",
            [{"machine_id": machine.id, "test_id": test.id,
              "metric": "execution_time"}],
            state=0)
        session.commit()
        reg_id = reg.id

        self.tsdb.delete_regression(session, reg_id)
        session.commit()

        self.assertIsNone(self.tsdb.get_regression(session, id=reg_id))
        indicators = (
            session.query(self.tsdb.RegressionIndicator)
            .filter_by(regression_id=reg_id)
            .all()
        )
        self.assertEqual(len(indicators), 0)
        session.close()

    def test_list_regressions_by_state(self):
        session = self.Session()
        self.tsdb.create_regression(
            session, "active-one", [], state=1)
        self.tsdb.create_regression(
            session, "detected-one", [], state=0)
        session.commit()

        active = self.tsdb.list_regressions(session, state=1)
        self.assertGreater(len(active), 0)
        self.assertTrue(
            all(r.state == 1 for r in active))
        session.close()

    def test_update_regression_clear_nullable_fields(self):
        """Verify _UNSET pattern allows clearing nullable fields to None."""
        cases = [
            ("notes", "some notes"),
            ("bug", "BUG-1"),
        ]
        for field, initial in cases:
            with self.subTest(field=field):
                session = self.Session()
                reg = self.tsdb.create_regression(
                    session, "title", [], **{field: initial}, state=0)
                session.commit()
                self.assertEqual(getattr(reg, field), initial)

                self.tsdb.update_regression(session, reg, **{field: None})
                session.commit()
                self.assertIsNone(getattr(reg, field))
                session.close()

    def test_update_regression_clear_title(self):
        """Verify _UNSET pattern allows clearing title to None."""
        session = self.Session()
        reg = self.tsdb.create_regression(
            session, "a title", [], state=0)
        session.commit()

        self.tsdb.update_regression(session, reg, title=None)
        session.commit()
        self.assertIsNone(reg.title)
        session.close()

    def test_old_state_values_rejected(self):
        """States 5 and 6 (old staged/detected_fixed) must be rejected."""
        session = self.Session()
        with self.assertRaises(ValueError):
            self.tsdb.create_regression(
                session, "old state", [], state=5)
        with self.assertRaises(ValueError):
            self.tsdb.create_regression(
                session, "old state", [], state=6)
        session.close()


class TestDeleteCommit(unittest.TestCase):
    """Deletion cascades to runs/samples but is blocked by Regressions."""

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

    def test_delete_commit_blocked_by_regression_commit_ref(self):
        """Cannot delete a commit referenced by a Regression's commit_id."""
        session = self.Session()
        commit = self.tsdb.get_or_create_commit(session, "del-commit-reg-c")
        session.flush()

        self.tsdb.create_regression(
            session, "blocking reg", [],
            commit=commit, state=0)
        session.flush()

        with self.assertRaises(ValueError):
            self.tsdb.delete_commit(session, commit.id)

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


class TestRegressionIndicatorManagement(_CRUDTestBase):

    def test_add_regression_indicator(self):
        session = self.Session()
        machine = self.tsdb.get_or_create_machine(session, "ri-add-m")
        test = self.tsdb.get_or_create_test(session, "ri-add-test")
        reg = self.tsdb.create_regression(
            session, "add-ind", [], state=0)
        session.flush()

        ri = self.tsdb.add_regression_indicator(
            session, reg, machine.id, test.id, "execution_time")
        session.commit()

        self.assertIsNotNone(ri.id)
        self.assertIsNotNone(ri.uuid)
        self.assertEqual(ri.machine_id, machine.id)
        self.assertEqual(ri.test_id, test.id)
        self.assertEqual(ri.metric, "execution_time")
        session.close()

    def test_add_duplicate_indicator_rejected(self):
        session = self.Session()
        machine = self.tsdb.get_or_create_machine(session, "ri-dup-m")
        test = self.tsdb.get_or_create_test(session, "ri-dup-test")
        reg = self.tsdb.create_regression(
            session, "dup-ind",
            [{"machine_id": machine.id, "test_id": test.id,
              "metric": "execution_time"}],
            state=0)
        session.commit()

        with self.assertRaises(sqlalchemy.exc.IntegrityError):
            self.tsdb.add_regression_indicator(
                session, reg, machine.id, test.id, "execution_time")
        session.rollback()
        session.close()

    def test_same_triple_on_different_regressions_ok(self):
        session = self.Session()
        machine = self.tsdb.get_or_create_machine(session, "ri-multi-m")
        test = self.tsdb.get_or_create_test(session, "ri-multi-test")
        reg1 = self.tsdb.create_regression(
            session, "reg1", [], state=0)
        reg2 = self.tsdb.create_regression(
            session, "reg2", [], state=0)
        session.flush()

        ri1 = self.tsdb.add_regression_indicator(
            session, reg1, machine.id, test.id, "execution_time")
        ri2 = self.tsdb.add_regression_indicator(
            session, reg2, machine.id, test.id, "execution_time")
        session.commit()

        self.assertIsNotNone(ri1.id)
        self.assertIsNotNone(ri2.id)
        session.close()

    def test_remove_regression_indicator_by_uuid(self):
        session = self.Session()
        machine = self.tsdb.get_or_create_machine(session, "ri-rem-m")
        test = self.tsdb.get_or_create_test(session, "ri-rem-test")
        reg = self.tsdb.create_regression(
            session, "rem-ind",
            [{"machine_id": machine.id, "test_id": test.id,
              "metric": "execution_time"}],
            state=0)
        session.commit()

        indicator = (
            session.query(self.tsdb.RegressionIndicator)
            .filter_by(regression_id=reg.id)
            .first()
        )
        removed = self.tsdb.remove_regression_indicator(
            session, reg.id, indicator.uuid)
        session.commit()
        self.assertTrue(removed)

        remaining = (
            session.query(self.tsdb.RegressionIndicator)
            .filter_by(regression_id=reg.id)
            .all()
        )
        self.assertEqual(len(remaining), 0)
        session.close()

    def test_remove_nonexistent_indicator(self):
        session = self.Session()
        removed = self.tsdb.remove_regression_indicator(
            session, 999, "nonexistent-uuid")
        self.assertFalse(removed)
        session.close()

    def test_remove_indicator_wrong_regression(self):
        """Indicator exists but belongs to a different regression."""
        session = self.Session()
        machine = self.tsdb.get_or_create_machine(session, "ri-wrong-m")
        test = self.tsdb.get_or_create_test(session, "ri-wrong-test")
        reg1 = self.tsdb.create_regression(
            session, "reg1",
            [{"machine_id": machine.id, "test_id": test.id,
              "metric": "execution_time"}],
            state=0)
        reg2 = self.tsdb.create_regression(
            session, "reg2", [], state=0)
        session.commit()

        indicator = (
            session.query(self.tsdb.RegressionIndicator)
            .filter_by(regression_id=reg1.id)
            .first()
        )
        # Try to remove reg1's indicator using reg2's id
        removed = self.tsdb.remove_regression_indicator(
            session, reg2.id, indicator.uuid)
        self.assertFalse(removed)
        session.close()

    def test_get_regression_indicator_by_uuid(self):
        session = self.Session()
        machine = self.tsdb.get_or_create_machine(session, "ri-get-m")
        test = self.tsdb.get_or_create_test(session, "ri-get-test")
        reg = self.tsdb.create_regression(
            session, "get-ind",
            [{"machine_id": machine.id, "test_id": test.id,
              "metric": "execution_time"}],
            state=0)
        session.commit()

        indicator = (
            session.query(self.tsdb.RegressionIndicator)
            .filter_by(regression_id=reg.id)
            .first()
        )
        fetched = self.tsdb.get_regression_indicator(
            session, uuid=indicator.uuid)
        self.assertEqual(fetched.id, indicator.id)
        session.close()

    def test_get_regression_indicator_requires_id_or_uuid(self):
        session = self.Session()
        with self.assertRaises(ValueError):
            self.tsdb.get_regression_indicator(session)
        session.close()

    def test_batch_add_indicators_silently_ignores_duplicates(self):
        session = self.Session()
        machine = self.tsdb.get_or_create_machine(session, "ri-batch-m")
        test = self.tsdb.get_or_create_test(session, "ri-batch-test")
        reg = self.tsdb.create_regression(
            session, "batch",
            [{"machine_id": machine.id, "test_id": test.id,
              "metric": "execution_time"}],
            state=0)
        session.commit()

        test2 = self.tsdb.get_or_create_test(session, "ri-batch-test2")
        session.flush()
        created = self.tsdb.add_regression_indicators_batch(
            session, reg,
            [
                {"machine_id": machine.id, "test_id": test.id,
                 "metric": "execution_time"},  # duplicate
                {"machine_id": machine.id, "test_id": test2.id,
                 "metric": "execution_time"},  # new
            ])
        session.commit()

        self.assertEqual(len(created), 1)
        self.assertEqual(created[0].test_id, test2.id)
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


class TestUnknownFieldRejection(_CRUDTestBase):
    """Unknown field/metric names must raise ValueError."""

    def test_get_or_create_commit_unknown_field(self):
        session = self.Session()
        with self.assertRaises(ValueError) as cm:
            self.tsdb.get_or_create_commit(
                session, "bad-commit", bogus_field="x")
        self.assertIn("bogus_field", str(cm.exception))
        session.close()

    def test_update_commit_unknown_field(self):
        session = self.Session()
        c = self.tsdb.get_or_create_commit(session, "uf-commit")
        with self.assertRaises(ValueError) as cm:
            self.tsdb.update_commit(session, c, nonexistent="x")
        self.assertIn("nonexistent", str(cm.exception))
        session.close()

    def test_get_or_create_machine_unknown_field(self):
        session = self.Session()
        with self.assertRaises(ValueError) as cm:
            self.tsdb.get_or_create_machine(
                session, "bad-machine", bad_field="x")
        self.assertIn("bad_field", str(cm.exception))
        session.close()

    def test_update_machine_unknown_field(self):
        session = self.Session()
        m = self.tsdb.get_or_create_machine(session, "uf-machine")
        with self.assertRaises(ValueError) as cm:
            self.tsdb.update_machine(session, m, no_such="x")
        self.assertIn("no_such", str(cm.exception))
        session.close()

    def test_create_samples_unknown_metric(self):
        session = self.Session()
        m = self.tsdb.get_or_create_machine(session, "uf-sample-m")
        c = self.tsdb.get_or_create_commit(session, "uf-sample-c")
        run = self.tsdb.create_run(session, m, commit=c)
        t = self.tsdb.get_or_create_test(session, "uf-test")
        with self.assertRaises(ValueError) as cm:
            self.tsdb.create_samples(session, run, [
                {"test_id": t.id, "executin_time": 1.0},
            ])
        self.assertIn("executin_time", str(cm.exception))
        session.close()


if __name__ == '__main__':
    unittest.main(argv=[sys.argv[0]], exit=True)

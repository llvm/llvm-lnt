# Check that the LNT REST JSON API is working.
# create temporary instance
# RUN: rm -rf %t.instance
# RUN: python %{shared_inputs}/create_temp_instance.py \
# RUN:     %s %{shared_inputs}/SmallInstance \
# RUN:     %t.instance %S/Inputs/V4Pages_extra_records.sql
#
# RUN: python %s %t.instance

import datetime
import logging
import sys
import unittest

from sqlalchemy import or_
from sqlalchemy.orm import joinedload

from lnt.server.config import Config
from lnt.server.db import v4db
from lnt.server.db.fieldchange import delete_fieldchange
from lnt.server.db.fieldchange import is_overlaping, identify_related_changes
from lnt.server.db.regression import rebuild_title, RegressionState
from lnt.server.db.rules import rule_update_fixed_regressions

logging.basicConfig(level=logging.DEBUG)


def _mkorder(session, ts, rev):
    order = ts.Order()
    order.llvm_project_revision = rev
    session.add(order)
    return order


class ChangeProcessingTests(unittest.TestCase):
    """Test fieldchange and regression building."""

    def setUp(self):
        """Bind to the LNT test instance."""

        self.db = v4db.V4DB("sqlite:///:memory:", Config.dummy_instance())
        session = self.session = self.db.make_session()

        # Get the test suite wrapper.
        ts_db = self.ts_db = self.db.testsuite['nts']

        order1234 = self.order1234 = _mkorder(session, ts_db, "1234")
        order1235 = self.order1235 = _mkorder(session, ts_db, "1235")
        order1236 = self.order1236 = _mkorder(session, ts_db, "1236")
        order1237 = self.order1237 = _mkorder(session, ts_db, "1237")
        order1238 = self.order1238 = _mkorder(session, ts_db, "1238")

        start_time = end_time = datetime.datetime.utcnow()
        machine = self.machine = ts_db.Machine("test-machine")
        session.add(machine)

        test = self.test = ts_db.Test("foo")
        session.add(test)

        machine2 = self.machine2 = ts_db.Machine("test-machine2")
        session.add(machine2)

        test2 = self.test2 = ts_db.Test("bar")
        session.add(test2)

        run = self.run = ts_db.Run(None, machine, order1235, start_time,
                                   end_time)
        session.add(run)

        run2 = self.run2 = ts_db.Run(None, machine2, order1235, start_time,
                                     end_time)
        session.add(run2)

        sample = ts_db.Sample(run, test, compile_time=1.0,
                              score=4.2)
        session.add(sample)

        a_field = self.a_field = list(sample.get_primary_fields())[0]
        self.a_field2 = list(sample.get_primary_fields())[1]

        field_change = self.field_change = ts_db.FieldChange(order1234,
                                                             order1236,
                                                             machine,
                                                             test,
                                                             a_field.id)
        field_change.run = run
        session.add(field_change)

        fc_mach2 = ts_db.FieldChange(order1234,
                                     order1236,
                                     machine2,
                                     test,
                                     a_field.id)
        fc_mach2.run = run2
        session.add(fc_mach2)

        field_change2 = self.field_change2 = ts_db.FieldChange(order1235, order1236, machine,
                                                               test,
                                                               a_field.id)

        field_change2.run = run
        session.add(field_change2)

        field_change3 = self.field_change3 = ts_db.FieldChange(order1237, order1238, machine,
                                                               test,
                                                               a_field.id)
        session.add(field_change3)

        regression = self.regression = ts_db.Regression("Regression of 1 benchmarks:", "PR1234",
                                                        RegressionState.DETECTED)
        session.add(self.regression)

        self.regression_indicator1 = ts_db.RegressionIndicator(regression,
                                                               field_change)
        self.regression_indicator2 = ts_db.RegressionIndicator(regression,
                                                               field_change2)

        session.add(self.regression_indicator1)
        session.add(self.regression_indicator2)

        # All the regressions we detected.
        self.regressions = [regression]
        session.commit()

    def tearDown(self):
        self.db.close()

    def test_startup(self):
        pass

    def test_change_grouping_criteria(self):
        session = self.session
        ts_db = self.ts_db

        # Check simple overlap checks work.
        self.assertTrue(is_overlaping(self.field_change, self.field_change2),
                        "Should be overlapping")
        self.assertFalse(is_overlaping(self.field_change, self.field_change3),
                         "Should not be overlapping")

        active_indicators = session.query(ts_db.RegressionIndicator) \
            .join(ts_db.Regression) \
            .filter(or_(ts_db.Regression.state == RegressionState.DETECTED,
                        ts_db.Regression.state == RegressionState.DETECTED_FIXED)) \
            .options(joinedload(ts_db.RegressionIndicator.field_change)) \
            .options(joinedload("field_change.start_order")) \
            .options(joinedload("field_change.end_order")) \
            .options(joinedload("field_change.test")) \
            .all()

        # Check non-overlapping changes are always False.
        ret, reg = identify_related_changes(session, ts_db, self.field_change3, active_indicators)

        self.assertFalse(ret, "Ranges don't overlap, should not match")
        self.regressions.append(reg)
        # Check a regression matches if all fields match.
        ret, _ = identify_related_changes(session, ts_db, self.field_change, active_indicators)
        self.assertTrue(ret, "Should Match.")

        field_change7 = ts_db.FieldChange(self.order1234,
                                          self.order1235,
                                          self.machine2,
                                          self.test2,
                                          self.a_field.id)
        session.add(field_change7)

        active_indicators = session.query(ts_db.RegressionIndicator) \
            .join(ts_db.Regression) \
            .filter(or_(ts_db.Regression.state == RegressionState.DETECTED,
                        ts_db.Regression.state == RegressionState.DETECTED_FIXED)) \
            .options(joinedload(ts_db.RegressionIndicator.field_change)) \
            .options(joinedload("field_change.start_order")) \
            .options(joinedload("field_change.end_order")) \
            .options(joinedload("field_change.test")) \
            .all()

        ret, reg = identify_related_changes(session, ts_db, field_change7, active_indicators)
        self.assertNotEquals(self.regression, reg)
        self.assertFalse(ret, "No match with different machine and tests.")
        self.regressions.append(reg)
        field_change4 = ts_db.FieldChange(self.order1234,
                                          self.order1235,
                                          self.machine2,
                                          self.test,
                                          self.a_field.id)

        # Check a regression matches if all fields match.
        ret, _ = identify_related_changes(session, ts_db, field_change4, active_indicators)
        self.assertTrue(ret, "Should Match with different machine.")

        field_change5 = ts_db.FieldChange(self.order1234,
                                          self.order1235,
                                          self.machine,
                                          self.test2,
                                          self.a_field.id)

        # Check a regression matches if all fields match.
        ret, _ = identify_related_changes(session, ts_db, field_change5, active_indicators)
        self.assertTrue(ret, "Should Match with different tests.")
        field_change6 = ts_db.FieldChange(self.order1234,
                                          self.order1235,
                                          self.machine,
                                          self.test,
                                          self.a_field2.id)

        # Check a regression matches if all fields match.
        ret, _ = identify_related_changes(session, ts_db, field_change6, active_indicators)
        self.assertTrue(ret, "Should Match with different fields.")

        session.commit()

        r2 = rebuild_title(session, ts_db, self.regression)
        expected_title = "Regression of 6 benchmarks: foo, bar"
        self.assertEquals(r2.title, expected_title)

    def test_regression_evolution(self):
        session = self.session
        ts_db = self.ts_db
        rule_update_fixed_regressions.regression_evolution(
            session, ts_db, self.run.id)

    def test_fc_deletion(self):
        session = self.session
        ts_db = self.ts_db
        delete_fieldchange(session, ts_db, self.field_change)
        delete_fieldchange(session, ts_db, self.field_change2)
        delete_fieldchange(session, ts_db, self.field_change3)

    def test_run_deletion(self):
        """Do the FC and RIs get cleaned up when runs are deleted?"""
        session = self.session
        ts_db = self.ts_db
        run_idsq = session.query(ts_db.Run.id).all()
        fc_ids = session.query(ts_db.FieldChange.id).all()
        ri_ids = session.query(ts_db.RegressionIndicator.id).all()

        run_ids = [row[0] for row in run_idsq]
        runs = session.query(ts_db.Run).filter(ts_db.Run.id.in_(run_ids)).all()
        for run in runs:
            session.delete(run)

        run_ids_new = session.query(ts_db.Run.id).all()
        fc_ids_new = session.query(ts_db.FieldChange.id).all()
        ri_ids_new = session.query(ts_db.RegressionIndicator.id).all()
        # Make sure there was some runs.
        self.assertNotEqual(len(run_idsq), 0)
        self.assertNotEqual(len(fc_ids), 0)
        self.assertNotEqual(len(ri_ids), 0)

        # Now make sure there were all deleted.
        self.assertEqual(len(run_ids_new), 0)

        # Not all the FCs are covered by the runs.
        self.assertEqual(len(fc_ids_new), 1)

        self.assertEqual(len(ri_ids_new), 0)


if __name__ == '__main__':
    unittest.main(argv=[sys.argv[0], ])

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

from lnt.server.config import Config
from lnt.server.db import v4db
from lnt.server.db.fieldchange import delete_fieldchange
from lnt.server.db.fieldchange import is_overlaping, identify_related_changes
from lnt.server.db.regression import rebuild_title, RegressionState
from lnt.server.db.rules import rule_update_fixed_regressions

logging.basicConfig(level=logging.DEBUG)


class ChangeProcessingTests(unittest.TestCase):
    """Test fieldchange and regression building."""

    def setUp(self):
        """Bind to the LNT test instance."""

        self.db = v4db.V4DB("sqlite:///:memory:", Config.dummy_instance(), echo=False)

        # Get the test suite wrapper.
        ts_db = self.ts_db = self.db.testsuite['nts']

        order1234 = self.order1234 = self._mkorder(ts_db, "1234")
        order1235 = self.order1235 = self._mkorder(ts_db, "1235")
        order1236 = self.order1236 = self._mkorder(ts_db, "1236")
        order1237 = self.order1237 = self._mkorder(ts_db, "1237")
        order1238 = self.order1238 = self._mkorder(ts_db, "1238")

        start_time = end_time = datetime.datetime.utcnow()
        machine = self.machine = ts_db.Machine("test-machine")
        ts_db.add(machine)

        test = self.test = ts_db.Test("foo")
        ts_db.add(test)

        machine2 = self.machine2 = ts_db.Machine("test-machine2")
        ts_db.add(machine2)

        test2 = self.test2 = ts_db.Test("bar")
        ts_db.add(test2)

        run = self.run = ts_db.Run(machine, order1235, start_time,
                                   end_time)
        ts_db.add(run)

        run2 = self.run2 = ts_db.Run(machine2, order1235, start_time,
                                     end_time)
        ts_db.add(run2)

        sample = ts_db.Sample(run, test, compile_time=1.0,
                              score=4.2)
        ts_db.add(sample)

        a_field = self.a_field = list(sample.get_primary_fields())[0]
        a_field2 = self.a_field2 = list(sample.get_primary_fields())[1]

        field_change = self.field_change = ts_db.FieldChange(order1234,
                                                             order1236,
                                                             machine,
                                                             test,
                                                             a_field)
        field_change.run = run
        ts_db.add(field_change)

        fc_mach2 = ts_db.FieldChange(order1234,
                                     order1236,
                                     machine2,
                                     test,
                                     a_field)
        fc_mach2.run = run2
        ts_db.add(fc_mach2)

        field_change2 = self.field_change2 = ts_db.FieldChange(order1235, order1236, machine,
                                                               test,
                                                               a_field)

        field_change2.run = run
        ts_db.add(field_change2)

        field_change3 = self.field_change3 = ts_db.FieldChange(order1237, order1238, machine,
                                                               test,
                                                               a_field)
        ts_db.add(field_change3)

        regression = self.regression = ts_db.Regression("Regression of 1 benchmarks:", "PR1234",
                                                        RegressionState.DETECTED)
        ts_db.add(self.regression)

        self.regression_indicator1 = ts_db.RegressionIndicator(regression,
                                                               field_change)
        self.regression_indicator2 = ts_db.RegressionIndicator(regression,
                                                               field_change2)

        ts_db.add(self.regression_indicator1)
        ts_db.add(self.regression_indicator2)

        # All the regressions we detected.
        self.regressions = [regression]
        ts_db.commit()

    def tearDown(self):
        self.db.close_all_engines()

    def _mkorder(self, ts, rev):
        order = ts.Order()
        order.llvm_project_revision = rev
        ts.add(order)
        return order

    def test_startup(self):
        pass

    def test_change_grouping_criteria(self):
        ts_db = self.ts_db

        # Check simple overlap checks work.
        self.assertTrue(is_overlaping(self.field_change, self.field_change2),
                        "Should be overlapping")
        self.assertFalse(is_overlaping(self.field_change, self.field_change3),
                         "Should not be overlapping")

        # Check non-overlapping changes are always False.
        ret, reg = identify_related_changes(ts_db, self.field_change3)

        self.assertFalse(ret, "Ranges don't overlap, should not match")
        self.regressions.append(reg)
        # Check a regression matches if all fields match.
        ret, _ = identify_related_changes(ts_db, self.field_change)
        self.assertTrue(ret, "Should Match.")

        field_change7 = ts_db.FieldChange(self.order1234,
                                          self.order1235,
                                          self.machine2,
                                          self.test2,
                                          self.a_field)
        ts_db.add(field_change7)
        ret, reg = identify_related_changes(ts_db, field_change7)
        self.assertNotEquals(self.regression, reg)
        self.assertFalse(ret, "No match with different machine and tests.")
        self.regressions.append(reg)
        field_change4 = ts_db.FieldChange(self.order1234,
                                          self.order1235,
                                          self.machine2,
                                          self.test,
                                          self.a_field)

        # Check a regression matches if all fields match.
        ret, _ = identify_related_changes(ts_db, field_change4)
        self.assertTrue(ret, "Should Match with different machine.")

        field_change5 = ts_db.FieldChange(self.order1234,
                                          self.order1235,
                                          self.machine,
                                          self.test2,
                                          self.a_field)

        # Check a regression matches if all fields match.
        ret, _ = identify_related_changes(ts_db, field_change5)
        self.assertTrue(ret, "Should Match with different tests.")
        field_change6 = ts_db.FieldChange(self.order1234,
                                          self.order1235,
                                          self.machine,
                                          self.test,
                                          self.a_field2)

        # Check a regression matches if all fields match.
        ret, _ = identify_related_changes(ts_db, field_change6)
        self.assertTrue(ret, "Should Match with different fields.")

        ts_db.commit()

        r2 = rebuild_title(ts_db, self.regression)
        EXPECTED_TITLE = "Regression of 6 benchmarks: foo, bar"
        self.assertEquals(r2.title, EXPECTED_TITLE)

    def test_regression_evolution(self):
        ts_db = self.ts_db
        rule_update_fixed_regressions.regression_evolution(ts_db, self.regressions)

    def test_fc_deletion(self):
        delete_fieldchange(self.ts_db, self.field_change)
        delete_fieldchange(self.ts_db, self.field_change2)
        delete_fieldchange(self.ts_db, self.field_change3)

    def test_run_deletion(self):
        """Do the FC and RIs get cleaned up when runs are deleted?"""
        ts_db = self.ts_db
        run_ids = ts_db.query(ts_db.Run.id).all()
        fc_ids = ts_db.query(ts_db.FieldChange.id).all()
        ri_ids = ts_db.query(ts_db.RegressionIndicator.id).all()

        ts_db.delete_runs([r[0] for r in run_ids])
        run_ids_new = ts_db.query(ts_db.Run.id).all()
        fc_ids_new = ts_db.query(ts_db.FieldChange.id).all()
        ri_ids_new = ts_db.query(ts_db.RegressionIndicator.id).all()
        # Make sure there was some runs.
        self.assertNotEqual(len(run_ids), 0)
        self.assertNotEqual(len(fc_ids), 0)
        self.assertNotEqual(len(ri_ids), 0)

        # Now make sure there were all deleted.
        self.assertEqual(len(run_ids_new), 0)

        # Not all the FCs are covered by the runs.
        self.assertEqual(len(fc_ids_new), 1)

        self.assertEqual(len(ri_ids_new), 0)


if __name__ == '__main__':
    unittest.main(argv=[sys.argv[0], ])

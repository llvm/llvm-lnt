# Check that the LNT REST JSON API is working.
# create temporary instance
# RUN: rm -rf %t.instance
# RUN: python %{shared_inputs}/create_temp_instance.py \
# RUN:     %s %{shared_inputs}/SmallInstance \
# RUN:     %t.instance %S/Inputs/V4Pages_extra_records.sql
#
# RUN: python %s %t.instance

import unittest
import logging
import sys
import datetime

from lnt.server.config import Config
from lnt.server.db import v4db
from lnt.server.db.fieldchange import is_overlaping, identify_related_changes

logging.basicConfig(level=logging.DEBUG)


class ChangeProcessingTests(unittest.TestCase):
    """Test the REST api."""

    def setUp(self):
        """Bind to the LNT test instance."""
        db = v4db.V4DB("sqlite:///:memory:", Config.dummyInstance(), echo=False)

        # Get the test suite wrapper.
        self.ts_db = db.testsuite['nts']

    def test_fc(self):
        pass

    def _mkorder(self, ts, rev):
        order = ts.Order()
        order.llvm_project_revision = rev
        ts.add(order)
        return order

    def test_change_grouping_criteria(self):
        ts_db = self.ts_db
        order1234 = self._mkorder(ts_db, "1234")
        order1235 = self._mkorder(ts_db, "1235")
        order1236 = self._mkorder(ts_db, "1236")
        order1237 = self._mkorder(ts_db, "1237")
        order1238 = self._mkorder(ts_db, "1238")

        start_time = end_time = datetime.datetime.utcnow()
        machine = ts_db.Machine("test-machine")
        test = ts_db.Test("test-a")
        machine2 = ts_db.Machine("test-machine2")
        test2 = ts_db.Test("test-b")

        run = ts_db.Run(machine, order1235,  start_time,
                        end_time)
        sample = ts_db.Sample(run, test, compile_time=1.0,
                              score=4.2)
        a_field = list(sample.get_primary_fields())[0]
        a_field2 = list(sample.get_primary_fields())[1]

        field_change = ts_db.FieldChange(order1234,
                                         order1235,
                                         machine,
                                         test,
                                         a_field)
        ts_db.add(field_change)

        field_change2 = ts_db.FieldChange(order1235, order1236, machine,
                                          test,
                                          a_field)
        ts_db.add(field_change2)

        field_change3 = ts_db.FieldChange(order1237, order1238, machine,
                                          test,
                                          a_field)
        ts_db.add(field_change3)

        regression = ts_db.Regression("Some regression title", "PR1234")
        ts_db.add(regression)

        regression_indicator1 = ts_db.RegressionIndicator(regression,
                                                          field_change)
        regression_indicator2 = ts_db.RegressionIndicator(regression,
                                                          field_change2)

        ts_db.add(regression_indicator1)
        ts_db.add(regression_indicator2)

        # All the regressions we detected.
        regressions = [regression]

        # Check simple overlap checks work.
        self.assertTrue(is_overlaping(field_change, field_change2),
                        "Should be overlapping")
        self.assertFalse(is_overlaping(field_change, field_change3),
                         "Should not be overlapping")

        # Check non-overlapping changes are always False.
        ret, reg = identify_related_changes(ts_db, regressions, field_change3)
        self.assertFalse(ret, "Ranges don't overlap, should not match")
        regressions.append(reg)
        # Check a regression matches if all fields match.
        ret, _ = identify_related_changes(ts_db, regressions, field_change)
        self.assertTrue(ret, "Should Match.")

        field_change7 = ts_db.FieldChange(order1234,
                                          order1235,
                                          machine2,
                                          test2,
                                          a_field)
        ts_db.add(field_change7)
        ret, reg = identify_related_changes(ts_db, regressions, field_change7)
        self.assertNotEquals(regression, reg)
        self.assertFalse(ret, "Should not match with differnt machine and tests.")
        regressions.append(reg)
        field_change4 = ts_db.FieldChange(order1234,
                                          order1235,
                                          machine2,
                                          test,
                                          a_field)

        # Check a regression matches if all fields match.
        ret, _ = identify_related_changes(ts_db, regressions, field_change4)
        self.assertTrue(ret, "Should Match with differnt machine.")

        field_change5 = ts_db.FieldChange(order1234,
                                          order1235,
                                          machine,
                                          test2,
                                          a_field)

        # Check a regression matches if all fields match.
        ret, _ = identify_related_changes(ts_db, regressions, field_change5)
        self.assertTrue(ret, "Should Match with differnt tests.")
        field_change6 = ts_db.FieldChange(order1234,
                                          order1235,
                                          machine,
                                          test,
                                          a_field2)

        # Check a regression matches if all fields match.
        ret, _ = identify_related_changes(ts_db, regressions, field_change6)
        self.assertTrue(ret, "Should Match with differnt fields.")


if __name__ == '__main__':
    unittest.main(argv=[sys.argv[0], ])

# Check the blacklist.
# RUN: python %s
"""Test the blacklist module"""
import unittest
import logging
import sys
from lnt.server.config import Config
from lnt.server.db import v4db

import lnt.server.db.rules.rule_blacklist_benchmarks_by_name as blacklist

logging.basicConfig(level=logging.DEBUG)


class BlacklistProcessingTest(unittest.TestCase):
    """Test the Rules facility."""

    def _mkorder(self, ts, rev):
        order = ts.Order()
        order.llvm_project_revision = rev
        ts.add(order)
        return order
        
    def setUp(self):
        self.db = v4db.V4DB("sqlite:///:memory:", Config.dummyInstance(), echo=False)

        # Get the test suite wrapper.
        ts_db = self.ts_db = self.db.testsuite['nts']
        
        order1234 = self.order1234 = self._mkorder(ts_db, "1234")
        order1236 = self.order1236 = self._mkorder(ts_db, "1236")

        machine = self.machine = ts_db.Machine("test-machine")
        ts_db.add(machine)

        a_field = ts_db.Sample.fields[0]

        ts_db.commit()
        
        test = self.test = ts_db.Test("Foo")
        test2 = self.test2 = ts_db.Test("SingleSource/Foo/Bar/baz")
        test3 = self.test3 = ts_db.Test("SingleSource/UnitTests/Bar/baz")
        test4 = self.test4 = ts_db.Test("MultiSource/Benchmarks/Ptrdist/ks/ks")

        self.field_change1 = ts_db.FieldChange(order1234,
                                               order1236,
                                               machine,
                                               test,
                                               a_field)
        self.field_change2 = ts_db.FieldChange(order1234,
                                               order1236,
                                               machine,
                                               test2,
                                               a_field)
        self.field_change3 = ts_db.FieldChange(order1234,
                                               order1236,
                                               machine,
                                               test3,
                                               a_field)
        self.field_change4 = ts_db.FieldChange(order1234,
                                               order1236,
                                               machine,
                                               test4,
                                               a_field)
        ts_db.add(self.field_change1)
        ts_db.add(self.field_change2)
        ts_db.add(self.field_change3)
        ts_db.add(self.field_change4)

        ts_db.commit()

    def test_blacklist(self):
        """Check we filter by benchmark name correctly."""
        ts = self.ts_db
        fc1 = self.field_change1
        fc2 = self.field_change2
        fc3 = self.field_change3
        fc4 = self.field_change4

        valid = blacklist.filter_by_benchmark_name(ts, fc1)
        self.assertTrue(valid, "Expect this to not be filtered.")
        valid = blacklist.filter_by_benchmark_name(ts, fc2)
        self.assertTrue(valid, "Expect this to not be filtered.")
        bad = blacklist.filter_by_benchmark_name(ts, fc3)
        self.assertFalse(bad, "Expect this to be filtered by regex.")
        bad = blacklist.filter_by_benchmark_name(ts, fc4)
        self.assertFalse(bad, "Expect this to be filtered by blacklist.")

if __name__ == '__main__':
    unittest.main(argv=[sys.argv[0], ])

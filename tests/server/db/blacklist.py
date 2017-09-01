# Check the blacklist.
# RUN: rm -rf %t.instance
# RUN: python %{shared_inputs}/create_temp_instance.py \
# RUN:   %s %{shared_inputs}/SmallInstance %t.instance \
# RUN:   %S/Inputs/V4Pages_extra_records.sql
#
# RUN: python %s %t.instance

"""Test the blacklist module"""
import unittest
import os
import logging
import sys

import lnt
from lnt.server.config import Config
from lnt.server.db import v4db

import lnt.server.db.rules.rule_blacklist_benchmarks_by_name as blacklist
import lnt.server.ui.app

here = os.path.dirname(__file__)

logging.basicConfig(level=logging.DEBUG)


class BlacklistProcessingTest(unittest.TestCase):
    """Test the Rules facility."""

    def _mkorder(self, session, ts, rev):
        order = ts.Order()
        order.llvm_project_revision = rev
        session.add(order)
        return order
        
    def setUp(self):
        _, instance_path = sys.argv

        # Create the application instance.
        app = lnt.server.ui.app.App.create_standalone(instance_path)
        app.old_config.blacklist = here + "/blacklist"
        app.app_context().push()
        # Get the test suite wrapper.
        with app.test_request_context('/db_default/nts/foo') as r:
            app.preprocess_request()
            r.g.db_name = "default"
            r.g.testsuite_name = "nts"
            r.request.db = app.instance.get_database(r.g.db_name)
            r.request.session = r.request.db.make_session()
            self.ts = r.request.get_testsuite()
            self.ts_db = self.ts
            self.session = r.request.session
        session = self.session
        ts_db = self.ts_db
        order1234 = self.order1234 = self._mkorder(session, ts_db, "1234")
        order1236 = self.order1236 = self._mkorder(session, ts_db, "1236")

        machine = self.machine = ts_db.Machine("test-machine")
        session.add(machine)

        a_field = ts_db.Sample.fields[0]

        session.commit()
        
        test = self.test = ts_db.Test("Foo")
        test2 = self.test2 = ts_db.Test("SingleSource/Foo/Bar/baz")
        test3 = self.test3 = ts_db.Test("SingleSource/UnitTests/Bar/baz")
        test4 = self.test4 = ts_db.Test("MultiSource/Benchmarks/Ptrdist/ks/ks")

        self.field_change1 = ts_db.FieldChange(order1234,
                                               order1236,
                                               machine,
                                               test,
                                               a_field.id)
        self.field_change2 = ts_db.FieldChange(order1234,
                                               order1236,
                                               machine,
                                               test2,
                                               a_field.id)
        self.field_change3 = ts_db.FieldChange(order1234,
                                               order1236,
                                               machine,
                                               test3,
                                               a_field.id)
        self.field_change4 = ts_db.FieldChange(order1234,
                                               order1236,
                                               machine,
                                               test4,
                                               a_field.id)
        session.add(self.field_change1)
        session.add(self.field_change2)
        session.add(self.field_change3)
        session.add(self.field_change4)

        session.commit()

    def test_blacklist(self):
        """Check we filter by benchmark name correctly."""
        session = self.session
        ts = self.ts_db
        fc1 = self.field_change1
        fc2 = self.field_change2
        fc3 = self.field_change3
        fc4 = self.field_change4

        valid = blacklist.filter_by_benchmark_name(session, ts, fc1)
        self.assertTrue(valid, "Expect this to not be filtered.")
        valid = blacklist.filter_by_benchmark_name(session, ts, fc2)
        self.assertTrue(valid, "Expect this to not be filtered.")
        bad = blacklist.filter_by_benchmark_name(session, ts, fc3)
        self.assertFalse(bad, "Expect this to be filtered by regex.")
        bad = blacklist.filter_by_benchmark_name(session, ts, fc4)
        self.assertFalse(bad, "Expect this to be filtered by blacklist.")

if __name__ == '__main__':
    unittest.main(argv=[sys.argv[0], ])

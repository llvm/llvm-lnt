# RUN: rm -rf %t.instance
# RUN: %{utils}/with_postgres.sh %t.pg.log \
# RUN:     %{utils}/with_temporary_instance.py %t.instance \
# RUN:         -- python %s %t.instance %S

import unittest
import tempfile
import sys
import os
import lnt.util.ImportData
import lnt.server.instance
from lnt.server.db.search import search


class SearchTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        instance_path = sys.argv[1]
        inputs_path = sys.argv[2]

        instance = lnt.server.instance.Instance.frompath(instance_path)
        config = instance.config

        imported_runs = [('machine1', '5624'),
                         ('machine1', '5625'),
                         ('machine2', '6512'),
                         ('machine2', '7623'),
                         ('machine3', '65'),
                         ('machine3', '6512'),
                         ('machine3', '7623'),
                         ('machine3', '11324'),
                         ('supermachine', '1324'),
                         ('supermachine', '7623')]

        # Get the database.
        cls.db = config.get_database('default')
        cls.session = cls.db.make_session()
        cls.ts = cls.db.testsuite.get('nts')

        # Load the database.
        for r in imported_runs:
            with tempfile.NamedTemporaryFile(mode='w', suffix='.json') as f:
                data = open(os.path.join(inputs_path, 'Inputs/report.json.in')) \
                    .read() \
                    .replace('@@MACHINE@@', r[0]) \
                    .replace('@@ORDER@@', r[1])
                f.write(data)
                f.flush()

                result = lnt.util.ImportData.import_and_report(
                    None, 'default', cls.db, cls.session, f.name,
                    format='<auto>', ts_name='nts', show_sample_count=False,
                    disable_email=True, disable_report=True,
                    select_machine='match', merge_run='reject')

                assert result.get('success', False)

        # Look up machine2's ID dynamically for test_default_machine.
        # The test_default_machine test verifies that when a default_machine
        # is set, searching for an order number without a machine name
        # restricts results to that machine.
        machine2 = cls.session.query(cls.ts.Machine) \
            .filter_by(name='machine2').one()
        cls.machine2_id = machine2.id

    @classmethod
    def tearDownClass(cls):
        cls.session.close()

    def _mangleResults(self, rs):
        return [(r.machine.name, str(r.order.llvm_project_revision))
                for r in rs]

    def test_specific(self):
        session = self.__class__.session
        ts = self.__class__.ts

        results = self._mangleResults(search(session, ts, 'machine1 #5625'))
        self.assertEqual(results, [
            ('machine1', '5625')
        ])

        results = self._mangleResults(search(session, ts, 'machine1 #5624'))
        self.assertEqual(results, [
            ('machine1', '5624')
        ])

    def test_multiple_orders(self):
        session = self.__class__.session
        ts = self.__class__.ts

        results = self._mangleResults(search(session, ts, 'machine1 #56'))
        self.assertEqual(results, [
            ('machine1', '5625'), ('machine1', '5624')
        ])

    def test_nohash(self):
        session = self.__class__.session
        ts = self.__class__.ts

        results = self._mangleResults(search(session, ts, 'machine1 r56'))
        self.assertEqual(results, [
            ('machine1', '5625'), ('machine1', '5624')
        ])

        results = self._mangleResults(search(session, ts, 'machine1 56'))
        self.assertEqual(results, [
            ('machine1', '5625'), ('machine1', '5624')
        ])

    def test_default_order(self):
        session = self.__class__.session
        ts = self.__class__.ts

        results = self._mangleResults(search(session, ts, 'machi ne3'))
        self.assertEqual(results, [
            ('machine3', '11324'),
            ('machine3', '7623'),
            ('machine3', '6512'),
            ('machine3', '65')
        ])

    def test_default_machine(self):
        session = self.__class__.session
        ts = self.__class__.ts

        results = self._mangleResults(search(session, ts, '65',
                                             default_machine=self.__class__.machine2_id))
        self.assertEqual(results, [
            ('machine2', '6512')
        ])


if __name__ == '__main__':
    unittest.main(argv=[sys.argv[0]])

# RUN: python %s

import unittest, tempfile, shutil, logging, sys, os, contextlib
import lnt.util.ImportData
import lnt.server.instance
from lnt.server.db.search import search

#logging.basicConfig(level=logging.DEBUG)

class SearchTest(unittest.TestCase):
    def setUp(self):

        master_path = 'Inputs/lnt_v0.4.0_filled_instance'
        slave_path = os.path.join(tempfile.mkdtemp(), 'lnt')
        shutil.copytree(master_path, slave_path)
        instance = lnt.server.instance.Instance.frompath(slave_path)
        config = instance.config

        imported_runs = [('machine1', '5624'),
                         ('machine1', '5625'),
                         ('machine2', '6512'),
                         ('machine2', '7623'),
                         ('supermachine', '1324'),
                         ('supermachine', '7623')]
        
        # Get the database.
        self.db = config.get_database('default', echo=False)
        # Load the database.
        success = True
        for r in imported_runs:
            with tempfile.NamedTemporaryFile() as f:
                data = open('Inputs/report.json.in') \
                    .read() \
                    .replace('@@MACHINE@@', r[0]) \
                    .replace('@@ORDER@@', r[1])
                open(f.name, 'w').write(data)
    
                result = lnt.util.ImportData.import_and_report(
                    None, 'default', self.db, f.name,
                    '<auto>', True, False,
                    True, True)

                success &= result.get('success', False)

        assert success

    def _mangleResults(self, rs):
        return [(r.machine.name, str(r.order.llvm_project_revision))
                for r in rs]
        
    def test_specific(self):
        ts = self.db.testsuite.get('nts')

        results = self._mangleResults(search(ts, 'machine1 #5625'))
        self.assertEqual(results, [
            ('machine1', '5625')
        ])

        results = self._mangleResults(search(ts, 'machine1 #5624'))
        self.assertEqual(results, [
            ('machine1', '5624')
        ])

    def test_multiple_orders(self):
        ts = self.db.testsuite.get('nts')

        results = self._mangleResults(search(ts, 'machine1 #56'))
        self.assertEqual(results, [
            ('machine1', '5625'), ('machine1', '5624')
        ])

    def test_nohash(self):
        ts = self.db.testsuite.get('nts')

        results = self._mangleResults(search(ts, 'machine1 r56'))
        self.assertEqual(results, [
            ('machine1', '5625'), ('machine1', '5624')
        ])

        results = self._mangleResults(search(ts, 'machine1 56'))
        self.assertEqual(results, [
            ('machine1', '5625'), ('machine1', '5624')
        ])

    def test_default_order(self):
        ts = self.db.testsuite.get('nts')

        results = self._mangleResults(search(ts, 'machi ne2'))
        self.assertEqual(results, [
            ('machine2', '7623'), ('machine2', '6512')
        ])
        
    def test_default_machine(self):
        ts = self.db.testsuite.get('nts')

        results = self._mangleResults(search(ts, '65', default_machine=3))
        self.assertEqual(results, [
            ('machine2', '6512')
        ])

if __name__ == '__main__':
    unittest.main(argv=[sys.argv[0], ])

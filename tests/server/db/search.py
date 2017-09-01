# RUN: python %s %S

import unittest, tempfile, shutil, logging, sys, os, contextlib
import lnt.util.ImportData
import lnt.server.instance
from lnt.server.db.search import search

#logging.basicConfig(level=logging.DEBUG)

base_path = ''

class SearchTest(unittest.TestCase):
    def setUp(self):

        master_path = os.path.join(base_path, 'Inputs/lnt_v0.4.0_filled_instance')
        slave_path = os.path.join(tempfile.mkdtemp(), 'lnt')
        shutil.copytree(master_path, slave_path)

        instance = lnt.server.instance.Instance.frompath(slave_path)
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
        self.db = config.get_database('default')
        self.session = self.db.make_session()
        # Load the database.
        for r in imported_runs:
            with tempfile.NamedTemporaryFile() as f:
                data = open(os.path.join(base_path, 'Inputs/report.json.in')) \
                    .read() \
                    .replace('@@MACHINE@@', r[0]) \
                    .replace('@@ORDER@@', r[1])
                open(f.name, 'w').write(data)
    
                result = lnt.util.ImportData.import_and_report(
                    None, 'default', self.db, self.session, f.name,
                    format='<auto>', ts_name='nts', show_sample_count=False,
                    disable_email=True, disable_report=True,
                    updateMachine=False, mergeRun='reject')

                assert result.get('success', False)

    def _mangleResults(self, rs):
        return [(r.machine.name, str(r.order.llvm_project_revision))
                for r in rs]
        
    def test_specific(self):
        session = self.session
        ts = self.db.testsuite.get('nts')

        results = self._mangleResults(search(session, ts, 'machine1 #5625'))
        self.assertEqual(results, [
            ('machine1', '5625')
        ])

        results = self._mangleResults(search(session, ts, 'machine1 #5624'))
        self.assertEqual(results, [
            ('machine1', '5624')
        ])

    def test_multiple_orders(self):
        session = self.session
        ts = self.db.testsuite.get('nts')

        results = self._mangleResults(search(session, ts, 'machine1 #56'))
        self.assertEqual(results, [
            ('machine1', '5625'), ('machine1', '5624')
        ])

    def test_nohash(self):
        session = self.session
        ts = self.db.testsuite.get('nts')

        results = self._mangleResults(search(session, ts, 'machine1 r56'))
        self.assertEqual(results, [
            ('machine1', '5625'), ('machine1', '5624')
        ])

        results = self._mangleResults(search(session, ts, 'machine1 56'))
        self.assertEqual(results, [
            ('machine1', '5625'), ('machine1', '5624')
        ])

    def test_default_order(self):
        session = self.session
        ts = self.db.testsuite.get('nts')

        results = self._mangleResults(search(session, ts, 'machi ne3'))
        self.assertEqual(results, [
            ('machine3', '11324'),
            ('machine3', '7623'),
            ('machine3', '6512'),
            ('machine3', '65')
        ])
        
    def test_default_machine(self):
        session = self.session
        ts = self.db.testsuite.get('nts')

        results = self._mangleResults(search(session, ts, '65',
                                             default_machine=3))
        self.assertEqual(results, [
            ('machine2', '6512')
        ])

if __name__ == '__main__':
    if len(sys.argv) > 1:
        base_path = sys.argv[1]
    unittest.main(argv=[sys.argv[0], ])

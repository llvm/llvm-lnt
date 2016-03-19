# RUN: python %s
import unittest, sys, os, tempfile, time, threading, json

try:
    import lnt.testing.profile.cPerf as cPerf
except:
    # No tests to run if cPerf is not available
    sys.exit(0)

from lnt.testing.profile.perf import LinuxPerfProfile
    
class CPerfTest(unittest.TestCase):
    def setUp(self):
        self.inputs = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                   'Inputs')
        self.fake_nm = 'python %s/fake-nm.py' % self.inputs

        self.expected_data = {
            'fib-aarch64': {u'functions': {u'fib': {u'data': [[4196040, {u'cycles': 22.476272172208624}, u'\ta9be4ff4 \tstp\tx20, x19, [sp,#-32]!'], [4196044, {u'cycles': 20.81533649797271}, u'\ta9017bfd \tstp\tx29, x30, [sp,#16]'], [4196048, {}, u'\t910043fd \tadd\tx29, sp, #0x10'], [4196052, {}, u'\t71000813 \tsubs\tw19, w0, #0x2'], [4196056, {}, u'\t540000eb \tb.lt\t4006f4 <fib+0x2c>'], [4196060, {u'cycles': 10.065491723992467}, u'\t51000400 \tsub\tw0, w0, #0x1'], [4196064, {}, u'\t97fffffa \tbl\t4006c8 <fib>'], [4196068, {u'cycles': 5.858831022967777}, u'\t2a0003f4 \tmov\tw20, w0'], [4196072, {}, u'\t2a1303e0 \tmov\tw0, w19'], [4196076, {}, u'\t97fffff7 \tbl\t4006c8 <fib>'], [4196080, {u'cycles': 7.57924022814841}, u'\t0b140000 \tadd\tw0, w0, w20'], [4196084, {u'cycles': 19.240308514111305}, u'\ta9417bfd \tldp\tx29, x30, [sp,#16]'], [4196088, {u'cycles': 13.964519840598708}, u'\ta8c24ff4 \tldp\tx20, x19, [sp],#32'], [4196092, {}, u'\td65f03c0 \tret']], u'counters': {u'cycles': 99.77243187496647}}}, u'counters': {u'cycles': 240949386}},
            'fib2-aarch64': {u'functions': {u'fib': {u'data': [[4196040, {u'cycles': 23.48637833693693, u'branch-misses': 21.904846340904687, u'cache-misses': 37.4486921529175}, u'\ta9be4ff4 \tstp\tx20, x19, [sp,#-32]!'], [4196044, {u'cycles': 20.34001001463117, u'branch-misses': 2.6443747907452115, u'cache-misses': 17.08651911468813}, u'\ta9017bfd \tstp\tx29, x30, [sp,#16]'], [4196048, {}, u'\t910043fd \tadd\tx29, sp, #0x10'], [4196052, {}, u'\t71000813 \tsubs\tw19, w0, #0x2'], [4196056, {}, u'\t540000eb \tb.lt\t4006f4 <fib+0x2c>'], [4196060, {u'cycles': 9.787981545863996, u'branch-misses': 30.264575146698622, u'cache-misses': 20.69215291750503}, u'\t51000400 \tsub\tw0, w0, #0x1'], [4196064, {}, u'\t97fffffa \tbl\t4006c8 <fib>'], [4196068, {u'cycles': 7.702120542412432, u'branch-misses': 0.11195131191739062, u'cache-misses': 2.3621730382293764}, u'\t2a0003f4 \tmov\tw20, w0'], [4196072, {}, u'\t2a1303e0 \tmov\tw0, w19'], [4196076, {}, u'\t97fffff7 \tbl\t4006c8 <fib>'], [4196080, {u'cycles': 7.362266427937867, u'branch-misses': 19.03265916580028, u'cache-misses': 3.8229376257545273}, u'\t0b140000 \tadd\tw0, w0, w20'], [4196084, {u'cycles': 18.387547715628735, u'branch-misses': 4.9891297644011345, u'cache-misses': 7.553319919517103}, u'\ta9417bfd \tldp\tx29, x30, [sp,#16]'], [4196088, {u'cycles': 12.93369541658887, u'branch-misses': 21.05246347953268, u'cache-misses': 11.03420523138833}, u'\ta8c24ff4 \tldp\tx20, x19, [sp],#32'], [4196092, {}, u'\td65f03c0 \tret']], u'counters': {u'cycles': 99.78902404723429, u'branch-misses': 99.7405382129432, u'cache-misses': 75.18000847098688}}}, u'counters': {u'cycles': 243618286, u'branch-misses': 1820692, u'cache-misses': 33054}}
            }

        
        
    def _getNm(self, perf_data_fname):
        stub = perf_data_fname.rsplit('.perf_data', 1)[0]
        return 'python %s/fake-nm.py %s.nm.out' % (self.inputs, stub)

    def _getObjdump(self, perf_data_fname):
        stub = perf_data_fname.rsplit('.perf_data', 1)[0]
        return 'python %s/fake-objdump.py %s.objdump' % (self.inputs, stub)

    def _getInput(self, fname):
        return os.path.join(self.inputs, fname)
    
    def test_check_file(self):
        self.assertTrue(LinuxPerfProfile.checkFile(self._getInput('fib-aarch64.perf_data')))

    def test_aarch64_fib(self):
       perf_data = self._getInput('fib-aarch64.perf_data')
       p = LinuxPerfProfile.deserialize(open(perf_data),
                                        nm=self._getNm(perf_data),
                                        objdump=self._getObjdump(perf_data),
                                        propagateExceptions=True)

       self.assertEqual(p.data, self.expected_data['fib-aarch64'])

    def test_aarch64_fib2(self):
       perf_data = self._getInput('fib2-aarch64.perf_data')
       p = LinuxPerfProfile.deserialize(open(perf_data),
                                        nm=self._getNm(perf_data),
                                        objdump=self._getObjdump(perf_data),
                                        propagateExceptions=True)

       self.assertEqual(p.data, self.expected_data['fib2-aarch64'])
       
    def test_random_guff(self):
        # Create complete rubbish and throw it at cPerf, expecting an
        # AssertionError.
        data = '6492gbiajng295akgjowj210441'
        with tempfile.NamedTemporaryFile() as fd:
            open(fd.name, 'w').write(data)
            with self.assertRaises(AssertionError):
                LinuxPerfProfile.deserialize(open(fd.name),
                                             propagateExceptions=True)

    def test_random_guff2(self):
        # Create complete rubbish and throw it at cPerf, expecting an
        # AssertionError. This version contains the correct magic number.
        data = 'PERFILE28620k hshjsjhs&6362kkjh25090nnjh'
        with tempfile.NamedTemporaryFile() as fd:
            open(fd.name, 'w').write(data)
            with self.assertRaises(AssertionError):
                LinuxPerfProfile.deserialize(open(fd.name),
                                             propagateExceptions=True)

if __name__ == '__main__':
    unittest.main(argv=[sys.argv[0], ])

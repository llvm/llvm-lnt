# RUN: python %s

import unittest
import sys
import os
import tempfile
from lnt.testing.profile.perf import LinuxPerfProfile


class CPerfTest(unittest.TestCase):
    def setUp(self):
        self.inputs = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                   'Inputs')
        self.fake_nm = 'python %s/fake-nm.py' % self.inputs

        self.expected_data = {
            "fib-aarch64": {
                u"counters": {u"cycles": 240949386},
                u"functions": {
                    u"fib": {
                        u"counters": {u"cycles": 99.77243187496647},
                        u"data": [
                            [
                                {u"cycles": 22.476272172208624},
                                4196040,
                                u"\ta9be4ff4 \tstp\tx20, x19, [sp,#-32]!",
                            ],
                            [
                                {u"cycles": 20.81533649797271},
                                4196044,
                                u"\ta9017bfd \tstp\tx29, x30, [sp,#16]",
                            ],
                            [{}, 4196048, u"\t910043fd \tadd\tx29, sp, #0x10"],
                            [{}, 4196052, u"\t71000813 \tsubs\tw19, w0, #0x2"],
                            [{}, 4196056, u"\t540000eb \tb.lt\t4006f4 <fib+0x2c>"],
                            [
                                {u"cycles": 10.065491723992467},
                                4196060,
                                u"\t51000400 \tsub\tw0, w0, #0x1",
                            ],
                            [{}, 4196064, u"\t97fffffa \tbl\t4006c8 <fib>"],
                            [
                                {u"cycles": 5.858831022967777},
                                4196068,
                                u"\t2a0003f4 \tmov\tw20, w0",
                            ],
                            [{}, 4196072, u"\t2a1303e0 \tmov\tw0, w19"],
                            [{}, 4196076, u"\t97fffff7 \tbl\t4006c8 <fib>"],
                            [
                                {u"cycles": 7.57924022814841},
                                4196080,
                                u"\t0b140000 \tadd\tw0, w0, w20",
                            ],
                            [
                                {u"cycles": 19.240308514111305},
                                4196084,
                                u"\ta9417bfd \tldp\tx29, x30, [sp,#16]",
                            ],
                            [
                                {u"cycles": 13.964519840598708},
                                4196088,
                                u"\ta8c24ff4 \tldp\tx20, x19, [sp],#32",
                            ],
                            [{}, 4196092, u"\td65f03c0 \tret"],
                        ],
                    }
                },
            },
            "fib2-aarch64": {
                u"counters": {
                    u"branch-misses": 1820692,
                    u"cache-misses": 33054,
                    u"cycles": 243618286,
                },
                u"functions": {
                    u"fib": {
                        u"counters": {
                            u"branch-misses": 99.7405382129432,
                            u"cache-misses": 75.18000847098688,
                            u"cycles": 99.78902404723429,
                        },
                        u"data": [
                            [
                                {
                                    u"branch-misses": 21.904846340904687,
                                    u"cache-misses": 37.4486921529175,
                                    u"cycles": 23.48637833693693,
                                },
                                4196040,
                                u"\ta9be4ff4 \tstp\tx20, x19, [sp,#-32]!",
                            ],
                            [
                                {
                                    u"branch-misses": 2.6443747907452115,
                                    u"cache-misses": 17.08651911468813,
                                    u"cycles": 20.34001001463117,
                                },
                                4196044,
                                u"\ta9017bfd \tstp\tx29, x30, [sp,#16]",
                            ],
                            [{}, 4196048, u"\t910043fd \tadd\tx29, sp, #0x10"],
                            [{}, 4196052, u"\t71000813 \tsubs\tw19, w0, #0x2"],
                            [{}, 4196056, u"\t540000eb \tb.lt\t4006f4 <fib+0x2c>"],
                            [
                                {
                                    u"branch-misses": 30.264575146698622,
                                    u"cache-misses": 20.69215291750503,
                                    u"cycles": 9.787981545863996,
                                },
                                4196060,
                                u"\t51000400 \tsub\tw0, w0, #0x1",
                            ],
                            [{}, 4196064, u"\t97fffffa \tbl\t4006c8 <fib>"],
                            [
                                {
                                    u"branch-misses": 0.11195131191739062,
                                    u"cache-misses": 2.3621730382293764,
                                    u"cycles": 7.702120542412432,
                                },
                                4196068,
                                u"\t2a0003f4 \tmov\tw20, w0",
                            ],
                            [{}, 4196072, u"\t2a1303e0 \tmov\tw0, w19"],
                            [{}, 4196076, u"\t97fffff7 \tbl\t4006c8 <fib>"],
                            [
                                {
                                    u"branch-misses": 19.03265916580028,
                                    u"cache-misses": 3.8229376257545273,
                                    u"cycles": 7.362266427937867,
                                },
                                4196080,
                                u"\t0b140000 \tadd\tw0, w0, w20",
                            ],
                            [
                                {
                                    u"branch-misses": 4.9891297644011345,
                                    u"cache-misses": 7.553319919517103,
                                    u"cycles": 18.387547715628735,
                                },
                                4196084,
                                u"\ta9417bfd \tldp\tx29, x30, [sp,#16]",
                            ],
                            [
                                {
                                    u"branch-misses": 21.05246347953268,
                                    u"cache-misses": 11.03420523138833,
                                    u"cycles": 12.93369541658887,
                                },
                                4196088,
                                u"\ta8c24ff4 \tldp\tx20, x19, [sp],#32",
                            ],
                            [{}, 4196092, u"\td65f03c0 \tret"],
                        ],
                    }
                },
            },
        }

    def _getNm(self, perf_data_fname, non_dynamic=False):
        stub = perf_data_fname.rsplit('.perf_data', 1)[0]
        s = 'python %s/fake-nm.py %s.nm.out' % (self.inputs, stub)
        if non_dynamic:
            s += ' --fake-nm-be-non-dynamic'
        return s

    def _getObjdump(self, perf_data_fname):
        stub = perf_data_fname.rsplit('.perf_data', 1)[0]
        return 'python %s/fake-objdump.py %s.objdump' % (self.inputs, stub)

    def _getInput(self, fname):
        return os.path.join(self.inputs, fname)

    def _loadPerfDataInput(self, fname):
        perf_data = self._getInput(fname)
        fake_objdump = self._getObjdump(perf_data)
        with open(perf_data, 'rb') as f:
            return LinuxPerfProfile.deserialize(
                f, objdump=fake_objdump, propagateExceptions=True)

    def test_check_file(self):
        self.assertTrue(LinuxPerfProfile.checkFile(self._getInput('fib-aarch64.perf_data')))

    def test_aarch64_fib(self):
        p = self._loadPerfDataInput('fib-aarch64.perf_data')

        self.assertEqual(p.data, self.expected_data['fib-aarch64'])

    def test_aarch64_fib2(self):
        p = self._loadPerfDataInput('fib2-aarch64.perf_data')

        self.assertEqual(p.data, self.expected_data['fib2-aarch64'])

    def test_aarch64_fib2_nondynamic(self):
        p = self._loadPerfDataInput('fib2-aarch64.perf_data')

        self.assertEqual(p.data, self.expected_data['fib2-aarch64'])

    def _check_segment_layout(self, suffix):
        counter_name = 'cpu-clock'
        p = self._loadPerfDataInput('segments-%s.perf_data' % suffix)

        counters = p.data['counters']
        self.assertIn(counter_name, counters)
        self.assertGreater(counters[counter_name], 10000000)

        functions = p.data['functions']
        self.assertIn('correct', functions)

        f_counters = functions['correct']['counters']
        self.assertIn(counter_name, f_counters)
        self.assertGreater(f_counters[counter_name], 98.0)

        f_instructions = functions['correct']['data']
        self.assertGreater(len(f_instructions), 0)

    def test_segment_layout_dyn(self):
        # Test handling of a regular shared library or position-independent
        # executable (ET_DYN).
        self._check_segment_layout('dyn')

    def test_segment_layout_exec(self):
        # Test handling of a traditional ELF executable (ET_EXEC).
        self._check_segment_layout('exec')

    def test_segment_layout_shifted(self):
        # ET_DYN ELF files usually have virtual addresses equal to offsets
        # in the file but it is not required and this assumption is actually
        # violated by some ELF files.
        self._check_segment_layout('shifted')

    def test_random_guff(self):
        # Create complete rubbish and throw it at cPerf, expecting an
        # AssertionError.
        data = b'6492gbiajng295akgjowj210441'
        with tempfile.NamedTemporaryFile() as fd:
            fd.write(data)
            fd.seek(0)
            with self.assertRaises(AssertionError):
                LinuxPerfProfile.deserialize(fd, propagateExceptions=True)

    """
    This test causes a Bus Error (SIGBUS) which cannot be handled correctly.
    def test_random_guff2(self):
        # Create complete rubbish and throw it at cPerf, expecting an
        # AssertionError. This version contains the correct magic number.
        data = b'PERFILE28620k hshjsjhs&6362kkjh25090nnjh'
        with tempfile.NamedTemporaryFile() as fd:
            fd.write(data)
            fd.seek(0)
            with self.assertRaises(AssertionError):
                LinuxPerfProfile.deserialize(fd, propagateExceptions=True)
    """


if __name__ == '__main__':
    unittest.main(argv=[sys.argv[0], ])

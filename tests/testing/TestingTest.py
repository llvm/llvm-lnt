# RUN: python %s

import unittest
import logging
import copy
import re
import sys
from datetime import datetime
from lnt.testing import MetricSamples, Test, TestSamples, Run, Machine, Report

logging.basicConfig(level=logging.DEBUG)


class MetricSamplesTest(unittest.TestCase):
    def setUp(self):
        self.samples_list_float = MetricSamples('execution_time', [21.4, 3.2])

    def test_constructor(self):
        # Check implicit float conversion from string.
        samples_list_float_str = MetricSamples('execution_time',
                                               ['6.7', '30.4'])
        self.assertEqual(samples_list_float_str.metric, 'execution_time')
        self.assertListEqual(samples_list_float_str.data, [6.7, 30.4])
        self.assertEqual(samples_list_float_str.report_version, 2)

        # Check explicit float conversion.
        float_samples_list_float_str = MetricSamples('execution_time',
                                                     ['4.7', '32.4'], float)
        self.assertEqual(float_samples_list_float_str.metric, 'execution_time')
        self.assertListEqual(float_samples_list_float_str.data, [4.7, 32.4])
        self.assertEqual(float_samples_list_float_str.report_version, 2)

        # Check nop implicit float conversion from float.
        self.assertEqual(self.samples_list_float.metric, 'execution_time')
        self.assertListEqual(self.samples_list_float.data, [21.4, 3.2])
        self.assertEqual(self.samples_list_float.report_version, 2)

        # Check implicit float conversion from integer.
        samples_list_int = MetricSamples('execution_time', [6, 11])
        self.assertEqual(samples_list_int.metric, 'execution_time')
        self.assertIsInstance(samples_list_int.data[0], float)
        self.assertIsInstance(samples_list_int.data[1], float)
        self.assertListEqual(samples_list_int.data, [6.0, 11.0])
        self.assertEqual(samples_list_int.report_version, 2)

        # Check non-float conversion from float.
        int_samples_list_float = MetricSamples('execution_time', [21.4, 3.2],
                                               int)
        self.assertEqual(int_samples_list_float.metric, 'execution_time')
        self.assertIsInstance(int_samples_list_float.data[0], int)
        self.assertIsInstance(int_samples_list_float.data[1], int)
        self.assertListEqual(int_samples_list_float.data, [21, 3])
        self.assertEqual(int_samples_list_float.report_version, 2)

        # Check non-float conversion from same input type.
        int_samples_list_int = MetricSamples('execution_time', [6, 11], int)
        self.assertEqual(int_samples_list_int.metric, 'execution_time')
        self.assertIsInstance(int_samples_list_int.data[0], int)
        self.assertIsInstance(int_samples_list_int.data[1], int)
        self.assertListEqual(int_samples_list_int.data, [6, 11])
        self.assertEqual(int_samples_list_int.report_version, 2)

        # Check explicit version.
        samples_list_float_version = MetricSamples('execution_time',
                                                   [22.4, 5.2],
                                                   report_version=2)
        self.assertEqual(samples_list_float_version.metric, 'execution_time')
        self.assertListEqual(samples_list_float_version.data, [22.4, 5.2])
        self.assertEqual(samples_list_float_version.report_version, 2)

        # Check call to check().
        self.assertRaises(AssertionError, MetricSamples, 'execution_time',
                          [22.4, 5.2], report_version=1)

    def test_check(self):
        # Check valid instance.
        self.samples_list_float.report_version = 2
        self.samples_list_float.check()

        # Check too small version.
        self.samples_list_float.report_version = 1
        self.assertRaises(AssertionError, self.samples_list_float.check)

        # Check too big version.
        self.samples_list_float.report_version = 3
        self.assertRaises(AssertionError, self.samples_list_float.check)

    def test_add_samples(self):
        # Check nop implicit float conversion from float.
        self.samples_list_float.add_samples([9.9])
        self.assertListEqual(self.samples_list_float.data, [21.4, 3.2, 9.9])

        # Check implicit float conversion from string.
        self.samples_list_float.add_samples(['4.4'])
        self.assertListEqual(self.samples_list_float.data,
                             [21.4, 3.2, 9.9, 4.4])

        # Check explicit float conversion from integer.
        self.samples_list_float.add_samples([2])
        self.assertIsInstance(self.samples_list_float.data[-1], float)
        self.assertListEqual(self.samples_list_float.data,
                             [21.4, 3.2, 9.9, 4.4, 2.0])

        # Check int conversion from float.
        self.samples_list_float.add_samples([11.6], int)
        self.assertListEqual(self.samples_list_float.data,
                             [21.4, 3.2, 9.9, 4.4, 2.0, 11])

    def test_render(self):
        # Check rendering with several samples.
        self.assertDictEqual(self.samples_list_float.render(),
                             dict(execution_time=[21.4, 3.2]))

        # Check rendering with a single sample.
        samples_list_one_float = MetricSamples('execution_time', [7.3])
        self.assertDictEqual(samples_list_one_float.render(),
                             dict(execution_time=7.3))


class TestTest(unittest.TestCase):
    def setUp(self):
        self.samples = [MetricSamples('execution_time', [21.4, 3.2])]
        self.test_noinfo = Test('Test1', self.samples)
        self.test_info = Test('Test2', self.samples, {'nb_files': 2})

    def test_constructor(self):
        # Check default version, no extra info.
        self.assertEqual(self.test_noinfo.name, 'Test1')
        self.assertListEqual(self.test_noinfo.samples, self.samples)
        self.assertDictEqual(self.test_noinfo.info, dict())
        self.assertEqual(self.test_noinfo.report_version, 2)

        # Check default version, extra info.
        self.assertEqual(self.test_info.name, 'Test2')
        self.assertListEqual(self.test_info.samples, self.samples)
        self.assertDictEqual(self.test_info.info, dict(nb_files='2'))
        self.assertEqual(self.test_info.report_version, 2)

        # Check explicit version, no extra info.
        test_noinfo_version = Test('Test3', self.samples, report_version=2)
        self.assertListEqual(test_noinfo_version.samples, self.samples)
        self.assertDictEqual(test_noinfo_version.info, dict())
        self.assertEqual(test_noinfo_version.report_version, 2)

        # Check call to check().
        self.assertRaises(AssertionError, Test, 'Test4', self.samples,
                          report_version=1)

    def test_check(self):
        # Check too small version.
        self.test_noinfo.report_version = 1
        self.assertRaises(AssertionError, self.test_noinfo.check)

        # Check too big version.
        self.test_noinfo.report_version = 3
        self.assertRaises(AssertionError, self.test_noinfo.check)

        # Check valid instance.
        self.test_noinfo.report_version = 2
        self.test_noinfo.check()

        # Check wrong instance for tests.
        self.test_noinfo.samples = [self.samples[0], 2]
        self.assertRaises(AssertionError, self.test_noinfo.check)

    def test_render(self):
        # Check rendering with no info.
        d1 = {'Name': 'Test1',
              'execution_time': [21.4, 3.2]}
        self.assertDictEqual(self.test_noinfo.render(), d1)

        # Check rendering with info.
        d2 = {'Name': 'Test2',
              'execution_time': [21.4, 3.2],
              'nb_files': '2'}
        self.assertDictEqual(self.test_info.render(), d2)


class TestTestSamples(unittest.TestCase):
    def setUp(self):
        self.test_samples_int_list_noinfo = TestSamples('Test1', [1, 2])
        self.test_samples_str_float_list_noinfo = TestSamples('Test3',
                                                              ['2.3', '5.8'])
        self.test_samples_int_list_info = TestSamples('Test7', [1.7, 2.8],
                                                      {'nb_files': 2})

    def test_constructor(self):
        # Check implicit float conversion from integer.
        self.assertEqual(self.test_samples_int_list_noinfo.name, 'Test1')
        self.assertDictEqual(self.test_samples_int_list_noinfo.info, {})
        self.assertIsInstance(self.test_samples_int_list_noinfo.data[0], float)
        self.assertIsInstance(self.test_samples_int_list_noinfo.data[1], float)
        self.assertListEqual(self.test_samples_int_list_noinfo.data,
                             [1.0, 2.0])

        # Check explicit float conversion from integer.
        float_test_samples_int_list_noinfo = TestSamples('Test2', [8, 9],
                                                         conv_f=float)
        self.assertEqual(float_test_samples_int_list_noinfo.name, 'Test2')
        self.assertDictEqual(float_test_samples_int_list_noinfo.info, {})
        self.assertIsInstance(float_test_samples_int_list_noinfo.data[0],
                              float)
        self.assertIsInstance(float_test_samples_int_list_noinfo.data[1],
                              float)
        self.assertListEqual(float_test_samples_int_list_noinfo.data,
                             [8.0, 9.0])

        # Check implicit float conversion from string.
        self.assertEqual(self.test_samples_str_float_list_noinfo.name, 'Test3')
        self.assertDictEqual(self.test_samples_str_float_list_noinfo.info, {})
        self.assertListEqual(self.test_samples_str_float_list_noinfo.data,
                             [2.3, 5.8])

        # Check implicit nop float conversion from float.
        test_samples_float_list_noinfo = TestSamples('Test4', [6.4, 5.5])
        self.assertEqual(test_samples_float_list_noinfo.name, 'Test4')
        self.assertDictEqual(test_samples_float_list_noinfo.info, {})
        self.assertListEqual(test_samples_float_list_noinfo.data, [6.4, 5.5])

        # Check nop non-float conversion from input of same type.
        int_test_samples_int_list_noinfo = TestSamples('Test5', [1, 2],
                                                       conv_f=int)
        self.assertEqual(int_test_samples_int_list_noinfo.name, 'Test5')
        self.assertDictEqual(int_test_samples_int_list_noinfo.info, {})
        self.assertListEqual(int_test_samples_int_list_noinfo.data, [1, 2])

        # Check non-float conversion from string.
        int_test_samples_float_list_noinfo = TestSamples('Test6', [6.4, 5.5],
                                                         conv_f=int)
        self.assertEqual(int_test_samples_float_list_noinfo.name, 'Test6')
        self.assertDictEqual(int_test_samples_float_list_noinfo.info, {})
        self.assertListEqual(int_test_samples_float_list_noinfo.data, [6, 5])

        # Check non-float conversion from float.
        self.assertEqual(self.test_samples_int_list_info.name, 'Test7')
        self.assertDictEqual(self.test_samples_int_list_info.info,
                             {'nb_files': '2'})
        self.assertListEqual(self.test_samples_int_list_info.data, [1.7, 2.8])

    def test_render(self):
        # Check rendering with no info.
        d1 = {'Name': 'Test3',
              'Info': {},
              'Data': [2.3, 5.8]}
        self.assertDictEqual(self.test_samples_str_float_list_noinfo.render(),
                             d1)

        # Check rendering with info.
        d2 = {'Name': 'Test7',
              'Info': {'nb_files': '2'},
              'Data': [1.7, 2.8]}
        self.assertDictEqual(self.test_samples_int_list_info.render(), d2)


class TestRun(unittest.TestCase):
    def setUp(self):
        self.info_v1 = {'tag': 'nts', 'run_order': 18246}
        self.run_float_start_v1 = Run(0.0, None, self.info_v1)
        self.run_float_end_v1 = Run(None, 0.0, self.info_v1)

        self.info_v2 = {'llvm_project_revision': 18246}
        self.run_float_start_v2 = Run(0.0, info=self.info_v2, report_version=2)
        self.run_float_end_v2 = Run(end_time=0.0, info=self.info_v2,
                                    report_version=2)

    def test_constructor(self):
        info = {'__report_version__': '1',
                'tag': 'nts',
                'run_order': '18246'}

        # Check time normalization of end time from float.
        self.assertEqual(self.run_float_start_v1.start_time,
                         '1970-01-01 00:00:00')
        self.assertTrue(self.run_float_start_v1.end_time)
        self.assertNotEqual(self.run_float_start_v1.end_time,
                            self.run_float_start_v1.start_time)
        self.assertTrue(datetime.strptime(self.run_float_start_v1.end_time,
                                          '%Y-%m-%d %H:%M:%S'))
        self.assertDictEqual(self.run_float_start_v1.info, info)
        self.assertEqual(self.run_float_start_v1.report_version, 1)

        # Check time normalization of end time from datetime.
        run_str_start_v1 = Run('2019-07-01 01:02:03', None, info=self.info_v1)
        self.assertEqual(run_str_start_v1.start_time, '2019-07-01 01:02:03')
        self.assertTrue(run_str_start_v1.end_time)
        self.assertNotEqual(run_str_start_v1.end_time,
                            run_str_start_v1.start_time)
        self.assertTrue(datetime.strptime(run_str_start_v1.end_time,
                                          '%Y-%m-%d %H:%M:%S'))
        self.assertDictEqual(run_str_start_v1.info, info)
        self.assertEqual(run_str_start_v1.report_version, 1)

        # Check time normalization of end time from string.
        run_datetime_start_v1 = Run(datetime(2019, 7, 2), None,
                                    info=self.info_v1)
        self.assertEqual(run_datetime_start_v1.start_time,
                         '2019-07-02 00:00:00')
        self.assertTrue(run_datetime_start_v1.end_time)
        self.assertNotEqual(run_datetime_start_v1.end_time,
                            run_datetime_start_v1.start_time)
        self.assertTrue(datetime.strptime(run_datetime_start_v1.end_time,
                                          '%Y-%m-%d %H:%M:%S'))
        self.assertDictEqual(run_datetime_start_v1.info, info)
        self.assertEqual(run_datetime_start_v1.report_version, 1)

        # Check time normalization of start time from float.
        run_float_end_v1 = Run(None, 0.0, self.info_v1)
        self.assertEqual(run_float_end_v1.end_time, '1970-01-01 00:00:00')
        self.assertTrue(run_float_end_v1.start_time)
        self.assertNotEqual(run_float_end_v1.start_time,
                            run_float_end_v1.end_time)
        self.assertTrue(datetime.strptime(run_float_end_v1.start_time,
                                          '%Y-%m-%d %H:%M:%S'))
        self.assertDictEqual(run_float_end_v1.info, info)
        self.assertEqual(run_float_end_v1.report_version, 1)

        # Check time normalization of start time from datetime.
        run_str_end_v1 = Run(None, '2019-07-01 01:02:03', self.info_v1)
        self.assertEqual(run_str_end_v1.end_time, '2019-07-01 01:02:03')
        self.assertTrue(run_str_end_v1.start_time)
        self.assertNotEqual(run_str_end_v1.start_time, run_str_end_v1.end_time)
        self.assertTrue(datetime.strptime(run_str_end_v1.start_time,
                                          '%Y-%m-%d %H:%M:%S'))
        self.assertDictEqual(run_str_end_v1.info, info)
        self.assertEqual(run_str_end_v1.report_version, 1)

        # Check time normalization of start time from string.
        run_datetime_end_v1 = Run(None, datetime(2019, 7, 2), self.info_v1)
        self.assertEqual(run_datetime_end_v1.end_time, '2019-07-02 00:00:00')
        self.assertTrue(run_datetime_end_v1.start_time)
        self.assertNotEqual(run_datetime_end_v1.start_time,
                            run_datetime_end_v1.end_time)
        self.assertTrue(datetime.strptime(run_datetime_end_v1.start_time,
                                          '%Y-%m-%d %H:%M:%S'))
        self.assertDictEqual(run_datetime_end_v1.info, info)
        self.assertEqual(run_datetime_end_v1.report_version, 1)

        # Check failure when info contains __report_version__ key.
        self.assertRaisesRegexp(ValueError, '__report_version__.*reserved',
                                Run, None, None, info)

        # Check missing tag entry in info for format version 1.
        self.assertRaisesRegexp(ValueError,
                                "Missing 'tag' entry in 'info' dictionary",
                                Run, info={'run_order': 40385})

        # Check missing run_order entry in info for format version 1.
        self.assertRaisesRegexp(ValueError,
                                "Missing 'run_order' entry in 'info'"
                                " dictionary", Run, info={'tag': 'nts'})

        # Test empty start and end time in format version 2
        self.assertEqual(self.run_float_start_v2.start_time,
                         '1970-01-01 00:00:00')
        self.assertIsNone(self.run_float_start_v2.end_time)
        self.assertDictEqual(self.run_float_start_v2.info,
                             {'llvm_project_revision': '18246'})
        self.assertEqual(self.run_float_start_v2.report_version, 2)

        # Check missing llvm_project_revision entry in info for format
        # version 2.
        self.assertRaisesRegexp(ValueError,
                                "Missing 'llvm_project_revision' entry in"
                                " 'info' dictionary", Run, 0.0, info={},
                                report_version=2)

        # Check call to check()
        self.assertRaises(AssertionError, Run, info=self.info_v2,
                          report_version=3)

    def test_check(self):
        # Check valid v1 instance.
        self.run_float_start_v1.check()

        # Check too big version.
        self.run_float_start_v2.report_version = 3
        self.assertRaises(AssertionError, self.run_float_start_v2.check)

        # Check valid v2 instance.
        self.run_float_start_v2.report_version = 2
        self.run_float_start_v2.start_time = None
        self.run_float_start_v2.check()

        # Check no time or info.
        self.run_float_start_v2.info = {}
        self.assertRaisesRegexp(ValueError, 'No data defined in this Run',
                                self.run_float_start_v2.check)

    def test_update(self):
        # Check update with a supplied end time.
        end_time_updated_run_float_start_v1 = (
            copy.deepcopy(self.run_float_start_v1))
        end_time_updated_run_float_start_v1.update_endtime(
            datetime(2019, 8, 2))
        self.assertEqual(end_time_updated_run_float_start_v1.end_time,
                         '2019-08-02 00:00:00')

        # Check update with default end time in format v1: end time =
        # now.
        updated_run_float_start_v1 = (
            copy.deepcopy(end_time_updated_run_float_start_v1))
        updated_run_float_start_v1.update_endtime()
        self.assertTrue(updated_run_float_start_v1.end_time)
        self.assertNotEqual(updated_run_float_start_v1.end_time,
                            updated_run_float_start_v1.start_time)
        self.assertNotEqual(updated_run_float_start_v1.end_time,
                            end_time_updated_run_float_start_v1.end_time)

        # Check update with default end time in format v2: end time =
        # None.
        updated_run_float_end_v2 = copy.deepcopy(self.run_float_end_v2)
        updated_run_float_end_v2.update_endtime()
        self.assertEqual(updated_run_float_end_v2.start_time,
                         updated_run_float_end_v2.start_time)
        self.assertIsNone(updated_run_float_end_v2.end_time)

    def test_render(self):
        # Check rendering of format v1.
        d1 = {'Start Time': '1970-01-01 00:00:00',
              'End Time': self.run_float_start_v1.end_time,
              'Info': {'__report_version__': '1',
                       'run_order': '18246',
                       'tag': 'nts'}}
        self.assertDictEqual(self.run_float_start_v1.render(), d1)

        # Check rendering of format v2 with no end time.
        d2 = {'start_time': '1970-01-01 00:00:00',
              'llvm_project_revision': '18246'}
        self.assertDictEqual(self.run_float_start_v2.render(), d2)

        # Check rendering of format v2 with no start time.
        d3 = {'end_time': '1970-01-01 00:00:00',
              'llvm_project_revision': '18246'}
        self.assertDictEqual(self.run_float_end_v2.render(), d3)


class TestMachine(unittest.TestCase):
    def setUp(self):
        self.machine_v1_noinfo = Machine('Machine1')
        self.machine_v1 = Machine('Machine2', {'CPUs': 2})
        self.machine_v2 = Machine('Machine3', {'CPUs': 2}, 2)

    def test_constructor(self):
        # Check constructor with no info and default version (v1).
        self.assertEqual(self.machine_v1_noinfo.name, 'Machine1')
        self.assertDictEqual(self.machine_v1_noinfo.info, {})
        self.assertEqual(self.machine_v1_noinfo.report_version, 1)

        # Check constructor with info and default version (v1).
        self.assertEqual(self.machine_v1.name, 'Machine2')
        self.assertDictEqual(self.machine_v1.info, {'CPUs': '2'})
        self.assertEqual(self.machine_v1.report_version, 1)

        # Check v2 constructor with info.
        self.assertEqual(self.machine_v2.name, 'Machine3')
        self.assertDictEqual(self.machine_v2.info, {'CPUs': '2'})
        self.assertEqual(self.machine_v2.report_version, 2)

    def test_check(self):
        # Check valid v1 instance.
        self.machine_v1.check()

        # Check valid v2 instance.
        self.machine_v2.check()

        # Check too big version.
        self.machine_v2.report_version = 3
        self.assertRaises(AssertionError, self.machine_v2.check)

    def test_render(self):
        # Check v1 rendering with no info.
        d1 = {'Name': 'Machine1',
              'Info': {}}
        self.assertDictEqual(self.machine_v1_noinfo.render(), d1)

        # Check v1 rendering with info.
        d2 = {'Name': 'Machine2',
              'Info': {'CPUs': '2'}}
        self.assertDictEqual(self.machine_v1.render(), d2)

        # Check v2 rendering with no info.
        d3 = {'Name': 'Machine3',
              'CPUs': '2'}
        self.assertDictEqual(self.machine_v2.render(), d3)

        # Check v2 rendering with info.
        self.machine_v2.info = {}
        d4 = {'Name': 'Machine3'}
        self.assertDictEqual(self.machine_v2.render(), d4)


class TestReport(unittest.TestCase):
    maxDiff = None

    def setUp(self):
        self.machine_v1 = Machine('Machine', info={'nb_cpus': 2})
        self.run_v1 = Run(0.0, '1982-01-01 00:00:00', {'tag': 'nts',
                                                       'run_order': 18246})
        self.tests_samples = [TestSamples('Test.exec', [1.7, 2.8],
                                          {'nb_files': 2})]
        self.report_v1 = Report(self.machine_v1, self.run_v1,
                                self.tests_samples)

        self.machine_v2 = Machine('Machine', info={'nb_cpus': 2},
                                  report_version=2)
        self.run_v2 = Run(0.0, info={'llvm_project_revision': 18246},
                          report_version=2)
        samples = MetricSamples('execution_time', [21.4, 3.2])
        self.tests = [Test('Test', [samples], {'nb_files': 2})]
        self.report_v2 = Report(self.machine_v2, self.run_v2, self.tests, 2)

    def test_constructor(self):
        # Check successful constructor call with default version.
        self.assertEqual(self.report_v1.machine, self.machine_v1)
        self.assertEqual(self.report_v1.run, self.run_v1)
        self.assertListEqual(self.report_v1.tests, self.tests_samples)
        self.assertEqual(self.report_v1.report_version, 1)

        # Check successful constructor call with explicit version.
        self.assertEqual(self.report_v2.machine, self.machine_v2)
        self.assertEqual(self.report_v2.run, self.run_v2)
        self.assertListEqual(self.report_v2.tests, self.tests)
        self.assertEqual(self.report_v2.report_version, 2)

        # Check call to check().
        self.assertRaises(AssertionError, Report, [], self.run_v1,
                          self.tests_samples)

    def test_check(self):
        # Check wrong version.
        self.report_v2.report_version = 3
        self.assertRaises(AssertionError, self.report_v2.check)

        # Check valid v2 report.
        self.report_v2.report_version = 2
        self.report_v2.check()

        # Check type test for machine.
        report_machine_list = copy.deepcopy(self.report_v1)
        report_machine_list.machine = []
        self.assertRaises(AssertionError, report_machine_list.check)

        # Check version mismatch between machine and report.
        self.report_v1.machine.report_version = 2
        self.assertRaises(AssertionError, self.report_v1.check)

        # Check valid v1 report.
        self.report_v1.machine.report_version = 1
        self.report_v1.check()

        # Check type test for run.
        report_run_list = copy.deepcopy(self.report_v1)
        report_run_list.run = []
        self.assertRaises(AssertionError, report_run_list.check)

        # Check version mismatch between run and report.
        self.report_v1.run.report_version = 2
        self.assertRaises(AssertionError, self.report_v1.check)

        self.report_v1.run.report_version = 1

        # Check type test for all v1 tests.
        report_v1_tests_int_list = copy.deepcopy(self.report_v1)
        report_v1_tests_int_list.tests = [2]
        self.assertRaises(AssertionError, report_v1_tests_int_list.check)

        # Check type test for all v2 tests.
        report_v2_tests_int_list = copy.deepcopy(self.report_v2)
        report_v2_tests_int_list.tests = [2]
        self.assertRaises(AssertionError, report_v2_tests_int_list.check)

        # Check version mismatch between one of the tests and report.
        self.report_v2.tests[0].report_version = 1
        self.assertRaises(AssertionError, self.report_v2.check)

    def test_update_report(self):
        # Check update with default (=now) end time.
        orig_end_time = self.report_v1.run.end_time
        new_tests_samples = [TestSamples('Test2.exec', [56.5])]
        self.report_v1.update_report(new_tests_samples)
        self.tests_samples.extend(new_tests_samples)
        self.assertListEqual(self.report_v1.tests, self.tests_samples)
        self.assertNotEqual(self.report_v1.run.end_time, orig_end_time)

        # Check update with supplied end time.
        new_tests_samples = [TestSamples('Test3.exec', [18.3])]
        self.report_v1.update_report(new_tests_samples, '1990-07-07 00:00:00')
        self.tests_samples.extend(new_tests_samples)
        self.assertListEqual(self.report_v1.tests, self.tests_samples)
        self.assertEqual(self.report_v1.run.end_time, '1990-07-07 00:00:00')

    def test_render(self):
        # Check v1 format rendering with default indentation.
        self.assertMultiLineEqual(re.sub(r' +\n', '\n',
                                         self.report_v1.render()), """\
{
    "Machine": {
        "Info": {
            "nb_cpus": "2"
        },
        "Name": "Machine"
    },
    "Run": {
        "End Time": "1982-01-01 00:00:00",
        "Info": {
            "__report_version__": "1",
            "run_order": "18246",
            "tag": "nts"
        },
        "Start Time": "1970-01-01 00:00:00"
    },
    "Tests": [
        {
            "Data": [
                1.7,
                2.8
            ],
            "Info": {
                "nb_files": "2"
            },
            "Name": "Test.exec"
        }
    ]
}""")

        # Check v1 format rendering with supplied indentation.
        self.assertMultiLineEqual(re.sub(r' +\n', '\n',
                                         self.report_v1.render(indent=2)), """\
{
  "Machine": {
    "Info": {
      "nb_cpus": "2"
    },
    "Name": "Machine"
  },
  "Run": {
    "End Time": "1982-01-01 00:00:00",
    "Info": {
      "__report_version__": "1",
      "run_order": "18246",
      "tag": "nts"
    },
    "Start Time": "1970-01-01 00:00:00"
  },
  "Tests": [
    {
      "Data": [
        1.7,
        2.8
      ],
      "Info": {
        "nb_files": "2"
      },
      "Name": "Test.exec"
    }
  ]
}""")

        # Check v2 format rendering with default indentation.
        self.assertMultiLineEqual(re.sub(r' +\n', '\n',
                                         self.report_v2.render()), """\
{
    "format_version": "2",
    "machine": {
        "Name": "Machine",
        "nb_cpus": "2"
    },
    "run": {
        "llvm_project_revision": "18246",
        "start_time": "1970-01-01 00:00:00"
    },
    "tests": [
        {
            "Name": "Test",
            "execution_time": [
                21.4,
                3.2
            ],
            "nb_files": "2"
        }
    ]
}""")

        # Check v2 format rendering with supplied indentation.
        self.assertMultiLineEqual(re.sub(r' +\n', '\n',
                                         self.report_v2.render(indent=2)), """\
{
  "format_version": "2",
  "machine": {
    "Name": "Machine",
    "nb_cpus": "2"
  },
  "run": {
    "llvm_project_revision": "18246",
    "start_time": "1970-01-01 00:00:00"
  },
  "tests": [
    {
      "Name": "Test",
      "execution_time": [
        21.4,
        3.2
      ],
      "nb_files": "2"
    }
  ]
}""")

        # Check v2 format rendering with single sample for a metric and
        # default indentation.
        self.report_v2.tests[0].samples[0].data.pop()
        self.assertMultiLineEqual(re.sub(r' +\n', '\n',
                                         self.report_v2.render()), """\
{
    "format_version": "2",
    "machine": {
        "Name": "Machine",
        "nb_cpus": "2"
    },
    "run": {
        "llvm_project_revision": "18246",
        "start_time": "1970-01-01 00:00:00"
    },
    "tests": [
        {
            "Name": "Test",
            "execution_time": 21.4,
            "nb_files": "2"
        }
    ]
}""")


if __name__ == '__main__':
    unittest.main(argv=[sys.argv[0], ])

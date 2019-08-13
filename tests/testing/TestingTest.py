# RUN: python %s

import unittest
import logging
import copy
import re
import sys
from datetime import datetime
from lnt.testing import TestSamples, Run, Machine, Report

logging.basicConfig(level=logging.DEBUG)


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
        self.info = {'tag': 'nts', 'run_order': 18246}
        self.run_float_start = Run(0.0, None, self.info)

    def test_constructor(self):
        info = {'__report_version__': '1',
                'tag': 'nts',
                'run_order': '18246'}

        # Check time normalization of end time from float.
        self.assertEqual(self.run_float_start.start_time,
                         '1970-01-01 00:00:00')
        self.assertTrue(self.run_float_start.end_time)
        self.assertNotEqual(self.run_float_start.end_time,
                            self.run_float_start.start_time)
        self.assertTrue(datetime.strptime(self.run_float_start.end_time,
                                          '%Y-%m-%d %H:%M:%S'))
        self.assertDictEqual(self.run_float_start.info, info)

        # Check time normalization of end time from datetime.
        run_str_start = Run('2019-07-01 01:02:03', None, info=self.info)
        self.assertEqual(run_str_start.start_time, '2019-07-01 01:02:03')
        self.assertTrue(run_str_start.end_time)
        self.assertNotEqual(run_str_start.end_time, run_str_start.start_time)
        self.assertTrue(datetime.strptime(run_str_start.end_time,
                                          '%Y-%m-%d %H:%M:%S'))
        self.assertDictEqual(run_str_start.info, info)

        # Check time normalization of end time from string.
        run_datetime_start = Run(datetime(2019, 7, 2), None, info=self.info)
        self.assertEqual(run_datetime_start.start_time, '2019-07-02 00:00:00')
        self.assertTrue(run_datetime_start.end_time)
        self.assertNotEqual(run_datetime_start.end_time,
                            run_datetime_start.start_time)
        self.assertTrue(datetime.strptime(run_datetime_start.end_time,
                                          '%Y-%m-%d %H:%M:%S'))
        self.assertDictEqual(run_datetime_start.info, info)

        # Check time normalization of start time from float.
        run_float_end = Run(None, 0.0, self.info)
        self.assertEqual(run_float_end.end_time, '1970-01-01 00:00:00')
        self.assertTrue(run_float_end.start_time)
        self.assertNotEqual(run_float_end.start_time, run_float_end.end_time)
        self.assertTrue(datetime.strptime(run_float_end.start_time,
                                          '%Y-%m-%d %H:%M:%S'))
        self.assertDictEqual(run_float_end.info, info)

        # Check time normalization of start time from datetime.
        run_str_end = Run(None, '2019-07-01 01:02:03', self.info)
        self.assertEqual(run_str_end.end_time, '2019-07-01 01:02:03')
        self.assertTrue(run_str_end.start_time)
        self.assertNotEqual(run_str_end.start_time, run_str_end.end_time)
        self.assertTrue(datetime.strptime(run_str_end.start_time,
                                          '%Y-%m-%d %H:%M:%S'))
        self.assertDictEqual(run_str_end.info, info)

        # Check time normalization of start time from string.
        run_datetime_end = Run(None, datetime(2019, 7, 2), self.info)
        self.assertEqual(run_datetime_end.end_time, '2019-07-02 00:00:00')
        self.assertTrue(run_datetime_end.start_time)
        self.assertNotEqual(run_datetime_end.start_time,
                            run_datetime_end.end_time)
        self.assertTrue(datetime.strptime(run_datetime_end.start_time,
                                          '%Y-%m-%d %H:%M:%S'))
        self.assertDictEqual(run_datetime_end.info, info)

        # Check failure when info contains __report_version__ key.
        self.assertRaisesRegexp(ValueError, '__report_version__.*reserved',
                                Run, None, None, info)

    def test_update(self):
        # Check update with a supplied end time.
        end_time_updated_run_float_start = copy.deepcopy(self.run_float_start)
        end_time_updated_run_float_start.update_endtime(datetime(2019, 8, 2))
        self.assertEqual(end_time_updated_run_float_start.end_time,
                         '2019-08-02 00:00:00')

        # Check update with default (=now) end time.
        updated_run_float_start = (
            copy.deepcopy(end_time_updated_run_float_start))
        updated_run_float_start.update_endtime()
        self.assertTrue(updated_run_float_start.end_time)
        self.assertNotEqual(updated_run_float_start.end_time,
                            updated_run_float_start.start_time)
        self.assertNotEqual(updated_run_float_start.end_time,
                            end_time_updated_run_float_start.end_time)

    def test_render(self):
        d = {'Start Time': '1970-01-01 00:00:00',
             'End Time': self.run_float_start.end_time,
             'Info': {'__report_version__': '1',
                      'run_order': '18246',
                      'tag': 'nts'}}
        self.assertDictEqual(self.run_float_start.render(), d)


class TestMachine(unittest.TestCase):
    def setUp(self):
        self.machine_noinfo = Machine('Machine1')
        self.machine = Machine('Machine2', {'CPUs': 2})

    def test_constructor(self):
        # Check constructor with no info.
        self.assertEqual(self.machine_noinfo.name, 'Machine1')
        self.assertDictEqual(self.machine_noinfo.info, {})

        # Check constructor with info.
        self.assertEqual(self.machine.name, 'Machine2')
        self.assertDictEqual(self.machine.info, {'CPUs': '2'})

    def test_render(self):
        # Check rendering with no info.
        d1 = {'Name': 'Machine1',
              'Info': {}}
        self.assertDictEqual(self.machine_noinfo.render(), d1)

        # Check rendering with info.
        d2 = {'Name': 'Machine2',
              'Info': {'CPUs': '2'}}
        self.assertDictEqual(self.machine.render(), d2)


class TestReport(unittest.TestCase):
    maxDiff = None

    def setUp(self):
        self.machine = Machine('Machine', info={'nb_cpus': 2})
        self.run = Run(0.0, '1982-01-01 00:00:00', {'tag': 'nts',
                                                    'run_order': 18246})
        self.tests_samples = [TestSamples('Test.exec', [1.7, 2.8],
                                          {'nb_files': 2})]
        self.report = Report(self.machine, self.run, self.tests_samples)

    def test_constructor(self):
        # Check successful constructor call.
        self.assertEqual(self.report.machine, self.machine)
        self.assertEqual(self.report.run, self.run)
        self.assertListEqual(self.report.tests, self.tests_samples)

        # Check call to check().
        self.assertRaises(AssertionError, Report, [], self.run,
                          self.tests_samples)

    def test_check(self):
        # Check valid report.
        self.report.check()

        # Check type test for machine.
        report_machine_list = copy.deepcopy(self.report)
        report_machine_list.machine = []
        self.assertRaises(AssertionError, report_machine_list.check)

        # Check type test for run.
        report_run_list = copy.deepcopy(self.report)
        report_run_list.run = []
        self.assertRaises(AssertionError, report_run_list.check)

        # Check type test for all tests.
        report_run_list = copy.deepcopy(self.report)
        report_tests_int_list = copy.deepcopy(self.report)
        report_tests_int_list.tests = [2]
        self.assertRaises(AssertionError, report_tests_int_list.check)

    def test_update_report(self):
        orig_end_time = self.report.run.end_time
        new_tests_samples = [TestSamples('Test2.exec', [56.5])]
        self.report.update_report(new_tests_samples)
        self.tests_samples.extend(new_tests_samples)
        self.assertListEqual(self.report.tests, self.tests_samples)
        self.assertNotEqual(self.report.run.end_time, orig_end_time)

    def test_render(self):
        # Check rendering with default indentation.
        self.assertMultiLineEqual(re.sub(r' +\n', '\n', self.report.render()),
                                  """\
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

        # Check rendering with supplied indentation.
        self.assertMultiLineEqual(re.sub(r' +\n', '\n',
                                         self.report.render(indent=2)), """\
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


if __name__ == '__main__':
    unittest.main(argv=[sys.argv[0], ])

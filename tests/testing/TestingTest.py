# RUN: python %s

import unittest
import logging
import re
import sys
from datetime import datetime
from lnt.testing import MetricSamples, Test, TestSamples, Run, Machine, Report

logging.basicConfig(level=logging.DEBUG)


class MetricSamplesTest(unittest.TestCase):
    def test_constructor(self):
        # Check implicit float conversion from string.
        samples = MetricSamples('execution_time', ['6.7', '30.4'])
        self.assertEqual(samples.metric, 'execution_time')
        self.assertListEqual(samples.data, [6.7, 30.4])

        # Check explicit float conversion.
        samples = MetricSamples('execution_time', ['4.7', '32.4'], float)
        self.assertEqual(samples.metric, 'execution_time')
        self.assertListEqual(samples.data, [4.7, 32.4])

        # Check nop implicit float conversion from float.
        samples = MetricSamples('execution_time', [21.4, 3.2])
        self.assertEqual(samples.metric, 'execution_time')
        self.assertListEqual(samples.data, [21.4, 3.2])

        # Check implicit float conversion from integer.
        samples = MetricSamples('execution_time', [6, 11])
        self.assertEqual(samples.metric, 'execution_time')
        self.assertIsInstance(samples.data[0], float)
        self.assertIsInstance(samples.data[1], float)
        self.assertListEqual(samples.data, [6.0, 11.0])

        # Check non-float conversion from float.
        samples = MetricSamples('execution_time', [21.4, 3.2], int)
        self.assertEqual(samples.metric, 'execution_time')
        self.assertIsInstance(samples.data[0], int)
        self.assertIsInstance(samples.data[1], int)
        self.assertListEqual(samples.data, [21, 3])

        # Check non-float conversion from same input type.
        samples = MetricSamples('execution_time', [6, 11], int)
        self.assertEqual(samples.metric, 'execution_time')
        self.assertIsInstance(samples.data[0], int)
        self.assertIsInstance(samples.data[1], int)
        self.assertListEqual(samples.data, [6, 11])

        # Check explicit version.
        samples = MetricSamples('execution_time', [22.4, 5.2])
        self.assertEqual(samples.metric, 'execution_time')
        self.assertListEqual(samples.data, [22.4, 5.2])

    def test_add_samples(self):
        samples = MetricSamples('execution_time', [21.4, 3.2])

        # Check nop implicit float conversion from float.
        samples.add_samples([9.9])
        self.assertListEqual(samples.data, [21.4, 3.2, 9.9])

        # Check implicit float conversion from string.
        samples.add_samples(['4.4'])
        self.assertListEqual(samples.data, [21.4, 3.2, 9.9, 4.4])

        # Check explicit float conversion from integer.
        samples.add_samples([2])
        self.assertIsInstance(samples.data[-1], float)
        self.assertListEqual(samples.data, [21.4, 3.2, 9.9, 4.4, 2.0])

        # Check int conversion from float.
        samples.add_samples([11.6], int)
        self.assertListEqual(samples.data, [21.4, 3.2, 9.9, 4.4, 2.0, 11])

    def test_render(self):
        # Check rendering with several samples.
        samples = MetricSamples('execution_time', [21.4, 3.2])
        self.assertDictEqual(samples.render(), dict(execution_time=[21.4, 3.2]))

        # Check rendering with a single sample.
        samples = MetricSamples('execution_time', [7.3])
        self.assertDictEqual(samples.render(), dict(execution_time=7.3))


class TestTest(unittest.TestCase):
    def setUp(self):
        self.samples = [MetricSamples('execution_time', [21.4, 3.2])]

    def test_constructor(self):
        # Check without extra info.
        test = Test('Test1', self.samples)
        self.assertEqual(test.name, 'Test1')
        self.assertListEqual(test.samples, self.samples)
        self.assertDictEqual(test.info, dict())

        # Check with extra info.
        test = Test('Test2', self.samples, {'nb_files': '2'})
        self.assertEqual(test.name, 'Test2')
        self.assertListEqual(test.samples, self.samples)
        self.assertDictEqual(test.info, {'nb_files': '2'})

    def test_render(self):
        # Check rendering with no info.
        test = Test('Test1', self.samples)
        d = {'name': 'Test1', 'execution_time': [21.4, 3.2]}
        self.assertDictEqual(test.render(), d)

        # Check rendering with info.
        test = Test('Test2', self.samples, {'nb_files': 2})
        d = {'name': 'Test2', 'execution_time': [21.4, 3.2], 'nb_files': '2'}
        self.assertDictEqual(test.render(), d)


class TestTestSamples(unittest.TestCase):
    def test_constructor(self):
        # Check implicit float conversion from integer.
        samples = TestSamples('Test1', [1, 2])
        self.assertEqual(samples.name, 'Test1')
        self.assertDictEqual(samples.info, {})
        self.assertIsInstance(samples.data[0], float)
        self.assertIsInstance(samples.data[1], float)
        self.assertListEqual(samples.data, [1.0, 2.0])

        # Check explicit float conversion from integer.
        samples = TestSamples('Test2', [8, 9], conv_f=float)
        self.assertEqual(samples.name, 'Test2')
        self.assertDictEqual(samples.info, {})
        self.assertIsInstance(samples.data[0], float)
        self.assertIsInstance(samples.data[1], float)
        self.assertListEqual(samples.data, [8.0, 9.0])

        # Check implicit float conversion from string.
        samples = TestSamples('Test3', ['2.3', '5.8'])
        self.assertEqual(samples.name, 'Test3')
        self.assertDictEqual(samples.info, {})
        self.assertListEqual(samples.data, [2.3, 5.8])

        # Check implicit nop float conversion from float.
        samples = TestSamples('Test4', [6.4, 5.5])
        self.assertEqual(samples.name, 'Test4')
        self.assertDictEqual(samples.info, {})
        self.assertListEqual(samples.data, [6.4, 5.5])

        # Check nop non-float conversion from input of same type.
        samples = TestSamples('Test5', [1, 2], conv_f=int)
        self.assertEqual(samples.name, 'Test5')
        self.assertDictEqual(samples.info, {})
        self.assertListEqual(samples.data, [1, 2])

        # Check non-float conversion from string.
        samples = TestSamples('Test6', [6.4, 5.5], conv_f=int)
        self.assertEqual(samples.name, 'Test6')
        self.assertDictEqual(samples.info, {})
        self.assertListEqual(samples.data, [6, 5])

        # Check non-float conversion from float.
        samples = TestSamples('Test7', [1.7, 2.8], {'nb_files': 2})
        self.assertEqual(samples.name, 'Test7')
        self.assertDictEqual(samples.info, {'nb_files': '2'})
        self.assertListEqual(samples.data, [1.7, 2.8])

    def test_render(self):
        # Check rendering with no info.
        samples = TestSamples('Test1', ['2.3', '5.8'])
        d = {'Name': 'Test1', 'Info': {}, 'Data': [2.3, 5.8]}
        self.assertDictEqual(samples.render(), d)

        # Check rendering with info.
        samples = TestSamples('Test2', [1.7, 2.8], {'nb_files': 2})
        d = {'Name': 'Test2', 'Info': {'nb_files': '2'}, 'Data': [1.7, 2.8]}
        self.assertDictEqual(samples.render(), d)


class TestRun(unittest.TestCase):
    def test_constructor(self):
        info = {'llvm_project_revision': '18246'}

        # Check time normalization of start time from float.
        run = Run(0.0, info=info)
        self.assertEqual(run.start_time, '1970-01-01 00:00:00')
        self.assertIsNone(run.end_time)
        self.assertDictEqual(run.info, info)

        # Check time normalization of start time from string.
        run = Run('2019-07-01 01:02:03', None, info=info)
        self.assertEqual(run.start_time, '2019-07-01 01:02:03')
        self.assertIsNone(run.end_time)
        self.assertDictEqual(run.info, info)

        # Check time normalization of start time from datetime.
        run = Run(datetime(2019, 7, 2), None, info=info)
        self.assertEqual(run.start_time, '2019-07-02 00:00:00')
        self.assertIsNone(run.end_time)
        self.assertDictEqual(run.info, info)

        # Check time normalization of end time from float.
        run = Run(None, 0.0, info)
        self.assertIsNone(run.start_time)
        self.assertEqual(run.end_time, '1970-01-01 00:00:00')
        self.assertDictEqual(run.info, info)

        # Check time normalization of end time from string.
        run = Run(None, '2019-07-01 01:02:03', info)
        self.assertIsNone(run.start_time)
        self.assertEqual(run.end_time, '2019-07-01 01:02:03')
        self.assertDictEqual(run.info, info)

        # Check time normalization of end time from datetime.
        run = Run(None, datetime(2019, 7, 2), info)
        self.assertIsNone(run.start_time)
        self.assertEqual(run.end_time, '2019-07-02 00:00:00')
        self.assertDictEqual(run.info, info)

        # Test empty start and end time.
        run = Run(info=info)
        self.assertIsNone(run.start_time)
        self.assertIsNone(run.end_time)
        self.assertDictEqual(run.info, info)

        # Check missing llvm_project_revision entry.
        self.assertRaisesRegex(ValueError,
                               "Missing 'llvm_project_revision' entry in 'info' dictionary", Run, 0.0, info={})

    def test_update(self):
        info = {'llvm_project_revision': '18246'}

        # Check update with a supplied end time.
        run = Run(0.0, info=info)
        run.update_endtime(datetime(2019, 8, 2))
        self.assertEqual(run.end_time, '2019-08-02 00:00:00')

        # Check update with default end time: end time = None.
        run = Run(0.0, info=info)
        self.assertIsNone(run.end_time)
        run.update_endtime()
        self.assertIsNone(run.end_time)

    def test_render(self):
        info = {'llvm_project_revision': '18246'}

        # Check rendering with start and end time.
        run = Run('2019-07-01 01:02:03', '2019-07-01 04:00:00', info=info)
        d = {'start_time': '2019-07-01 01:02:03',
             'end_time': '2019-07-01 04:00:00',
             'llvm_project_revision': '18246'}
        self.assertDictEqual(run.render(), d)

        # Check rendering without start time.
        run = Run(end_time='2019-07-01 04:00:00', info=info)
        d = {'end_time': '2019-07-01 04:00:00',
             'llvm_project_revision': '18246'}
        self.assertDictEqual(run.render(), d)

        # Check rendering without end time.
        run = Run('2019-07-01 01:02:03', info=info)
        d = {'start_time': '2019-07-01 01:02:03',
             'llvm_project_revision': '18246'}
        self.assertDictEqual(run.render(), d)


class TestMachine(unittest.TestCase):
    def test_constructor(self):
        info = {'CPUs': '2'}

        # Check constructor with no info.
        m = Machine('Machine1')
        self.assertEqual(m.name, 'Machine1')
        self.assertDictEqual(m.info, {})

        # Check constructor with info.
        m = Machine('Machine2', info=info)
        self.assertEqual(m.name, 'Machine2')
        self.assertDictEqual(m.info, info)

    def test_render(self):
        # Check rendering with no info.
        m = Machine('Machine1')
        d = {'name': 'Machine1'}
        self.assertDictEqual(m.render(), d)

        # Check rendering with info.
        m = Machine('Machine2', info={'CPUs': '2'})
        d = {'name': 'Machine2', 'CPUs': '2'}
        self.assertDictEqual(m.render(), d)


class TestReport(unittest.TestCase):
    maxDiff = None

    def setUp(self):
        self.machine = Machine('Machine', info={'nb_cpus': 2})
        self.run = Run(0.0, info={'llvm_project_revision': '18246'})
        samples = MetricSamples('execution_time', [21.4, 3.2])
        self.tests = [Test('Test', [samples], {'nb_files': 2})]

    def test_constructor(self):
        # Check successful constructor call.
        report = Report(self.machine, self.run, self.tests)
        self.assertEqual(report.machine, self.machine)
        self.assertEqual(report.run, self.run)
        self.assertListEqual(report.tests, self.tests)

    def test_update_report(self):
        # Check update with default (=None) end time.
        report = Report(self.machine, self.run, self.tests)
        new_samples = [Test('Test2.exec', [MetricSamples('execution_time', [56.5])])]
        report.update_report(new_samples)
        self.assertListEqual(report.tests, self.tests + new_samples)
        self.assertIsNone(report.run.end_time)

        # Check update with supplied end time.
        report = Report(self.machine, self.run, self.tests)
        new_samples = [Test('Test3.exec', [MetricSamples('execution_time', [18.3])])]
        report.update_report(new_samples, '1990-07-07 00:00:00')
        self.assertListEqual(report.tests, self.tests + new_samples)
        self.assertEqual(report.run.end_time, '1990-07-07 00:00:00')

    def test_render(self):
        report = Report(self.machine, self.run, self.tests)

        # Check rendering with default indentation.
        self.assertMultiLineEqual(re.sub(r' +\n', '\n', report.render()), """\
{
    "format_version": "2",
    "machine": {
        "name": "Machine",
        "nb_cpus": "2"
    },
    "run": {
        "llvm_project_revision": "18246",
        "start_time": "1970-01-01 00:00:00"
    },
    "tests": [
        {
            "execution_time": [
                21.4,
                3.2
            ],
            "name": "Test",
            "nb_files": "2"
        }
    ]
}""")

        # Check rendering with supplied indentation.
        self.assertMultiLineEqual(re.sub(r' +\n', '\n', report.render(indent=2)), """\
{
  "format_version": "2",
  "machine": {
    "name": "Machine",
    "nb_cpus": "2"
  },
  "run": {
    "llvm_project_revision": "18246",
    "start_time": "1970-01-01 00:00:00"
  },
  "tests": [
    {
      "execution_time": [
        21.4,
        3.2
      ],
      "name": "Test",
      "nb_files": "2"
    }
  ]
}""")

        # Check rendering with single sample for a metric and
        # default indentation.
        report.tests[0].samples[0].data.pop()
        self.assertMultiLineEqual(re.sub(r' +\n', '\n', report.render()), """\
{
    "format_version": "2",
    "machine": {
        "name": "Machine",
        "nb_cpus": "2"
    },
    "run": {
        "llvm_project_revision": "18246",
        "start_time": "1970-01-01 00:00:00"
    },
    "tests": [
        {
            "execution_time": 21.4,
            "name": "Test",
            "nb_files": "2"
        }
    ]
}""")


if __name__ == '__main__':
    unittest.main(argv=[sys.argv[0], ])

"""
Utilities for working with the LNT test format.

Clients can easily generate LNT test format data by creating Report
objects for the runs they wish to submit, and using Report.render to
convert them to JSON data suitable for submitting to the server.
"""

import datetime
import re
from lnt.util import logger

try:
    import json
except ImportError:
    import simplejson as json

# We define the following constants for use as sample values by
# convention.
PASS = 0
FAIL = 1
XFAIL = 2


def normalize_time(t):
    if isinstance(t, float):
        t = datetime.datetime.utcfromtimestamp(t)
    elif not isinstance(t, datetime.datetime):
        t = datetime.datetime.strptime(t, '%Y-%m-%d %H:%M:%S')
    return t.strftime('%Y-%m-%d %H:%M:%S')


class Report:
    """Information on a single testing run.

    In the LNT test model, every test run should define exactly one
    machine and run, and any number of test samples.
    """
    def __init__(self, machine, run, tests, report_version=1):
        """Construct a LNT report file format in the given format version."""
        self.machine = machine
        self.run = run
        self.tests = list(tests)
        self.report_version = report_version
        self.check()

    def check(self):
        """Check that object members are adequate to generate an LNT
        json report file of the version specified at construction when
        rendering that instance.
        """
        # Check requested report version is supported by this library
        assert self.report_version <= 2, "Only v2 or older LNT report format supported."

        assert isinstance(self.machine, Machine), "Unexpected type for machine."
        assert (
            self.machine.report_version == self.report_version
        ), "Mismatch between machine and report version."

        assert isinstance(self.run, Run), "Unexpected type for run."
        assert (
            self.run.report_version == self.report_version
        ), "Mismatch between run and report version."

        for t in self.tests:
            if self.report_version == 2:
                assert isinstance(t, Test), "Unexpected type for test"
                assert (
                    t.report_version == self.report_version
                ), "Mismatch between test and report version."
            else:
                assert isinstance(t, TestSamples), "Unexpected type for test samples."

    def update_report(self, new_tests_samples, end_time=None):
        """Add extra samples to this report, and update the end time of
        the run.
        """
        self.check()
        self.tests.extend(new_tests_samples)
        self.run.update_endtime(end_time)
        self.check()

    def render(self, indent=4):
        """Return a LNT json report file format of the version specified
        at construction as a string, where each object is indented by
        indent spaces compared to its parent.
        """
        if self.report_version == 2:
            return json.dumps({'format_version': str(self.report_version),
                               'machine': self.machine.render(),
                               'run': self.run.render(),
                               'tests': [t.render() for t in self.tests]},
                              sort_keys=True, indent=indent)
        else:
            return json.dumps({'Machine': self.machine.render(),
                               'Run': self.run.render(),
                               'Tests': [t.render() for t in self.tests]},
                              sort_keys=True, indent=indent)


class Machine:
    """Information on the machine the test was run on.

    The info dictionary can be used to describe additional information
    about the machine, for example the hardware resources or the
    operating environment.

    Machines entries in the database are uniqued by their name and the
    entire contents of the info dictionary.
    """
    def __init__(self, name, info={}, report_version=1):
        self.name = str(name)
        self.info = dict((str(key), str(value))
                         for key, value in info.items())
        self.report_version = report_version
        self.check()

    def check(self):
        """Check object members are adequate to generate an LNT json
        report file of the version specified at construction when
        rendering that instance.
        """
        # Check requested version is supported by this library
        assert (
            self.report_version <= 2
        ), "Only v2 or older supported for LNT report format Machine objects."

    def render(self):
        """Return info from this instance in a dictionary that respects
        the LNT report format in the version specified at construction
        when printed as json.
        """
        if self.report_version == 2:
            d = dict(self.info)
            d['Name'] = self.name
            return d
        else:
            return {'Name': self.name,
                    'Info': self.info}


class Run:
    """Information on the particular test run.

    At least one parameter must be supplied and is used as ordering
    among several runs. When generating a report in format 1 or earlier,
    both start_time and end_time are used for that effect and the
    current date is used if their value is None.

    As with Machine, the info dictionary can be used to describe
    additional information on the run. This dictionary should be used to
    describe information on the software-under-test that is constant
    across the test run, for example the revision number being tested.
    It can also be used to describe information about the current state
    which could be useful in analysis, for example the current machine
    load.
    """
    def __init__(self, start_time=None, end_time=None, info={}, report_version=1):
        if report_version <= 1:
            if start_time is None:
                start_time = datetime.datetime.utcnow()
            if end_time is None:
                end_time = datetime.datetime.utcnow()
        self.start_time = normalize_time(start_time) if start_time is not None else None
        self.end_time = normalize_time(end_time) if end_time is not None else None
        self.info = dict()
        # Convert keys/values that are not json encodable to strings.
        for key, value in info.items():
            key = str(key)
            value = str(value)
            self.info[key] = value
        self.report_version = report_version
        if self.report_version <= 1:
            if 'tag' not in self.info:
                raise ValueError("Missing 'tag' entry in 'info' dictionary")
            if 'run_order' not in self.info:
                raise ValueError("Missing 'run_order' entry in 'info' dictionary")
        else:
            if 'llvm_project_revision' not in self.info:
                raise ValueError("Missing 'llvm_project_revision' entry in 'info' dictionary")
        if '__report_version__' in info:
            raise ValueError("'__report_version__' key is reserved")
        if report_version == 1:
            self.info['__report_version__'] = '1'
        self.check()

    def check(self):
        """Check object members are adequate to generate an LNT json
        report file of the version specified at construction when
        rendering that instance.
        """
        # Check requested version is supported by this library
        assert (
            self.report_version <= 2
        ), "Only v2 or older supported for LNT report format Run objects."
        if self.start_time is None and self.end_time is None and not bool(self.info):
            raise ValueError("No data defined in this Run")

    def update_endtime(self, end_time=None):
        """Update the end time of this run."""
        if self.report_version <= 1 and end_time is None:
            end_time = datetime.datetime.utcnow()
        self.end_time = normalize_time(end_time) if end_time else None
        self.check()

    def render(self):
        """Return info from this instance in a dictionary that respects
        the LNT report format in the version specified at construction
        when printed as json.
        """
        if self.report_version == 2:
            d = dict(self.info)
            if self.start_time is not None:
                d['start_time'] = self.start_time
            if self.end_time is not None:
                d['end_time'] = self.end_time
            return d
        else:
            info = dict(self.info)
            if self.report_version == 1:
                info['__report_version__'] = '1'
            return {'Start Time': self.start_time,
                    'End Time': self.end_time,
                    'Info': info}


class Test:
    """Information on a particular test in the run and its associated
    samples.

    The server automatically creates test database objects whenever a
    new test name is seen. Test should be used to generate report in
    version 2 or later of LNT JSON report file format.

    Test names are intended to be a persistent, recognizable identifier
    for what is being executed. Currently, most formats use some form of
    dotted notation for the test name, and this may become enshrined in
    the format in the future. In general, the test names should be
    independent of the software-under-test and refer to some known
    quantity, for example the software under test. For example,
    'CINT2006.403_gcc' is a meaningful test name.

    The test info dictionary is intended to hold information on the
    particular permutation of the test that was run. This might include
    variables specific to the software-under-test . This could include,
    for example, the compile flags the test was built with, or the
    runtime parameters that were used. As a general rule, if two test
    samples are meaningfully and directly comparable, then they should
    have the same test name but different info paramaters.
    """

    def __init__(self, name, samples, info={}, report_version=2):
        self.name = name
        self.samples = samples
        self.info = dict()
        # Convert keys/values that are not json encodable to strings.
        for key, value in info.items():
            key = str(key)
            value = str(value)
            self.info[key] = value
        self.report_version = report_version
        self.check()

    def check(self):
        """Check object members are adequate to generate an LNT json
        report file of the version specified at construction when
        rendering that instance.
        """
        # Check requested version is supported by this library and is
        # valid for this object.
        assert (
            self.report_version == 2
        ), "Only v2 supported for LNT report format Test objects."
        for s in self.samples:
            assert isinstance(s, MetricSamples), "Unexpected type for metric sample."
            assert (
                s.report_version == self.report_version
            ), "Mismatch between test and metric samples."

    def render(self):
        """Return info from this instance in a dictionary that respects
        the LNT report format in the version specified at construction
        when printed as json.
        """
        d = dict(self.info)
        d.update([s.render().popitem() for s in self.samples])
        d['Name'] = self.name
        return d


class TestSamples:
    """Information on a given test and its associated samples data.

    Samples data must all relate to the same metric. When several
    metrics are available for a given test, the convention is to have
    one TestSamples per metric and to encode the metric into the name,
    e.g. Benchmark1.exec. The server automatically creates test database
    objects whenever a new test name is seen. TestSamples should only be
    used to generate report in version 1 or earlier of LNT JSON report
    file format.

    Test names are intended to be a persistent, recognizable identifier
    for what is being executed. Currently, most formats use some form of
    dotted notation for the test name, and this may become enshrined in
    the format in the future. In general, the test names should be
    independent of the software-under-test and refer to some known
    quantity, for example the software under test. For example,
    'CINT2006.403_gcc' is a meaningful test name.

    The test info dictionary is intended to hold information on the
    particular permutation of the test that was run. This might include
    variables specific to the software-under-test . This could include,
    for example, the compile flags the test was built with, or the
    runtime parameters that were used. As a general rule, if two test
    samples are meaningfully and directly comparable, then they should
    have the same test name but different info paramaters.

    The report may include an arbitrary number of samples for each test
    for situations where the same test is run multiple times to gather
    statistical data.
    """

    def __init__(self, name, data, info={}, conv_f=float):
        """Create an instance representing the samples converted into
        floating-point values using the conv_f function.
        """
        self.name = str(name)
        self.info = dict((str(key), str(value))
                         for key, value in info.items())
        self.data = list(map(conv_f, data))

    def render(self):
        """Return info from this instance in a dictionary that respects
        the LNT report format in the version specified at construction
        when printed as json.
        """
        return {'Name': self.name,
                'Info': self.info,
                'Data': self.data}

    def __repr__(self):
        # TODO remove this
        return "TestSample({}): {} - {}".format(self.name,
                                                self.data,
                                                self.info)


class MetricSamples:
    """Samples data for a given metric of a given test.

    An arbitrary number of samples for a given metric is allowed for
    situations where the same metric is obtained several time for a
    given test to gather statistical data.

    MetricSamples should be used to generate report in version 2 or
    later of LNT JSON report file format.
    """

    def __init__(self, metric, data, conv_f=float, report_version=2):
        self.metric = str(metric)
        self.data = list(map(conv_f, data))
        self.report_version = report_version
        self.check()

    def check(self):
        """Check object members are adequate to generate an LNT json
        report file of the version specified at construction when
        rendering that instance.
        """
        # Check requested version is supported by this library and is
        # valid for this object.
        assert (
            self.report_version == 2
        ), "Only v2 supported for LNT report format MetricSamples objects."

    def add_samples(self, new_samples, conv_f=float):
        """Add samples for this metric, converted to float by calling
        function conv_f.
        """
        self.data.extend(map(conv_f, new_samples))

    def render(self):
        """Return info from this instance in a dictionary that respects
        the LNT report format in the version specified at construction
        when printed as json.
        """
        return {self.metric: self.data if len(self.data) > 1 else self.data[0]}


###
# Format Versioning

# We record information on the report "version" to allow the server to support
# some level of auto-upgrading data from submissions of older reports.
#
# We recorder the report version as a reserved key in the run information
# (primarily so that it can be accessed post-import on the server).
#
# Version 0 --           : initial (and unversioned).
#
# Version 1 -- 2012-04-12: run_order was changed to not be padded, and allow
# non-integral values.
#
# Version 2 -- 2017-06:  Revamped json format
#    - Directly uses lnt names (no 'info_key' names anymore)
#    - Flatten Machine.Info and Run.Info into the Machine and Run records
#    - One record for each test (not one record for test+metric) with one entry
#      for each metric.
def _get_format_version(data):
    format_version = data.get('format_version')
    if format_version is not None:
        return int(format_version)

    # Older versions had a Run.Info.__report_version__ field
    run = data.get('Run')
    if run is not None:
        info = run.get('Info')
        if info is not None:
            report_version = info.get('__report_version__', '0')
            return int(report_version)

    return None


def upgrade_0_to_1(data):
    # We recompute the run_order here if it looks like this run_order was
    # derived (we presume from sniffing a compiler).
    run_info = data['Run']['Info']
    run_order = run_info.get('run_order')
    inferred_run_order = run_info.get('inferred_run_order')

    # If the run order is missing, or wasn't the inferred one, do nothing.
    if run_order is None or (run_order != inferred_run_order and
                             inferred_run_order is not None):
        return data

    # Otherwise, assume this run order was derived.

    # Trim whitespace.
    run_order = run_order.strip()
    run_info['run_order'] = run_info['inferred_run_order'] = run_order

    # If this was a production Clang build, try to recompute the src tag.
    if 'clang' in run_info.get('cc_name', '') and \
            run_info.get('cc_build') == 'PROD' and \
            run_info.get('cc_src_tag') and \
            run_order == run_info['cc_src_tag'].strip():
        # Extract the version line.
        version_ln = None
        for ln in run_info.get('cc_version', '').split('\n'):
            if ' version ' in ln:
                version_ln = ln
                break
        else:
            # We are done if we didn't find one.
            return data

        # Extract the build string.
        m = re.match(r'(.*) version ([^ ]*) (\([^(]*\))(.*)',
                     version_ln)
        if not m:
            return data

        cc_name, cc_version_num, cc_build_string, cc_extra = m.groups()
        m = re.search('clang-([0-9.]*)', cc_build_string)
        if m:
            run_info['run_order'] = run_info['inferred_run_order'] = \
                run_info['cc_src_tag'] = m.group(1)
    data['Run']['Info']['__report_version__'] = "1"
    return data


# Upgrading from version 1 to version 2 needs some schema in place
class _UpgradeSchema(object):
    def __init__(self, metric_rename, machine_param_rename, run_param_rename):
        self.metric_rename = metric_rename
        self.machine_param_rename = machine_param_rename
        self.run_param_rename = run_param_rename


_nts_upgrade = _UpgradeSchema(
    metric_rename={
        '.code_size': 'code_size',
        '.compile': 'compile_time',
        '.compile.status': 'compile_status',
        '.exec': 'execution_time',
        '.exec.status': 'execution_status',
        '.hash': 'hash',
        '.hash.status': 'hash_status',
        '.mem': 'mem_bytes',
        '.score': 'score',
    }, machine_param_rename={
        'name': 'hostname',  # Avoid name clash with actual machine name.
    }, run_param_rename={
        'run_order': 'llvm_project_revision',
    }
)
_compile_upgrade = _UpgradeSchema(
    metric_rename={
        '.mem': 'mem_bytes',
        '.mem.status': 'mem_status',
        '.size': 'size_bytes',
        '.size.status': 'size_status',
        '.sys': 'sys_time',
        '.sys.status': 'sys_status',
        '.user': 'user_time',
        '.user.status': 'user_status',
        '.wall': 'wall_time',
        '.wall.status': 'wall_status',
    }, machine_param_rename={
        'hw.model': 'hardware',
        'kern.version': 'os_version',
        'name': 'hostname',
    }, run_param_rename={
        'run_order': 'llvm_project_revision',
    }
)
_default_upgrade = _UpgradeSchema(
    metric_rename={},
    machine_param_rename={},
    run_param_rename={
        'run_order': 'llvm_project_revision',
    }
)
_upgrades = {
    'nts': _nts_upgrade,
    'compile': _compile_upgrade
}


def upgrade_1_to_2(data, ts_name):
    result = dict()

    # Pull version and database schema to toplevel
    result['format_version'] = '2'
    report_version = data['Run']['Info'].pop('__report_version__', '1')
    # We should not be in upgrade_1_to_2 for other versions
    assert(report_version == '1')
    tag = data['Run']['Info'].pop('tag', None)
    if tag is not None and tag != ts_name:
        raise ValueError("Importing '%s' data into '%s' testsuite" %
                         (tag, ts_name))

    upgrade = _upgrades.get(tag)
    if upgrade is None:
        logger.warning("No upgrade schema known for '%s'\n" % tag)
        upgrade = _default_upgrade

    # Flatten Machine.Info into machine
    Machine = data['Machine']
    result_machine = {'name': Machine['Name']}
    for key, value in Machine['Info'].items():
        newname = upgrade.machine_param_rename.get(key, key)
        if newname in result_machine:
            raise ValueError("Name clash for machine info '%s'" % newname)
        result_machine[newname] = value
    result['machine'] = result_machine

    # Flatten Result.Info into result
    Run = data['Run']
    result_run = {}
    start_time = Run.get('Start Time')
    if start_time is not None:
        result_run['start_time'] = start_time
    end_time = Run.get('End Time')
    if end_time is not None:
        result_run['end_time'] = end_time
    for key, value in Run['Info'].items():
        newname = upgrade.run_param_rename.get(key, key)
        if newname in result_run:
            raise ValueError("Name clash for run info '%s'" % newname)
        result_run[newname] = value
    result['run'] = result_run

    # Merge tests
    result_tests = list()
    result_tests_dict = dict()
    Tests = data['Tests']
    for test in Tests:
        test_Name = test['Name']

        # Old testnames always started with 'tag.', split that part.
        if len(test['Info']) != 0:
            # The Info record didn't work with the v4 database anyway...
            raise ValueError("Tests/%s: cannot convert non-empty Info record" %
                             test_Name)
        tag_dot = '%s.' % ts_name
        if not test_Name.startswith(tag_dot):
            raise ValueError("Tests/%s: test name does not start with '%s'" %
                             (test_Name, tag_dot))
        name_metric = test_Name[len(tag_dot):]

        found_metric = False
        for oldname, newname in upgrade.metric_rename.items():
            assert(oldname.startswith('.'))
            if name_metric.endswith(oldname):
                name = name_metric[:-len(oldname)]
                metric = newname
                found_metric = True
                break
        if not found_metric:
            # Fallback logic for unknown metrics: Assume they are '.xxxx'
            name, dot, metric = name_metric.rpartition('.')
            if dot != '.':
                raise ValueError("Tests/%s: name does not end in .metric" %
                                 test_Name)
            logger.warning("Found unknown metric '%s'" % metric)
            upgrade.metric_rename['.'+metric] = metric

        result_test = result_tests_dict.get(name)
        if result_test is None:
            result_test = {'name': name}
            result_tests_dict[name] = result_test
            result_tests.append(result_test)

        data = test['Data']
        if metric not in result_test:
            # Do not construct a list for the very common case of just a
            # single datum.
            if len(data) == 1:
                data = data[0]
            result_test[metric] = data
        elif len(data) > 0:
            # Transform the test data into a list
            if not isinstance(result_test[metric], list):
                result_test[metric] = [result_test[metric]]
            result_test[metric] += data

    result['tests'] = result_tests
    return result


def upgrade_and_normalize_report(data, ts_name):
    # Get the report version. V2 has it at the top level, older version
    # in Run.Info.
    format_version = _get_format_version(data)
    if format_version is None:
        data['format_version'] = '2'
        format_version = 2

    if format_version == 0:
        data = upgrade_0_to_1(data)
        format_version = 1
    if format_version == 1:
        data = upgrade_1_to_2(data, ts_name)
        format_version = 2

    if format_version != 2 or data['format_version'] != '2':
        raise ValueError("Unknown format version")
    if 'run' not in data:
        import pprint
        logger.info(pprint.pformat(data))
        raise ValueError("No 'run' section in submission")
    if 'machine' not in data:
        raise ValueError("No 'machine' section in submission")
    if 'tests' not in data:
        raise ValueError("No 'tests' section in submission")

    run = data['run']
    if 'start_time' not in run:
        time = datetime.datetime.utcnow().replace(microsecond=0).isoformat()
        run['start_time'] = time
        run['end_time'] = time
    elif 'end_time' not in run:
        run['end_time'] = run['start_time']

    return data


__all__ = ['Report', 'Machine', 'Run', 'TestSamples']

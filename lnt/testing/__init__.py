"""
Utilities for working with the LNT test format.

Clients can easily generate LNT test format data by creating Report objects for
the runs they wish to submit, and using Report.render to convert them to JSON
data suitable for submitting to the server.
"""

import datetime
import re

try:
    import json
except ImportError:
    import simplejson as json

# We define the following constants for use as sample values by convention.
PASS = 0
FAIL = 1
XFAIL = 2

def normalize_time(t):
    if isinstance(t,float):
        t = datetime.datetime.utcfromtimestamp(t)
    elif not isinstance(t, datetime.datetime):
        t = datetime.datetime.strptime(t, '%Y-%m-%d %H:%M:%S')
    return t.strftime('%Y-%m-%d %H:%M:%S')

class Report:
    """Information on a single testing run.

    In the LNT test model, every test run should define exactly one machine and
    run, and any number of test samples.
    """
    def __init__(self, machine, run, tests):
        self.machine = machine
        self.run = run
        self.tests = list(tests)
        self.report_version = current_version
        self.check()

    def check(self):
        assert isinstance(self.machine, Machine)
        assert isinstance(self.run, Run)
        for t in self.tests:
            assert isinstance(t, TestSamples)

    def render(self, indent=4):
        # Note that we specifically override the encoding to avoid the
        # possibility of encoding errors. Clients which care about the text
        # encoding should supply unicode string objects.
        return json.dumps({ 'Machine' : self.machine.render(),
                            'Run' : self.run.render(),
                            'Tests' : [t.render() for t in self.tests] },
                          sort_keys=True, indent=indent, encoding='latin-1')

class Machine:
    """Information on the machine the test was run on.

    The info dictionary can be used to describe additional information about the
    machine, for example the hardware resources or the operating environment.

    Machines entries in the database are uniqued by their name and the entire
    contents of the info dictionary.
    """
    def __init__(self, name, info={}):
        self.name = str(name)
        self.info = dict((str(key),str(value))
                         for key,value in info.items())

    def render(self):
        return { 'Name' : self.name,
                 'Info' : self.info }

class Run:
    """Information on the particular test run.

    The start and end time should always be supplied with the run. Currently,
    the server uses these to order runs. In the future we will support
    additional ways to order runs (for example, by a source revision).

    As with Machine, the info dictionary can be used to describe additional
    information on the run. This dictionary should be used to describe
    information on the software-under-test that is constant across the test run,
    for example the revision number being tested. It can also be used to
    describe information about the current state which could be useful in
    analysis, for example the current machine load.
    """
    def __init__(self, start_time, end_time, info={}):
        if start_time is None:
            start_time = datetime.datetime.utcnow()
        if end_time is None:
            end_time = datetime.datetime.utcnow()

        self.start_time = normalize_time(start_time)
        self.end_time = normalize_time(end_time)
        self.info = dict((str(key),str(value))
                         for key,value in info.items())
        if '__report_version__' in self.info:
            raise ValueError("'__report_version__' key is reserved")
        self.info['__report_version__'] = str(current_version)

    def render(self):
        return { 'Start Time' : self.start_time,
                 'End Time' : self.end_time,
                 'Info' : self.info }

class TestSamples:
    """Test sample data.

    The test sample data defines both the tests that were run and their
    values. The server automatically creates test database objects whenever a
    new test name is seen.

    Test names are intended to be a persistent, recognizable identifier for what
    is being executed. Currently, most formats use some form of dotted notation
    for the test name, and this may become enshrined in the format in the
    future. In general, the test names should be independent of the
    software-under-test and refer to some known quantity, for example the
    software under test. For example, 'CINT2006.403_gcc' is a meaningful test
    name.

    The test info dictionary is intended to hold information on the particular
    permutation of the test that was run. This might include variables specific
    to the software-under-test . This could include, for example, the compile
    flags the test was built with, or the runtime parameters that were used. As
    a general rule, if two test samples are meaningfully and directly
    comparable, then the should have the same test name but different info
    paramaters.

    The report may include an arbitrary number of samples for each test for
    situations where the same test is run multiple times to gather statistical
    data.
    """

    def __init__(self, name, data, info={}):
        self.name = str(name)
        self.info = dict((str(key),str(value))
                         for key,value in info.items())
        self.data = map(float, data)

    def render(self):
        return { 'Name' : self.name,
                 'Info' : self.info,
                 'Data' : self.data }

###
# Report Versioning

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
current_version = 1

def upgrade_0_to_1(data):
    # We recompute the run_order here if it looks like this run_order was
    # derived (we presume from sniffing a compiler).
    run_info = data['Run']['Info']
    run_order = run_info.get('run_order')
    inferred_run_order = run_info.get('inferred_run_order')

    # If the run order is missing, or wasn't the inferred one, do nothing.
    if run_order is None or (run_order != inferred_run_order and
                             inferred_run_order is not None):
        return

    # Otherwise, assume this run order was derived.

    # Trim whitespace.
    run_order = run_order.strip()
    run_info['run_order'] = run_info['inferred_run_order'] = run_order

    # If this was a production Clang build, try to recompute the src tag.
    if 'clang' in run_info.get('cc_name','') and \
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
            return

        # Extract the build string.
        m = re.match(r'(.*) version ([^ ]*) (\([^(]*\))(.*)',
                     version_ln)
        if not m:
            return

        cc_name,cc_version_num,cc_build_string,cc_extra = m.groups()
        m = re.search('clang-([0-9.]*)', cc_build_string)
        if m:
            run_info['run_order'] = run_info['inferred_run_order'] = \
                run_info['cc_src_tag'] = m.group(1)

def upgrade_report(data):
    # Get the report version.
    report_version = int(data['Run']['Info'].get('__report_version__', 0))

    # Check if the report is current.
    if report_version == current_version:
        return data

    # Check if the version is out-of-range.
    if report_version > current_version:
        raise ValueError("unknown report version: %r" % (report_version,))

    # Otherwise, we need to upgrade it.
    for version in range(report_version, current_version):
        upgrade_method = globals().get('upgrade_%d_to_%d' % (
                version, version+1))
        upgrade_method(data)
        data['Run']['Info']['__report_version__'] = str(version + 1)

__all__ = ['Report', 'Machine', 'Run', 'TestSamples']

import subprocess
import tempfile
import json
import os
import shlex
import platform
import pipes
import sys
import shutil
import glob
import re
import multiprocessing
import getpass

import datetime
from collections import defaultdict
import jinja2
import click

import lnt.testing
import lnt.testing.profile
import lnt.testing.util.compilers
from lnt.testing.util.misc import timestamp
from lnt.testing.util.commands import note, fatal, warning
from lnt.testing.util.commands import mkdir_p
from lnt.testing.util.commands import resolve_command_path, isexecfile

from lnt.tests.builtintest import BuiltinTest

# This is the list of architectures in
# test-suite/cmake/modules/DetectArchitecture.cmake. If you update this list,
# make sure that cmake file is updated too.
TEST_SUITE_KNOWN_ARCHITECTURES = ['ARM', 'AArch64', 'Mips', 'X86']
KNOWN_SAMPLE_KEYS = ['compile', 'exec', 'hash', 'score']

XML_REPORT_TEMPLATE = """<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
{%  for suite in suites %}
<testsuite name="{{ suite.name }}"
           tests="{{ suite.num_tests }}"
           errors="{{ suite.num_errors }}"
           failures="{{ suite.num_failures }}"
           timestamp="{{suite.timestamp}}"
           hostname="localhost"
           time="0"
           package="{{suite.name}}"
           id="{{suite.id}}">
    <properties></properties>
    {% for test in suite.tests %}
    <testcase classname="{{ test.path }}"
              name="{{ test.name }}" time="{{ test.time }}">
        {% if test.code == "NOEXE"%}
            <error type="{{test.code}}">
            {{ test.output }}
            </error>
        {% endif %}
        {% if test.code == "FAIL"%}
            <failure type="{{test.code}}">
            {{ test.output }}
            </failure>
        {% endif %}
    </testcase>
    {% endfor %}
    <system-out></system-out>
    <system-err></system-err>
</testsuite>
{% endfor %}
</testsuites>
"""

CSV_REPORT_TEMPLATE = \
"""Program;CC;CC_Time;CC_Hash;Exec;Exec_Time;Score
{%- for suite in suites -%}
    {%- for test in suite.tests %}
{{ suite.name }}/{{ test.path }}/{{ test.name }};
        {%- if test.code == "NOEXE" -%}
            fail;*;*;
        {%- else -%}
            pass;{{ test.metrics.compile_time if test.metrics }};{{ test.metrics.hash if test.metrics }};
        {%- endif -%}
        {%- if test.code == "FAIL" or test.code == "NOEXE" -%}
            fail;*;*;
        {%- else -%}
            pass;{{ test.metrics.exec_time if test.metrics }};{{ test.metrics.score if test.metrics }};
        {%- endif -%}
    {% endfor %}
{%- endfor -%}
"""

# _importProfile imports a single profile. It must be at the top level (and
# not within TestSuiteTest) so that multiprocessing can import it correctly.
def _importProfile(name_filename):
    name, filename = name_filename

    if not os.path.exists(filename):
        warning('Profile %s does not exist' % filename)
        return None

    pf = lnt.testing.profile.profile.Profile.fromFile(filename)
    if not pf:
        return None

    pf.upgrade()
    profilefile = pf.render()
    return lnt.testing.TestSamples(name + '.profile',
                                   [profilefile],
                                   {},
                                   str)


def _lit_json_to_template(json_reports, template_engine):
    # For now, only show first runs report.
    json_report = json_reports[0]
    tests_by_suite = defaultdict(list)
    for tests in json_report['tests']:
        name = tests['name']
        code = tests['code']
        time = tests['elapsed']
        output = tests.get('output', 'No output collected for this test.')

        x = name.split("::")
        suite_name = x[1].strip().split("/")[0]
        test_name = x[1].strip().split("/")[-1]
        path = x[1].strip().split("/")[:-1]

        entry = {'name': test_name,
                 'path': '.'.join(path),
                 'time': time,
                 'code': code,
                 'metrics': tests.get('metrics', None)}
        if code != "PASS":
            entry['output'] = output

        tests_by_suite[suite_name].append(entry)
    suites = []
    for id, suite in enumerate(tests_by_suite):
        tests = tests_by_suite[suite]
        entry = {'name': suite,
                 'id': id,
                 'tests': tests,
                 'timestamp': datetime.datetime.now().replace(microsecond=0).isoformat(),
                 'num_tests': len(tests),
                 'num_failures': len(
                     [x for x in tests if x['code'] == 'FAIL']),
                 'num_errors': len(
                     [x for x in tests if x['code'] == 'NOEXE'])}
        suites.append(entry)
    str_template = template_engine.render(suites=suites)
    return str_template


def _lit_json_to_xunit_xml(json_reports):
    # type: (list) -> str
    """Take the lit report jason dicts and convert them
    to an xunit xml report for CI to digest."""
    template_engine = jinja2.Template(XML_REPORT_TEMPLATE, autoescape=True)
    return _lit_json_to_template(json_reports, template_engine)


def _lit_json_to_csv(json_reports):
    # type: (list) -> str
    """Take the lit report json dicts and convert them
    to a csv report, similar to the old test-suite make-based
    *.report.simple.csv files."""
    template_engine = jinja2.Template(CSV_REPORT_TEMPLATE, autoescape=True)
    return _lit_json_to_template(json_reports, template_engine)


class TestSuiteTest(BuiltinTest):
    def __init__(self):
        super(TestSuiteTest, self).__init__()
        self.configured = False
        self.compiled = False
        self.trained = False

    def describe(self):
        return "LLVM test-suite"

    @staticmethod
    @click.command("test-suite")
    @click.argument("label", default=platform.uname()[1], required=False,
                    type=click.UNPROCESSED)
    # Sandbox options
    @click.option("-S", "--sandbox", "sandbox_path", required=True,
                  help="Parent directory to build and run tests in",
                  type=click.UNPROCESSED, metavar="PATH")
    @click.option("--no-timestamp", "timestamp_build",
                  flag_value=False, default=True,
                  help="Don't timestamp build directory (for testing)")
    @click.option("--no-configure", "run_configure",
                  flag_value=False, default=True,
                  help="Don't run CMake if CMakeCache.txt is present"
                       " (only useful with --no-timestamp")
    # Inputs
    @click.option("--test-suite", "test_suite_root",
                  type=click.UNPROCESSED, metavar="PATH",
                  help="Path to the LLVM test-suite sources")
    @click.option("--test-externals", "test_suite_externals",
                  type=click.UNPROCESSED, metavar="PATH",
                  help="Path to the LLVM test-suite externals")
    @click.option("--cmake-define", "cmake_defines",
                  multiple=True,
                  help="Defines to pass to cmake. These do not require the "
                       "-D prefix and can be given multiple times. e.g.: "
                       "--cmake-define A=B => -DA=B")
    @click.option("-C", "--cmake-cache", "cmake_cache", multiple=True,
                  default=[],
                  help="Use one of the test-suite's cmake configurations."
                       " Ex: Release, Debug")
    # Test compiler
    @click.option("--cc", "cc", metavar="CC", type=click.UNPROCESSED,
                  default=None,
                  help="Path to the C compiler to test")
    @click.option("--cxx", "cxx", metavar="CXX", type=click.UNPROCESSED,
                  default=None,
                  help="Path to the C++ compiler to test (inferred from"
                       " --cc where possible")
    @click.option("--cppflags", "cppflags", type=click.UNPROCESSED,
                  multiple=True, default=[],
                  help="Extra flags to pass the compiler in C or C++ mode. "
                       "Can be given multiple times")
    @click.option("--cflags", "--cflag", "cflags", type=click.UNPROCESSED,
                  multiple=True, default=[],
                  help="Extra CFLAGS to pass to the compiler. Can be "
                       "given multiple times")
    @click.option("--cxxflags", "cxxflags", type=click.UNPROCESSED,
                  multiple=True, default=[],
                  help="Extra CXXFLAGS to pass to the compiler. Can be "
                       "given multiple times")
    # Test selection
    @click.option("--test-size", "test_size",
                  type=click.Choice(['small', 'regular', 'large']),
                  default='regular', help="The size of test inputs to use")
    @click.option("--benchmarking-only", "benchmarking_only", is_flag=True,
                  help="Benchmarking-only mode. Disable unit tests and "
                       "other flaky or short-running tests")
    @click.option("--only-test", "only_test", metavar="PATH",
                  type=click.UNPROCESSED, default=None,
                  help="Only run tests under PATH")
    # Test Execution
    @click.option("--only-compile", "only_compile",
                  help="Don't run the tests, just compile them.", is_flag=True)
    @click.option("-j", "--threads", "threads",
                  help="Number of testing (and optionally build) "
                  "threads", type=int, default=1, metavar="N")
    @click.option("--build-threads", "build_threads",
                  help="Number of compilation threads, defaults to --threads",
                  type=int, default=0, metavar="N")
    @click.option("--use-perf", "use_perf",
                  help="Use Linux perf for high accuracy timing, profile "
                       "information or both",
                  type=click.Choice(['none', 'time', 'profile', 'all']),
                  default='none')
    @click.option("--perf-events", "perf_events",
                  help=("Define which linux perf events to measure"),
                  type=click.UNPROCESSED, default=None)
    @click.option("--run-under", "run_under", default="",
                  help="Wrapper to run tests under", type=click.UNPROCESSED)
    @click.option("--exec-multisample", "exec_multisample",
                  help="Accumulate execution test data from multiple runs",
                  type=int, default=1, metavar="N")
    @click.option("--compile-multisample", "compile_multisample",
                  help="Accumulate compile test data from multiple runs",
                  type=int, default=1, metavar="N")
    @click.option("-d", "--diagnose", "diagnose",
                  help="Produce a diagnostic report for a particular "
                       "test, this will not run all the tests.  Must be"
                       " used in conjunction with --only-test.",
                  is_flag=True, default=False,)
    @click.option("--pgo", "pgo",
                  help="Run the test-suite in training mode first and"
                       " collect PGO data, then rerun with that training "
                       "data.",
                  is_flag=True, default=False,)
    # Output Options
    @click.option("--no-auto-name", "auto_name",
                  help="Don't automatically derive submission name",
                  flag_value=False, default=True)
    @click.option("--run-order", "run_order", metavar="STR",
                  help="String to use to identify and order this run")
    @click.option("--submit", "submit_url", metavar="URLORPATH",
                  help="autosubmit the test result to the given server"
                       " (or local instance)",
                  type=click.UNPROCESSED, default=None)
    @click.option("--commit", "commit",
                  help="whether the autosubmit result should be committed",
                  type=int, default=True)
    @click.option("--succinct-compile-output", "succinct",
                  help="run Make without VERBOSE=1", is_flag=True)
    @click.option("-v", "--verbose", "verbose", is_flag=True, default=False,
                  help="show verbose test results")
    @click.option("--exclude-stat-from-submission",
                  "exclude_stat_from_submission",
                  help="Do not submit the stat of this type",
                  multiple=True, default=[],
                  type=click.Choice(KNOWN_SAMPLE_KEYS))
    @click.option("--single-result", "single_result",
                  help="only execute this single test and apply "
                       "--single-result-predicate to calculate the exit "
                       "status")
    @click.option("--single-result-predicate", "single_result_predicate",
                  help="the predicate to apply to calculate the exit "
                       "status (with --single-result)", default="status")
    # Test tools
    @click.option("--use-cmake", "cmake", metavar="PATH",
                  type=click.UNPROCESSED, default="cmake",
                  help="Path to CMake [cmake]")
    @click.option("--use-make", "make", metavar="PATH",
                  type=click.UNPROCESSED, default="make",
                  help="Path to Make [make]")
    @click.option("--use-lit", "lit", metavar="PATH", type=click.UNPROCESSED,
                  default="llvm-lit",
                  help="Path to the LIT test runner [llvm-lit]")
    def cli_wrapper(*args, **kwargs):
        """LLVM test-suite"""
        test_suite = TestSuiteTest()

        for key, value in kwargs.items():
            setattr(test_suite.opts, key, value)

        results = test_suite.run_test(test_suite.opts)
        test_suite.show_results_url(results)

    def run_test(self, opts):

        if self.opts.cc is not None:
            self.opts.cc = resolve_command_path(self.opts.cc)

            if not lnt.testing.util.compilers.is_valid(self.opts.cc):
                self._fatal('--cc does not point to a valid executable.')

            # If there was no --cxx given, attempt to infer it from the --cc.
            if self.opts.cxx is None:
                self.opts.cxx = \
                    lnt.testing.util.compilers.infer_cxx_compiler(self.opts.cc)
                if self.opts.cxx is not None:
                    note("Inferred C++ compiler under test as: %r"
                         % (self.opts.cxx,))
                else:
                    self._fatal("unable to infer --cxx - set it manually.")
            else:
                self.opts.cxx = resolve_command_path(self.opts.cxx)

            if not os.path.exists(self.opts.cxx):
                self._fatal("invalid --cxx argument %r, does not exist"
                            % (self.opts.cxx))

        if opts.test_suite_root is None:
            self._fatal('--test-suite is required')
        if not os.path.exists(opts.test_suite_root):
            self._fatal("invalid --test-suite argument, does not exist: %r" % (
                opts.test_suite_root))

        if opts.test_suite_externals:
            if not os.path.exists(opts.test_suite_externals):
                self._fatal(
                    "invalid --test-externals argument, does not exist: %r" % (
                        opts.test_suite_externals,))

        opts.cmake = resolve_command_path(opts.cmake)
        if not isexecfile(opts.cmake):
            self._fatal("CMake tool not found (looked for %s)" % opts.cmake)
        opts.make = resolve_command_path(opts.make)
        if not isexecfile(opts.make):
            self._fatal("Make tool not found (looked for %s)" % opts.make)
        opts.lit = resolve_command_path(opts.lit)
        if not isexecfile(opts.lit):
            self._fatal("LIT tool not found (looked for %s)" % opts.lit)
        if opts.run_under:
            split = shlex.split(opts.run_under)
            split[0] = resolve_command_path(split[0])
            if not isexecfile(split[0]):
                self._fatal("Run under wrapper not found (looked for %s)" %
                            opts.run_under)

        if opts.single_result:
            # --single-result implies --only-test
            opts.only_test = opts.single_result

        if opts.only_test:
            # --only-test can either point to a particular test or a directory.
            # Therefore, test_suite_root + opts.only_test or
            # test_suite_root + dirname(opts.only_test) must be a directory.
            path = os.path.join(self.opts.test_suite_root, opts.only_test)
            parent_path = os.path.dirname(path)

            if os.path.isdir(path):
                opts.only_test = (opts.only_test, None)
            elif os.path.isdir(parent_path):
                opts.only_test = (os.path.dirname(opts.only_test),
                                  os.path.basename(opts.only_test))
            else:
                self._fatal("--only-test argument not understood (must be a " +
                            " test or directory name)")

        if opts.single_result and not opts.only_test[1]:
            self._fatal("--single-result must be given a single test name, not a " +
                        "directory name")

        opts.cppflags = ' '.join(opts.cppflags)
        opts.cflags = ' '.join(opts.cflags)
        opts.cxxflags = ' '.join(opts.cxxflags)

        if opts.diagnose:
            if not opts.only_test:
                self._fatal("--diagnose requires --only-test")

        self.start_time = timestamp()

        # Work out where to put our build stuff
        if self.opts.timestamp_build:
            ts = self.start_time.replace(' ', '_').replace(':', '-')
            build_dir_name = "test-%s" % ts
        else:
            build_dir_name = "build"
        basedir = os.path.join(self.opts.sandbox_path, build_dir_name)
        self._base_path = basedir

        cmakecache = os.path.join(self._base_path, 'CMakeCache.txt')
        self.configured = not self.opts.run_configure and \
            os.path.exists(cmakecache)

        #  If we are doing diagnostics, skip the usual run and do them now.
        if opts.diagnose:
            return self.diagnose()

        # configure, so we can extract toolchain information from the cmake
        # output.
        self._configure_if_needed()

        # Verify that we can actually find a compiler before continuing
        cmake_vars = self._extract_cmake_vars_from_cache()
        if "CMAKE_C_COMPILER" not in cmake_vars or \
                not os.path.exists(cmake_vars["CMAKE_C_COMPILER"]):
            self._fatal(
                "Couldn't find C compiler (%s). Maybe you should specify --cc?"
                % cmake_vars.get("CMAKE_C_COMPILER"))

        # We don't support compiling without testing as we can't get compile-
        # time numbers from LIT without running the tests.
        if opts.compile_multisample > opts.exec_multisample:
            note("Increasing number of execution samples to %d" %
                 opts.compile_multisample)
            opts.exec_multisample = opts.compile_multisample

        if opts.auto_name:
            # Construct the nickname from a few key parameters.
            cc_info = self._get_cc_info(cmake_vars)
            cc_nick = '%s_%s' % (cc_info['cc_name'], cc_info['cc_build'])
            opts.label += "__%s__%s" % (cc_nick, cc_info['cc_target'].split('-')[0])
        note('Using nickname: %r' % opts.label)

        #  When we can't detect the clang version we use 0 instead. That
        # is a horrible failure mode because all of our data ends up going
        # to order 0.  The user needs to give an order if we can't detect!
        if opts.run_order is None:
            cc_info = self._get_cc_info(cmake_vars)
            if cc_info['inferred_run_order'] == 0:
                fatal("Cannot detect compiler version. Specify --run-order"
                      " to manually define it.")

        # Now do the actual run.
        reports = []
        json_reports = []
        for i in range(max(opts.exec_multisample, opts.compile_multisample)):
            c = i < opts.compile_multisample
            e = i < opts.exec_multisample
            # only gather perf profiles on a single run.
            p = i == 0 and self.opts.use_perf in ('profile', 'all')
            run_report, json_data = self.run(cmake_vars, compile=c, test=e,
                                             profile=p)
            reports.append(run_report)
            json_reports.append(json_data)

        report = self._create_merged_report(reports)

        # Write the report out so it can be read by the submission tool.
        report_path = os.path.join(self._base_path, 'report.json')
        with open(report_path, 'w') as fd:
            fd.write(report.render())

        xml_report_path = os.path.join(self._base_path,
                                       'test-results.xunit.xml')

        str_template = _lit_json_to_xunit_xml(json_reports)
        with open(xml_report_path, 'w') as fd:
            fd.write(str_template)

        csv_report_path = os.path.join(self._base_path,
                                       'test-results.csv')
        str_template = _lit_json_to_csv(json_reports)
        with open(csv_report_path, 'w') as fd:
            fd.write(str_template)

        return self.submit(report_path, self.opts, commit=True)

    def _configure_if_needed(self):
        mkdir_p(self._base_path)
        if not self.configured:
            self._configure(self._base_path)
            self._clean(self._base_path)
            self.configured = True

    def run(self, cmake_vars, compile=True, test=True, profile=False):
        mkdir_p(self._base_path)

        if self.opts.pgo:
            self._collect_pgo(self._base_path)
            self.trained = True
            self.configured = False

        self._configure_if_needed()

        if self.compiled and compile:
            self._clean(self._base_path)
        if not self.compiled or compile:
            self._make(self._base_path)
            self.compiled = True

        data = self._lit(self._base_path, test, profile)
        return self._parse_lit_output(self._base_path, data, cmake_vars), data

    def _create_merged_report(self, reports):
        if len(reports) == 1:
            return reports[0]

        machine = reports[0].machine
        run = reports[0].run
        run.end_time = reports[-1].run.end_time
        test_samples = sum([r.tests for r in reports], [])
        return lnt.testing.Report(machine, run, test_samples)

    def _test_suite_dir(self):
        return self.opts.test_suite_root

    def _build_threads(self):
        return self.opts.build_threads or self.opts.threads

    def _test_threads(self):
        return self.opts.threads

    def _check_call(self, *args, **kwargs):
        note('Execute: %s' % ' '.join(args[0]))
        if 'cwd' in kwargs:
            note('          (In %s)' % kwargs['cwd'])
        return subprocess.check_call(*args, **kwargs)

    def _check_output(self, *args, **kwargs):
        note('Execute: %s' % ' '.join(args[0]))
        if 'cwd' in kwargs:
            note('          (In %s)' % kwargs['cwd'])
        output = subprocess.check_output(*args, **kwargs)
        sys.stdout.write(output)
        return output

    def _clean(self, path):
        make_cmd = self.opts.make

        subdir = path
        if self.opts.only_test:
            components = [path] + [self.opts.only_test[0]]
            subdir = os.path.join(*components)

        self._check_call([make_cmd, 'clean'],
                         cwd=subdir)

    def _configure(self, path, extra_cmake_defs=[], execute=True):
        cmake_cmd = self.opts.cmake

        defs = {}
        if self.opts.cc:
            defs['CMAKE_C_COMPILER'] = self.opts.cc
        if self.opts.cxx:
            defs['CMAKE_CXX_COMPILER'] = self.opts.cxx

        cmake_build_types = ('DEBUG','MINSIZEREL', 'RELEASE', 'RELWITHDEBINFO')
        if self.opts.cppflags or self.opts.cflags:
            all_cflags = ' '.join([self.opts.cppflags, self.opts.cflags])
            defs['CMAKE_C_FLAGS'] = self._unix_quote_args(all_cflags)
            # Ensure that no flags get added based on build type when the user
            # explicitly specifies flags to use.
            for build_type in cmake_build_types:
                defs['CMAKE_C_FLAGS_'+build_type] = ""

        if self.opts.cppflags or self.opts.cxxflags:
            all_cxx_flags = ' '.join([self.opts.cppflags, self.opts.cxxflags])
            defs['CMAKE_CXX_FLAGS'] = self._unix_quote_args(all_cxx_flags)
            # Ensure that no flags get added based on build type when the user
            # explicitly specifies flags to use.
            for build_type in cmake_build_types:
                defs['CMAKE_CXX_FLAGS_'+build_type] = ""

        if self.opts.run_under:
            defs['TEST_SUITE_RUN_UNDER'] = self._unix_quote_args(self.opts.run_under)
        if self.opts.benchmarking_only:
            defs['TEST_SUITE_BENCHMARKING_ONLY'] = 'ON'
        if self.opts.only_compile:
            defs['TEST_SUITE_RUN_BENCHMARKS'] = 'Off'
        if self.opts.use_perf in ('time', 'all'):
            defs['TEST_SUITE_USE_PERF'] = 'ON'
        if self.opts.test_suite_externals:
            defs['TEST_SUITE_EXTERNALS_DIR'] = self.opts.test_suite_externals
        if self.opts.pgo and self.trained:
            defs['TEST_SUITE_PROFILE_USE'] = "On"
            defs['TEST_SUITE_PROFILE_GENERATE'] = "Off"
            if 'TEST_SUITE_RUN_TYPE' not in defs:
                defs['TEST_SUITE_RUN_TYPE'] = 'ref'

        for item in tuple(self.opts.cmake_defines) + tuple(extra_cmake_defs):
            k, v = item.split('=', 1)
            # make sure the overriding of the settings above also works
            # when the cmake-define-defined variable has a datatype
            # specified.
            key_no_datatype = k.split(':', 1)[0]
            if key_no_datatype in defs:
                del defs[key_no_datatype]
            defs[k] = v

        # We use 'cmake -LAH -N' later to find out the value of the
        # CMAKE_C_COMPILER and CMAKE_CXX_COMPILER variables.
        # 'cmake -LAH -N' will only return variables in the cache that have
        # a cmake type set. Therefore, explicitly set a 'FILEPATH' type on
        # these variables here, if they were untyped so far.
        if 'CMAKE_C_COMPILER' in defs:
            defs['CMAKE_C_COMPILER:FILEPATH'] = defs['CMAKE_C_COMPILER']
            del defs['CMAKE_C_COMPILER']
        if 'CMAKE_CXX_COMPILER' in defs:
            defs['CMAKE_CXX_COMPILER:FILEPATH'] = defs['CMAKE_CXX_COMPILER']
            del defs['CMAKE_CXX_COMPILER']

        lines = ['Configuring with {']
        for k, v in sorted(defs.items()):
            lines.append("  %s: '%s'" % (k, v))
        lines.append('}')

        # Prepare cmake cache if requested:
        cmake_flags = []
        for cache in self.opts.cmake_cache:
            # Shortcut for the common case.
            if not cache.endswith(".cmake") and "/" not in cache:
                cache = os.path.join(self._test_suite_dir(),
                                     "cmake/caches", cache + ".cmake")
            if not os.path.exists(cache):
                fatal("Could not find CMake cache file: " + cache)
            cmake_flags += ['-C', cache]

        for l in lines:
            note(l)

        cmake_cmd = [cmake_cmd] + cmake_flags + [self._test_suite_dir()] + \
                    ['-D%s=%s' % (k, v) for k, v in defs.items()]
        if execute:
            self._check_call(cmake_cmd, cwd=path)

        return cmake_cmd

    def _collect_pgo(self, path):
        extra_defs = ["TEST_SUITE_PROFILE_GENERATE=On",
                      "TEST_SUITE_RUN_TYPE=train"]
        self._configure(path, extra_cmake_defs=extra_defs)
        self._make(path)
        self._lit(path, True, False)

    def _make(self, path):
        make_cmd = self.opts.make

        subdir = path
        target = 'all'
        if self.opts.only_test:
            components = [path] + [self.opts.only_test[0]]
            if self.opts.only_test[1]:
                target = self.opts.only_test[1]
            subdir = os.path.join(*components)

        note('Building...')
        if not self.opts.succinct:
            args = ["VERBOSE=1", target]
        else:
            args = [target]
        try:
            self._check_call([make_cmd,
                              '-k', '-j', str(self._build_threads())] + args,
                             cwd=subdir)
        except subprocess.CalledProcessError:
            # make is expected to exit with code 1 if there was any build
            # failure. Build failures are not unexpected when testing an
            # experimental compiler.
            pass

    def _lit(self, path, test, profile):
        lit_cmd = self.opts.lit

        output_json_path = tempfile.NamedTemporaryFile(prefix='output',
                                                       suffix='.json',
                                                       dir=path,
                                                       delete=False)
        output_json_path.close()

        subdir = path
        if self.opts.only_test:
            components = [path] + [self.opts.only_test[0]]
            subdir = os.path.join(*components)

        extra_args = []
        if not test:
            extra_args = ['--no-execute']

        nr_threads = self._test_threads()
        if profile:
            if nr_threads != 1:
                warning('Gathering profiles with perf requires -j 1 as ' +
                        'perf record cannot be run multiple times ' +
                        'simultaneously. Overriding -j %s to -j 1' % nr_threads)
                nr_threads = 1
            extra_args += ['--param', 'profile=perf']
            if self.opts.perf_events:
                extra_args += ['--param',
                               'perf_profile_events=%s' % self.opts.perf_events]

        note('Testing...')
        try:
            self._check_call([lit_cmd,
                              '-v',
                              '-j', str(nr_threads),
                              subdir,
                              '-o', output_json_path.name] + extra_args)
        except subprocess.CalledProcessError:
            # LIT is expected to exit with code 1 if there were test
            # failures!
            pass
        return json.loads(open(output_json_path.name).read())

    def _is_pass_code(self, code):
        return code in ('PASS', 'XPASS', 'XFAIL')

    def _get_lnt_code(self, code):
        return {'PASS': lnt.testing.PASS,
                'FAIL': lnt.testing.FAIL,
                'XFAIL': lnt.testing.XFAIL,
                'XPASS': lnt.testing.FAIL,
                'UNRESOLVED': lnt.testing.FAIL
               }[code]

    def _test_failed_to_compile(self, raw_name, path):
        # FIXME: Do we need to add ".exe" in windows?
        name = raw_name.rsplit('.test', 1)[0]
        return not os.path.exists(os.path.join(path, name))

    def _extract_cmake_vars_from_cache(self):
        assert self.configured is True
        cmake_lah_output = self._check_output(
            [self.opts.cmake] + ['-LAH', '-N'] + [self._base_path])
        pattern2var = [
            (re.compile("^%s:[^=]*=(.*)$" % cmakevar), cmakevar)
            for cmakevar in (
                "CMAKE_C_COMPILER",
                "CMAKE_BUILD_TYPE",
                "CMAKE_CXX_FLAGS",
                "CMAKE_CXX_FLAGS_DEBUG",
                "CMAKE_CXX_FLAGS_MINSIZEREL",
                "CMAKE_CXX_FLAGS_RELEASE",
                "CMAKE_CXX_FLAGS_RELWITHDEBINFO",
                "CMAKE_C_FLAGS",
                "CMAKE_C_FLAGS_DEBUG",
                "CMAKE_C_FLAGS_MINSIZEREL",
                "CMAKE_C_FLAGS_RELEASE",
                "CMAKE_C_FLAGS_RELWITHDEBINFO",
                "CMAKE_C_COMPILER_TARGET",
                "CMAKE_CXX_COMPILER_TARGET",
                )]
        cmake_vars = {}
        for line in cmake_lah_output.split("\n"):
            for pattern, varname in pattern2var:
                m = re.match(pattern, line)
                if m:
                    cmake_vars[varname] = m.group(1)
        return cmake_vars

    def _get_cc_info(self, cmake_vars):
        build_type = cmake_vars["CMAKE_BUILD_TYPE"]
        cflags = cmake_vars["CMAKE_C_FLAGS"]
        if build_type != "":
            cflags = \
                " ".join(cflags.split(" ") +
                         cmake_vars["CMAKE_C_FLAGS_" + build_type.upper()]
                         .split(" "))
        # FIXME: this probably needs to be conditionalized on the compiler
        # being clang. Or maybe we need an
        # lnt.testing.util.compilers.get_cc_info uses cmake somehow?
        if "CMAKE_C_COMPILER_TARGET" in cmake_vars:
            cflags += " --target=" + cmake_vars["CMAKE_C_COMPILER_TARGET"]
        target_flags = shlex.split(cflags)

        return lnt.testing.util.compilers.get_cc_info(
            cmake_vars["CMAKE_C_COMPILER"], target_flags)

    def _parse_lit_output(self, path, data, cmake_vars, only_test=False):
        LIT_METRIC_TO_LNT = {
            'compile_time': 'compile',
            'exec_time': 'exec',
            'score': 'score',
            'hash': 'hash',
            'link_time': 'compile',
            'size.__text': 'code_size'
        }
        LIT_METRIC_CONV_FN = {
            'compile_time': float,
            'exec_time': float,
            'score': float,
            'hash': str,
            'link_time': float,
            'size.__text': float,
        }

        # We don't use the test info, currently.
        test_info = {}
        test_samples = []

        # FIXME: Populate with keys not to upload
        ignore = self.opts.exclude_stat_from_submission
        if only_test:
            ignore.append('compile')

        profiles_to_import = []

        for test_data in data['tests']:
            raw_name = test_data['name'].split(' :: ', 1)[1]
            name = 'nts.' + raw_name.rsplit('.test', 1)[0]
            is_pass = self._is_pass_code(test_data['code'])

            # If --single-result is given, exit based on --single-result-predicate
            if self.opts.single_result and \
               raw_name == self.opts.single_result + '.test':
                env = {'status': is_pass}
                if 'metrics' in test_data:
                    for k, v in test_data['metrics'].items():
                        env[k] = v
                        if k in LIT_METRIC_TO_LNT:
                            env[LIT_METRIC_TO_LNT[k]] = v
                status = eval(self.opts.single_result_predicate, {}, env)
                sys.exit(0 if status else 1)

            if 'metrics' in test_data:
                for k, v in test_data['metrics'].items():
                    if k == 'profile':
                        profiles_to_import.append((name, v))
                        continue

                    if k not in LIT_METRIC_TO_LNT or LIT_METRIC_TO_LNT[k] in ignore:
                        continue
                    server_name = name + '.' + LIT_METRIC_TO_LNT[k]

                    if k == 'link_time':
                        # Move link time into a second benchmark's compile-time.
                        server_name = name + '-link.' + LIT_METRIC_TO_LNT[k]

                    test_samples.append(
                        lnt.testing.TestSamples(server_name,
                                                [v],
                                                test_info,
                                                LIT_METRIC_CONV_FN[k]))

            if self._test_failed_to_compile(raw_name, path):
                test_samples.append(
                    lnt.testing.TestSamples(name + '.compile.status',
                                            [lnt.testing.FAIL],
                                            test_info))

            elif not is_pass:
                test_samples.append(
                    lnt.testing.TestSamples(name + '.exec.status',
                                            [self._get_lnt_code(test_data['code'])],
                                            test_info))

        # Now import the profiles in parallel.
        if profiles_to_import:
            note('Importing %d profiles with %d threads...' %
                 (len(profiles_to_import), multiprocessing.cpu_count()))
            TIMEOUT = 800
            try:
                pool = multiprocessing.Pool()
                waiter = pool.map_async(_importProfile, profiles_to_import)
                samples = waiter.get(TIMEOUT)
                test_samples.extend([sample
                                     for sample in samples
                                     if sample is not None])
            except multiprocessing.TimeoutError:
                warning('Profiles had not completed importing after %s seconds.'
                        % TIMEOUT)
                note('Aborting profile import and continuing')

        if self.opts.single_result:
            # If we got this far, the result we were looking for didn't exist.
            raise RuntimeError("Result %s did not exist!" %
                               self.opts.single_result)

        # FIXME: Add more machine info!
        run_info = {
            'tag': 'nts'
        }
        run_info.update(self._get_cc_info(cmake_vars))
        run_info['run_order'] = run_info['inferred_run_order']
        if self.opts.run_order:
            run_info['run_order'] = self.opts.run_order

        machine_info = {
        }

        machine = lnt.testing.Machine(self.opts.label, machine_info)
        run = lnt.testing.Run(self.start_time, timestamp(), info=run_info)
        report = lnt.testing.Report(machine, run, test_samples)
        return report

    def _unix_quote_args(self, s):
        return ' '.join(map(pipes.quote, shlex.split(s)))

    def _cp_artifacts(self, src, dest, patts):
        """Copy artifacts out of the build """
        for patt in patts:
            for file in glob.glob(src + patt):
                shutil.copy(file, dest)
                note(file + " --> " + dest)

    def diagnose(self):
        """Build a triage report that contains information about a test.

        This is an alternate top level target for running the test-suite.  It
        will produce a triage report for a benchmark instead of running the
        test-suite normally. The report has stuff in it that will be useful
        for reproducing and diagnosing a performance change.
        """
        assert self.opts.only_test, "We don't have a benchmark to diagenose."
        bm_path, short_name = self.opts.only_test
        assert bm_path, "The benchmark path is empty?"

        report_name = "{}.report".format(short_name)
        # Make a place for the report.
        report_path = os.path.abspath(report_name)

        # Overwrite the report.
        if os.path.exists(report_path):
            shutil.rmtree(report_path)
        os.mkdir(report_path)

        path = self._base_path
        mkdir_p(path)
        os.chdir(path)

        # Run with -save-temps
        cmd = self._configure(path, execute=False)
        cmd_temps = cmd + ['-DTEST_SUITE_DIAGNOSE_FLAGS=-save-temps']

        note(' '.join(cmd_temps))

        out = subprocess.check_output(cmd_temps)
        note(out)

        # Figure out our test's target.
        make_cmd = [self.opts.make, "VERBOSE=1", 'help']

        make_targets = subprocess.check_output(make_cmd)
        matcher = re.compile(r"^\.\.\.\s{}$".format(short_name),
                             re.MULTILINE | re.IGNORECASE)
        if not matcher.search(make_targets):
            assert False, "did not find benchmark, nestsed? Unimplemented."

        local_path = os.path.join(path, bm_path)

        make_deps = [self.opts.make, "VERBOSE=1", "timeit-target",
                     "timeit-host", "fpcmp-host"]
        note(" ".join(make_deps))
        p = subprocess.Popen(make_deps,
                             stdout=subprocess.PIPE,
                             stderr=subprocess.STDOUT)
        std_out, std_err = p.communicate()
        note(std_out)

        make_save_temps = [self.opts.make, "VERBOSE=1", short_name]
        note(" ".join(make_save_temps))
        p = subprocess.Popen(make_save_temps,
                             stdout=subprocess.PIPE,
                             stderr=subprocess.STDOUT)
        std_out, std_err = p.communicate()
        note(std_out)
        with open(report_path + "/build.log", 'w') as f:
            f.write(std_out)
        # Executable(s) and test file:
        shutil.copy(os.path.join(local_path, short_name), report_path)
        shutil.copy(os.path.join(local_path, short_name + ".test"), report_path)
        # Temp files are in:
        temp_files = os.path.join(local_path, "CMakeFiles",
                                  short_name + ".dir")

        save_temps_file = ["/*.s", "/*.ii", "/*.i", "/*.bc"]
        build_files = ["/*.o", "/*.time", "/*.cmake", "/*.make",
                       "/*.includecache", "/*.txt"]
        self._cp_artifacts(local_path, report_path, save_temps_file)
        self._cp_artifacts(temp_files, report_path, build_files)

        # Now lets do -ftime-report.
        cmd_time_report = cmd + ['-DTEST_SUITE_DIAGNOSE_FLAGS=-ftime-report']

        note(' '.join(cmd_time_report))

        out = subprocess.check_output(cmd_time_report)
        note(out)

        make_time_report = [self.opts.make, "VERBOSE=1", short_name]
        p = subprocess.Popen(make_time_report,
                             stdout=subprocess.PIPE,
                             stderr=subprocess.PIPE)
        std_out, std_err = p.communicate()

        with open(report_path + "/time-report.txt", 'w') as f:
            f.write(std_err)
        note("Wrote: " + report_path + "/time-report.txt")

        # Now lets do -llvm -stats.
        cmd_stats_report = cmd + ['-DTEST_SUITE_DIAGNOSE_FLAGS=-mllvm -stats']

        note(' '.join(cmd_stats_report))

        out = subprocess.check_output(cmd_stats_report)
        note(out)

        make_stats_report = [self.opts.make, "VERBOSE=1", short_name]
        p = subprocess.Popen(make_stats_report,
                             stdout=subprocess.PIPE,
                             stderr=subprocess.PIPE)
        std_out, std_err = p.communicate()

        with open(report_path + "/stats-report.txt", 'w') as f:
            f.write(std_err)
        note("Wrote: " + report_path + "/stats-report.txt")

        #  Collect Profile:
        if "Darwin" in platform.platform():
            # For testing and power users, lets allow overrides of how sudo
            # and iprofiler are called.
            sudo = os.getenv("SUDO_CMD", "sudo")
            if " " in sudo:
                sudo = sudo.split(" ")
            if not sudo:
                sudo = []
            else:
                sudo = [sudo]
            iprofiler = os.getenv("IPROFILER_CMD",
                                  "iprofiler -timeprofiler -I 40u")

            cmd_iprofiler = cmd + ['-DTEST_SUITE_RUN_UNDER=' + iprofiler]
            print ' '.join(cmd_iprofiler)

            out = subprocess.check_output(cmd_iprofiler)

            os.chdir(local_path)
            make_iprofiler_temps = [self.opts.make, "VERBOSE=1", short_name]
            p = subprocess.Popen(make_iprofiler_temps,
                                 stdout=subprocess.PIPE,
                                 stderr=subprocess.PIPE)
            std_out, std_err = p.communicate()
            warning("Using sudo to collect execution trace.")
            make_save_temps = sudo + [self.opts.lit, short_name + ".test"]
            p = subprocess.Popen(make_save_temps,
                                 stdout=subprocess.PIPE,
                                 stderr=subprocess.PIPE)
            std_out, std_err = p.communicate()
            sys.stdout.write(std_out)
            sys.stderr.write(std_err)
            warning("Tests may fail because of iprofiler's output.")
            # The dtps file will be saved as root, make it so
            # that we can read it.
            chmod = sudo + ["chown", "-R", getpass.getuser(), short_name + ".dtps"]
            subprocess.call(chmod)
            profile = local_path + "/" + short_name + ".dtps"
            shutil.copytree(profile, report_path + "/" + short_name + ".dtps")
            note(profile + "-->" + report_path)
        else:
            warning("Skipping execution profiling because this is not Darwin.")
        note("Report produced in: " + report_path)

        # Run through the rest of LNT, but don't allow this to be submitted
        # because there is no data.
        class DontSubmitResults(object):

            def get(self, url):
                return report_path

            def __getitem__(self, key):
                return report_path

        return DontSubmitResults()

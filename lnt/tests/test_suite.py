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

from optparse import OptionParser, OptionGroup

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


class TestSuiteTest(BuiltinTest):
    def __init__(self):
        self.configured = False
        self.compiled = False

    def describe(self):
        return "LLVM test-suite"

    def run_test(self, name, args):
        # FIXME: Add more detailed usage information
        parser = OptionParser("%s [options] test-suite" % name)

        group = OptionGroup(parser, "Sandbox options")
        group.add_option("-S", "--sandbox", dest="sandbox_path",
                         help="Parent directory to build and run tests in",
                         type=str, default=None, metavar="PATH")
        group.add_option("", "--no-timestamp", dest="timestamp_build",
                         action="store_false", default=True,
                         help="Don't timestamp build directory (for testing)")
        group.add_option("", "--no-configure", dest="run_configure",
                         action="store_false", default=True,
                         help="Don't run CMake if CMakeCache.txt is present"
                              " (only useful with --no-timestamp")
        parser.add_option_group(group)
        
        group = OptionGroup(parser, "Inputs")
        group.add_option("", "--test-suite", dest="test_suite_root",
                         type=str, metavar="PATH", default=None,
                         help="Path to the LLVM test-suite sources")
        group.add_option("", "--test-externals", dest="test_suite_externals",
                         type=str, metavar="PATH",
                         help="Path to the LLVM test-suite externals")
        group.add_option("", "--cmake-define", dest="cmake_defines",
                         action="append",
                         help=("Defines to pass to cmake. These do not require the "
                               "-D prefix and can be given multiple times. e.g.: "
                               "--cmake-define A=B => -DA=B"))
        group.add_option("-C", "--cmake-cache", dest="cmake_cache",
                         help=("Use one of the test-suite's cmake configurations."
                               " Ex: Release, Debug"))
        parser.add_option_group(group)

        group = OptionGroup(parser, "Test compiler")
        group.add_option("", "--cc", dest="cc", metavar="CC",
                         type=str, default=None,
                         help="Path to the C compiler to test")
        group.add_option("", "--cxx", dest="cxx", metavar="CXX",
                         type=str, default=None,
                         help="Path to the C++ compiler to test (inferred from"
                              " --cc where possible")
        group.add_option("", "--llvm-arch", dest="llvm_arch",
                         type='choice', default=None,
                         help="Override the CMake-inferred architecture",
                         choices=TEST_SUITE_KNOWN_ARCHITECTURES)
        group.add_option("", "--cross-compiling", dest="cross_compiling",
                         action="store_true", default=False,
                         help="Inform CMake that it should be cross-compiling")
        group.add_option("", "--cross-compiling-system-name", type=str,
                         default=None, dest="cross_compiling_system_name",
                         help="The parameter to pass to CMAKE_SYSTEM_NAME when"
                              " cross-compiling. By default this is 'Linux' "
                              "unless -arch is in the cflags, in which case "
                              "it is 'Darwin'")
        group.add_option("", "--cppflags", type=str, action="append",
                         dest="cppflags", default=[],
                         help="Extra flags to pass the compiler in C or C++ mode. "
                              "Can be given multiple times")
        group.add_option("", "--cflags", type=str, action="append",
                         dest="cflags", default=[],
                         help="Extra CFLAGS to pass to the compiler. Can be "
                              "given multiple times")
        group.add_option("", "--cxxflags", type=str, action="append",
                         dest="cxxflags", default=[],
                         help="Extra CXXFLAGS to pass to the compiler. Can be "
                              "given multiple times")
        parser.add_option_group(group)

        group = OptionGroup(parser, "Test selection")
        group.add_option("", "--test-size", type='choice', dest="test_size",
                         choices=['small', 'regular', 'large'], default='regular',
                         help="The size of test inputs to use")
        group.add_option("", "--benchmarking-only",
                         dest="benchmarking_only", action="store_true",
                         default=False,
                         help="Benchmarking-only mode. Disable unit tests and "
                              "other flaky or short-running tests")
        group.add_option("", "--only-test", dest="only_test", metavar="PATH",
                         type=str, default=None,
                         help="Only run tests under PATH")

        parser.add_option_group(group)

        group = OptionGroup(parser, "Test Execution")
        group.add_option("-j", "--threads", dest="threads",
                         help="Number of testing (and optionally build) "
                         "threads", type=int, default=1, metavar="N")
        group.add_option("", "--build-threads", dest="build_threads",
                         help="Number of compilation threads, defaults to "
                         "--threads", type=int, default=0, metavar="N")
        group.add_option("", "--use-perf", dest="use_perf",
                         help=("Use Linux perf for high accuracy timing, profile "
                               "information or both"),
                         type='choice',
                         choices=['none', 'time', 'profile', 'all'],
                         default='none')
        group.add_option("", "--run-under", dest="run_under",
                         help="Wrapper to run tests under ['%default']",
                         type=str, default="")
        group.add_option("", "--exec-multisample", dest="exec_multisample",
                         help="Accumulate execution test data from multiple runs",
                         type=int, default=1, metavar="N")
        group.add_option("", "--compile-multisample", dest="compile_multisample",
                         help="Accumulate compile test data from multiple runs",
                         type=int, default=1, metavar="N")
        group.add_option("-d", "--diagnose", dest="diagnose",
                         help="Produce a diagnostic report for a particular "
                              "test, this will not run all the tests.  Must be"
                              " used in conjunction with --only-test.",
                         action="store_true", default=False,)

        parser.add_option_group(group)

        group = OptionGroup(parser, "Output Options")
        group.add_option("", "--no-auto-name", dest="auto_name",
                         help="Don't automatically derive submission name",
                         action="store_false", default=True)
        group.add_option("", "--run-order", dest="run_order", metavar="STR",
                         help="String to use to identify and order this run",
                         action="store", type=str, default=None)
        group.add_option("", "--submit", dest="submit_url", metavar="URLORPATH",
                         help=("autosubmit the test result to the given server"
                               " (or local instance) [%default]"),
                         type=str, default=None)
        group.add_option("", "--commit", dest="commit",
                         help=("whether the autosubmit result should be committed "
                               "[%default]"),
                         type=int, default=True)
        group.add_option("-v", "--verbose", dest="verbose",
                         help="show verbose test results",
                         action="store_true", default=False)
        group.add_option("", "--succinct-compile-output",
                         help="run Make without VERBOSE=1",
                         action="store_true", dest="succinct")
        group.add_option("", "--exclude-stat-from-submission",
                         dest="exclude_stat_from_submission",
                         help="Do not submit the stat of this type [%default]",
                         action='append', choices=KNOWN_SAMPLE_KEYS,
                         type='choice', default=[])
        group.add_option("", "--single-result", dest="single_result",
                         help=("only execute this single test and apply "
                               "--single-result-predicate to calculate the "
                               "exit status"))
        group.add_option("", "--single-result-predicate",
                         dest="single_result_predicate",
                         help=("the predicate to apply to calculate the exit "
                               "status (with --single-result)"),
                         default="status")
        parser.add_option_group(group)

        group = OptionGroup(parser, "Test tools")
        group.add_option("", "--use-cmake", dest="cmake", metavar="PATH",
                         type=str, default="cmake",
                         help="Path to CMake [cmake]")
        group.add_option("", "--use-make", dest="make", metavar="PATH",
                         type=str, default="make",
                         help="Path to Make [make]")
        group.add_option("", "--use-lit", dest="lit", metavar="PATH",
                         type=str, default="llvm-lit",
                         help="Path to the LIT test runner [llvm-lit]")

        (opts, args) = parser.parse_args(args)
        self.opts = opts

        if len(args) == 0:
            self.nick = platform.uname()[1]
        elif len(args) == 1:
            self.nick = args[0]
        else:
            parser.error("Expected no positional arguments (got: %r)" % (args,))

        for a in ['cross_compiling', 'cross_compiling_system_name', 'llvm_arch']:
            if getattr(opts, a):
                parser.error('option "%s" is not yet implemented!' % a)
            
        if self.opts.sandbox_path is None:
            parser.error('--sandbox is required')

        # Option validation.
        opts.cc = resolve_command_path(opts.cc)

        if not lnt.testing.util.compilers.is_valid(opts.cc):
            parser.error('--cc does not point to a valid executable.')

        # If there was no --cxx given, attempt to infer it from the --cc.
        if opts.cxx is None:
            opts.cxx = lnt.testing.util.compilers.infer_cxx_compiler(opts.cc)
            if opts.cxx is not None:
                note("Inferred C++ compiler under test as: %r" % (opts.cxx,))
            else:
                parser.error("unable to infer --cxx - set it manually.")
        else:
            opts.cxx = resolve_command_path(opts.cxx)
                
        if not os.path.exists(opts.cxx):
            parser.error("invalid --cxx argument %r, does not exist" % (opts.cxx))

        if opts.test_suite_root is None:
            parser.error('--test-suite is required')
        if not os.path.exists(opts.test_suite_root):
            parser.error("invalid --test-suite argument, does not exist: %r" % (
                opts.test_suite_root))

        if opts.test_suite_externals:
            if not os.path.exists(opts.test_suite_externals):
                parser.error(
                    "invalid --test-externals argument, does not exist: %r" % (
                        opts.test_suite_externals,))
                
        opts.cmake = resolve_command_path(opts.cmake)
        if not isexecfile(opts.cmake):
            parser.error("CMake tool not found (looked for %s)" % opts.cmake)
        opts.make = resolve_command_path(opts.make)
        if not isexecfile(opts.make):
            parser.error("Make tool not found (looked for %s)" % opts.make)
        opts.lit = resolve_command_path(opts.lit)
        if not isexecfile(opts.lit):
            parser.error("LIT tool not found (looked for %s)" % opts.lit)
        if opts.run_under:
            split = shlex.split(opts.run_under)
            split[0] = resolve_command_path(split[0])
            if not isexecfile(split[0]):
                parser.error("Run under wrapper not found (looked for %s)" %
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
                parser.error("--only-test argument not understood (must be a " +
                             " test or directory name)")

        if opts.single_result and not opts.only_test[1]:
            parser.error("--single-result must be given a single test name, not a " +
                         "directory name")
                
        opts.cppflags = ' '.join(opts.cppflags)
        opts.cflags = ' '.join(opts.cflags)
        opts.cxxflags = ' '.join(opts.cxxflags)
        
        if opts.diagnose:
            if not opts.only_test:
                parser.error("--diagnose requires --only-test")
        
        self.start_time = timestamp()

        # Work out where to put our build stuff
        if self.opts.timestamp_build:
            ts = self.start_time.replace(' ', '_').replace(':', '-')
            build_dir_name = "test-%s" % ts
        else:
            build_dir_name = "build"
        basedir = os.path.join(self.opts.sandbox_path, build_dir_name)
        self._base_path = basedir

        # We don't support compiling without testing as we can't get compile-
        # time numbers from LIT without running the tests.
        if opts.compile_multisample > opts.exec_multisample:
            note("Increasing number of execution samples to %d" %
                 opts.compile_multisample)
            opts.exec_multisample = opts.compile_multisample

        if opts.auto_name:
            # Construct the nickname from a few key parameters.
            cc_info = self._get_cc_info()
            cc_nick = '%s_%s' % (cc_info['cc_name'], cc_info['cc_build'])
            self.nick += "__%s__%s" % (cc_nick,
                                       cc_info['cc_target'].split('-')[0])
        note('Using nickname: %r' % self.nick)

        #  If we are doing diagnostics, skip the usual run and do them now.
        if opts.diagnose:
            return self.diagnose()
        # Now do the actual run.
        reports = []
        for i in range(max(opts.exec_multisample, opts.compile_multisample)):
            c = i < opts.compile_multisample
            e = i < opts.exec_multisample
            reports.append(self.run(self.nick, compile=c, test=e))
            
        report = self._create_merged_report(reports)

        # Write the report out so it can be read by the submission tool.
        report_path = os.path.join(self._base_path, 'report.json')
        with open(report_path, 'w') as fd:
            fd.write(report.render())

        return self.submit(report_path, self.opts, commit=True)
    
    def run(self, nick, compile=True, test=True):
        path = self._base_path
        
        if not os.path.exists(path):
            mkdir_p(path)
            
        if not self.configured and self._need_to_configure(path):
            self._configure(path)
            self._clean(path)
            self.configured = True
            
        if self.compiled and compile:
            self._clean(path)
        if not self.compiled or compile:
            self._make(path)
            self.compiled = True

        data = self._lit(path, test)
        return self._parse_lit_output(path, data)

    def _create_merged_report(self, reports):
        if len(reports) == 1:
            return reports[0]

        machine = reports[0].machine
        run = reports[0].run
        run.end_time = reports[-1].run.end_time
        test_samples = sum([r.tests for r in reports], [])
        return lnt.testing.Report(machine, run, test_samples)

    def _need_to_configure(self, path):
        cmakecache = os.path.join(path, 'CMakeCache.txt')
        return self.opts.run_configure or not os.path.exists(cmakecache)

    def _test_suite_dir(self):
        return self.opts.test_suite_root

    def _build_threads(self):
        return self.opts.build_threads or self.opts.threads

    def _test_threads(self):
        return self.opts.threads

    def _check_call(self, *args, **kwargs):
        if self.opts.verbose:
            note('Execute: %s' % ' '.join(args[0]))
            if 'cwd' in kwargs:
                note('          (In %s)' % kwargs['cwd'])
        return subprocess.check_call(*args, **kwargs)
    
    def _clean(self, path):
        make_cmd = self.opts.make

        subdir = path
        if self.opts.only_test:
            components = [path] + [self.opts.only_test[0]]
            subdir = os.path.join(*components)

        self._check_call([make_cmd, 'clean'],
                         cwd=subdir)
        
    def _configure(self, path, execute=True):
        cmake_cmd = self.opts.cmake

        defs = {
            # FIXME: Support ARCH, SMALL/LARGE etc
            'CMAKE_C_COMPILER': self.opts.cc,
            'CMAKE_CXX_COMPILER': self.opts.cxx,
        }
        if self.opts.cppflags or self.opts.cflags:
            all_cflags = ' '.join([self.opts.cppflags, self.opts.cflags])
            defs['CMAKE_C_FLAGS'] = self._unix_quote_args(all_cflags)
        
        if self.opts.cppflags or self.opts.cxxflags:
            all_cxx_flags = ' '.join([self.opts.cppflags, self.opts.cxxflags])
            defs['CMAKE_CXX_FLAGS'] = self._unix_quote_args(all_cxx_flags)
        
        if self.opts.run_under:
            defs['TEST_SUITE_RUN_UNDER'] = self._unix_quote_args(self.opts.run_under)
        if self.opts.benchmarking_only:
            defs['TEST_SUITE_BENCHMARKING_ONLY'] = 'ON'
        if self.opts.use_perf in ('time', 'all'):
            defs['TEST_SUITE_USE_PERF'] = 'ON'
        if self.opts.cmake_defines:
            for item in self.opts.cmake_defines:
                k, v = item.split('=', 1)
                defs[k] = v
            
        lines = ['Configuring with {']
        for k, v in sorted(defs.items()):
            lines.append("  %s: '%s'" % (k, v))
        lines.append('}')
        
        # Prepare cmake cache if requested:
        cache = []
        if self.opts.cmake_cache:
            cache_path = os.path.join(self._test_suite_dir(),
                                      "cmake/caches/", self.opts.cmake_cache + ".cmake")
            if os.path.exists(cache_path):
                cache = ['-C', cache_path]
            else:
                fatal("Could not find CMake cache file: " +
                      self.opts.cmake_cache + " in " + cache_path)

        for l in lines:
            note(l)
        
        cmake_cmd = [cmake_cmd] + cache + [self._test_suite_dir()] + \
                    ['-D%s=%s' % (k, v) for k, v in defs.items()]
        if execute:
            self._check_call(cmake_cmd, cwd=path)
        
        return cmake_cmd

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
        self._check_call([make_cmd,
                          '-j', str(self._build_threads())] + args,
                         cwd=subdir)

    def _lit(self, path, test):
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
        if self.opts.use_perf in ('profile', 'all'):
            extra_args += ['--param', 'profile=perf']
            
        note('Testing...')
        try:
            self._check_call([lit_cmd,
                              '-v',
                              '-j', str(self._test_threads()),
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

    def _get_target_flags(self):
        return shlex.split(self.opts.cppflags + self.opts.cflags)
    
    def _get_cc_info(self):
        return lnt.testing.util.compilers.get_cc_info(self.opts.cc,
                                                      self._get_target_flags())

    def _parse_lit_output(self, path, data, only_test=False):
        LIT_METRIC_TO_LNT = {
            'compile_time': 'compile',
            'exec_time': 'exec',
            'score': 'score',
            'hash': 'hash'
        }
        LIT_METRIC_CONV_FN = {
            'compile_time': float,
            'exec_time': float,
            'score': float,
            'hash': str
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
                    test_samples.append(
                        lnt.testing.TestSamples(name + '.' + LIT_METRIC_TO_LNT[k],
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
        run_info.update(self._get_cc_info())
        run_info['run_order'] = run_info['inferred_run_order']
        if self.opts.run_order:
            run_info['run_order'] = self.opts.run_order
        
        machine_info = {
        }
        
        machine = lnt.testing.Machine(self.nick, machine_info)
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
        if not os.path.exists(path):
            mkdir_p(path)
        os.chdir(path)

        # Run with -save-temps
        cmd = self._configure(path, execute=False)
        cmd_temps = cmd + ['-DTEST_SUITE_DIAGNOSE=On',
                           '-DTEST_SUITE_DIAGNOSE_FLAGS=-save-temps']

        note(' '.join(cmd_temps))

        out = subprocess.check_output(cmd_temps)
        note(out)

        # Figure out our test's target.
        make_cmd = [self.opts.make, "VERBOSE=1", 'help']

        make_targets = subprocess.check_output(make_cmd)
        matcher = re.compile(r"^\.\.\.\s{}$".format(short_name),
                             re.MULTILINE | re.IGNORECASE)
        if not matcher.search(make_targets):
            assert False, "did not find benchmark, must be nestsed? Unimplemented."

        local_path = os.path.join(path, bm_path)

        make_deps = [self.opts.make, "VERBOSE=1", "timeit-target", "timeit-host", "fpcmp-host"]
        note(" ".join(make_deps))
        p = subprocess.Popen(make_deps, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        std_out, std_err = p.communicate()
        note(std_out)

        make_save_temps = [self.opts.make, "VERBOSE=1", short_name]
        note(" ".join(make_save_temps))
        p = subprocess.Popen(make_save_temps, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
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
        cmd_time_report = cmd + ['-DTEST_SUITE_DIAGNOSE=On',
                                 '-DTEST_SUITE_DIAGNOSE_FLAGS=-ftime-report']

        note(' '.join(cmd_time_report))
        
        out = subprocess.check_output(cmd_time_report)
        note(out)

        make_time_report = [self.opts.make, "VERBOSE=1", short_name]
        p = subprocess.Popen(make_time_report, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        std_out, std_err = p.communicate()

        with open(report_path + "/time-report.txt", 'w') as f:
            f.write(std_err)
        note("Wrote: " + report_path + "/time-report.txt")

        # Now lets do -llvm -stats.
        cmd_stats_report = cmd + ['-DTEST_SUITE_DIAGNOSE=On',
                                  '-DTEST_SUITE_DIAGNOSE_FLAGS=-mllvm -stats']

        note(' '.join(cmd_stats_report))
        
        out = subprocess.check_output(cmd_stats_report)
        note(out)

        make_stats_report = [self.opts.make, "VERBOSE=1", short_name]
        p = subprocess.Popen(make_stats_report, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        std_out, std_err = p.communicate()

        with open(report_path + "/stats-report.txt", 'w') as f:
            f.write(std_err)
        note("Wrote: " + report_path + "/stats-report.txt")

        note("Report produced in: " + report_path)

        # Run through the rest of LNT, but don't allow this to be submitted
        # because there is no data.
        class DontSubmitResults(object):
            def get(self, url):
                return None

        return DontSubmitResults()


def create_instance():
    return TestSuiteTest()

__all__ = ['create_instance']

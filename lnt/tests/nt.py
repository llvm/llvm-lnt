"""LLVM test-suite compile and execution tests"""
from __future__ import absolute_import
from __future__ import print_function
import csv
import os
import platform
import re
import shutil
import subprocess
import sys
import glob
import time
import traceback
import urllib2
import shlex
import pipes
import resource

import click

import lnt.testing
import lnt.testing.util.compilers
import lnt.util.ImportData as ImportData

from lnt.testing.util.commands import fatal
from lnt.testing.util.commands import capture, mkdir_p, which
from lnt.testing.util.commands import resolve_command_path

from lnt.testing.util.rcs import get_source_version

from lnt.testing.util.misc import timestamp

from lnt.server.reporting.analysis import UNCHANGED_PASS, UNCHANGED_FAIL
from lnt.server.reporting.analysis import REGRESSED, IMPROVED
from lnt.util import logger
from lnt.lnttool.common import submit_options
from . import builtintest


class TestModule(object):
    """
    Base class for extension test modules.
    """

    def __init__(self):
        self._log = None

    def main(self):
        raise NotImplementedError

    def execute_test(self, options, make_variables, config):
        raise RuntimeError("Abstract Method.")

    def _execute_test(self, test_log, options, make_variables, config):
        self._log = test_log
        self._user_time = config.test_time_stat == 'user'
        try:
            return self.execute_test(options, make_variables, config)
        finally:
            self._log = None

    def call(self, args, **kwargs):
        if kwargs.get('shell', False):
            cmdstr = args
        else:
            cmdstr = ' '.join(args)

        if 'cwd' in kwargs:
            print("# In working dir: " + kwargs['cwd'], file=self._log)
        print(cmdstr, file=self.log)

        self._log.flush()
        p = subprocess.Popen(args, stdout=self._log, stderr=self._log,
                             **kwargs)
        return p.wait()

    def get_time(self):
        if self._user_time:
            return resource.getrusage(resource.RUSAGE_CHILDREN).ru_utime
        else:
            return time.time()

    @property
    def log(self):
        """Get the test log output stream."""
        if self._log is None:
            raise ValueError("log() unavailable outside test execution")
        return self._log


class TestConfiguration(object):
    """Store and calculate important paths and options for this test based
    on the command line arguments. This object is stateless and only
    based on the command line arguments! Options which take a long
    time to calculate are cached, since we are stateless this is okay.

    """

    def __init__(self, opts, start_time):
        """Prepare the configuration:
        opts -- the command line options object
        start_time -- the time the program was invoked as a string
        """
        assert isinstance(opts, dict), "Options must be a dict."
        self.opts = opts
        self.__dict__.update(opts)
        self.start_time = start_time

        # Report directory cache.
        self._report_dir = None
        # Compiler interrogation is a lot of work, this will cache it.
        self._cc_info = None
        # Getting compiler version spawns subprocesses, cache it.
        self._get_source_version = None
        self.rerun_test = None

    @property
    def report_dir(self):
        """Get the (possibly cached) path to the directory where test suite
        will be placed. Report dir is a directory within the sandbox which
        is either "build" or a timestamped directory based on """
        if self._report_dir is not None:
            return self._report_dir

        if self.timestamp_build:
            ts = self.start_time.replace(' ', '_').replace(':', '-')
            build_dir_name = "test-%s" % ts
        else:
            build_dir_name = "build"
        basedir = os.path.join(self.sandbox_path, build_dir_name)
        # Canonicalize paths, in case we are using e.g. an NFS remote mount.
        #
        # FIXME: This should be eliminated, along with the realpath call below.
        basedir = os.path.realpath(basedir)
        self._report_dir = basedir
        return basedir

    def report_path(self, iteration):
        """Path to a single run's JSON results file."""
        return os.path.join(self.build_dir(iteration), 'report.json')

    def build_dir(self, iteration):
        """Path of the build dir within the report dir.  iteration -- the
        iteration number if multisample otherwise None.
        When multisample is off report_dir == build_dir.
        """
        # Do nothing in single-sample build, because report_dir and the
        # build_dir is the same directory.
        if iteration is None:
            return self.report_dir

        # Create the directory for individual iteration.
        return os.path.join(self.report_dir, "sample-%d" % iteration)

    @property
    def target_flags(self):
        """Computed target flags list."""
        # Compute TARGET_FLAGS.
        target_flags = []

        # FIXME: Eliminate this blanket option.
        target_flags.extend(self.cflags)

        if self.cflag_string:
            # FIXME: This isn't generally OK on Windows :/
            target_flags.extend(_unix_quote_args(self.cflag_string))

        # Pass flags to backend.
        for f in self.mllvm:
            target_flags.extend(['-mllvm', f])

        if self.arch is not None:
            target_flags.append('-arch')
            target_flags.append(self.arch)
        if self.isysroot is not None:
            target_flags.append('-isysroot')
            target_flags.append(self.isysroot)
        return target_flags

    @property
    def cc_info(self):
        """Discovered compiler information from the cc under test. Cached
        because discovery is slow.

        """
        if self._cc_info is None:
            self._cc_info = lnt.testing.util.compilers.get_cc_info(
                                                    self.cc_under_test,
                                                    self.target_flags)
        return self._cc_info

    @property
    def target(self):
        """Discovered compiler's target information."""
        # Get compiler info.
        cc_target = self.cc_info.get('cc_target')
        return cc_target

    @property
    def llvm_source_version(self):
        """The version of llvm from llvm_src_root."""
        if self.llvm_src_root:
            if self._get_source_version is None:
                self._get_source_version = get_source_version(
                    self.llvm_src_root)
            return self._get_source_version
        else:
            return None

    @property
    def qemu_user_mode_command(self):
        """ The command used for qemu user mode """
        assert self.qemu_user_mode
        qemu_cmd_line = [self.qemu_user_mode] + list(self.qemu_flags)
        if self.qemu_string:
            qemu_cmd_line += _unix_quote_args(self.qemu_string)
        return ' '.join(qemu_cmd_line)

    @property
    def generate_report_script(self):
        """ The path to the report generation script. """
        return os.path.join(self.test_suite_root, "GenerateReport.pl")

    def build_report_path(self, iteration):
        """The path of the results.csv file which each run of the test suite
        will produce.
        iteration -- the multisample iteration number otherwise None."""
        report_path = os.path.join(self.build_dir(iteration))
        if self.only_test is not None:
            report_path = os.path.join(report_path, self.only_test)
        report_path = os.path.join(report_path, 'report.%s.csv' %
                                   self.test_style)
        return report_path

    def test_log_path(self, iteration):
        """The path of the log file for the build.
        iteration -- the multisample iteration number otherwise None."""
        return os.path.join(self.build_dir(iteration), 'test.log')

    def compute_run_make_variables(self):
        """Compute make variables from command line arguments and compiler.
        Returns a dict of make_variables as well as a public version
        with the remote options removed.

        """
        cc_info = self.cc_info
        # Set the make variables to use.
        make_variables = {
            'TARGET_CC': self.cc_reference,
            'TARGET_CXX': self.cxx_reference,
            'TARGET_LLVMGCC': self.cc_under_test,
            'TARGET_LLVMGXX': self.cxx_under_test,
            'TARGET_FLAGS': ' '.join(self.target_flags),
        }

        # Compute TARGET_LLCFLAGS, for TEST=nightly runs.
        if self.test_style == "nightly":
            # Compute TARGET_LLCFLAGS.
            target_llcflags = []
        if self.mcpu is not None:
            target_llcflags.append('-mcpu')
            target_llcflags.append(self.mcpu)
        if self.relocation_model is not None:
            target_llcflags.append('-relocation-model')
            target_llcflags.append(self.relocation_model)
        if self.disable_fp_elim:
            target_llcflags.append('-disable-fp-elim')
            make_variables['TARGET_LLCFLAGS'] = ' '.join(target_llcflags)

        # Set up environment overrides if requested, to effectively
        # run under the specified Darwin iOS simulator.
        #
        # See /D/P/../Developer/Tools/RunPlatformUnitTests.
        if self.ios_simulator_sdk is not None:
            make_variables['EXECUTION_ENVIRONMENT_OVERRIDES'] = ' '.join(
                ['DYLD_FRAMEWORK_PATH="%s"' % self.ios_simulator_sdk,
                 'DYLD_LIBRARY_PATH=""',
                 'DYLD_ROOT_PATH="%s"' % self.ios_simulator_sdk,
                 'DYLD_NEW_LOCAL_SHARED_REGIONS=YES',
                 'DYLD_NO_FIX_PREBINDING=YES',
                 'IPHONE_SIMULATOR_ROOT="%s"' % self.ios_simulator_sdk,
                 'CFFIXED_USER_HOME="%s"' % os.path.expanduser(
                     "~/Library/Application Support/iPhone Simulator/User")])

        # Pick apart the build mode.
        build_mode = self.build_mode
        if build_mode.startswith("Debug"):
            build_mode = build_mode[len("Debug"):]
            make_variables['ENABLE_OPTIMIZED'] = '0'
        elif build_mode.startswith("Unoptimized"):
            build_mode = build_mode[len("Unoptimized"):]
            make_variables['ENABLE_OPTIMIZED'] = '0'
        elif build_mode.startswith("Release"):
            build_mode = build_mode[len("Release"):]
            make_variables['ENABLE_OPTIMIZED'] = '1'
        else:
            fatal('invalid build mode: %r' % self.build_mode)

        while build_mode:
            for (name, key) in (('+Asserts', 'ENABLE_ASSERTIONS'),
                                ('+Checks', 'ENABLE_EXPENSIVE_CHECKS'),
                                ('+Coverage', 'ENABLE_COVERAGE'),
                                ('+Debug', 'DEBUG_SYMBOLS'),
                                ('+Profile', 'ENABLE_PROFILING')):
                if build_mode.startswith(name):
                    build_mode = build_mode[len(name):]
                    make_variables[key] = '1'
                    break
                else:
                    fatal('invalid build mode: %r' % self.build_mode)

        # Assertions are disabled by default.
        if 'ENABLE_ASSERTIONS' in make_variables:
            del make_variables['ENABLE_ASSERTIONS']
        else:
            make_variables['DISABLE_ASSERTIONS'] = '1'

        # Set the optimization level options.
        make_variables['OPTFLAGS'] = self.optimize_option
        if self.optimize_option == '-Os':
            make_variables['LLI_OPTFLAGS'] = '-O2'
            make_variables['LLC_OPTFLAGS'] = '-O2'
        else:
            make_variables['LLI_OPTFLAGS'] = self.optimize_option
            make_variables['LLC_OPTFLAGS'] = self.optimize_option

        # Set test selection variables.
        if not self.test_cxx:
            make_variables['DISABLE_CXX'] = '1'
        if not self.test_jit:
            make_variables['DISABLE_JIT'] = '1'
        if not self.test_llc:
            make_variables['DISABLE_LLC'] = '1'
        if not self.test_lto:
            make_variables['DISABLE_LTO'] = '1'
        if self.test_llcbeta:
            make_variables['ENABLE_LLCBETA'] = '1'
        if self.test_small:
            make_variables['SMALL_PROBLEM_SIZE'] = '1'
        if self.test_large:
            if self.test_small:
                fatal('the --small and --large options are mutually exclusive')
            make_variables['LARGE_PROBLEM_SIZE'] = '1'
        if self.test_benchmarking_only:
            make_variables['BENCHMARKING_ONLY'] = '1'
        if self.test_integrated_as:
            make_variables['TEST_INTEGRATED_AS'] = '1'
        if self.liblto_path:
            make_variables['LD_ENV_OVERRIDES'] = (
                'env DYLD_LIBRARY_PATH=%s' % os.path.dirname(
                    self.liblto_path))
        # If ref input is requested for SPEC, we wil run SPEC through its new
        # test module so skip SPEC as part of NT.
        if self.test_spec_ref:
            make_variables['USE_SPEC_TEST_MODULE'] = '1'

        if self.threads > 1 or self.build_threads > 1:
            make_variables['ENABLE_PARALLEL_REPORT'] = '1'

        # Select the test style to use.
        if self.test_style == "simple":
            # We always use reference outputs with TEST=simple.
            make_variables['ENABLE_HASHED_PROGRAM_OUTPUT'] = '1'
            make_variables['USE_REFERENCE_OUTPUT'] = '1'
            make_variables['TEST'] = self.test_style

        # Set CC_UNDER_TEST_IS_CLANG when appropriate.
        if cc_info.get('cc_name') in ('apple_clang', 'clang'):
            make_variables['CC_UNDER_TEST_IS_CLANG'] = '1'
        elif cc_info.get('cc_name') in ('llvm-gcc',):
            make_variables['CC_UNDER_TEST_IS_LLVM_GCC'] = '1'
        elif cc_info.get('cc_name') in ('gcc',):
            make_variables['CC_UNDER_TEST_IS_GCC'] = '1'

        # Convert the target arch into a make variable, to allow more
        # target based specialization (e.g.,
        # CC_UNDER_TEST_TARGET_IS_ARMV7).
        if '-' in cc_info.get('cc_target', ''):
            arch_name = cc_info.get('cc_target').split('-', 1)[0]
            CC_VAR = 'CC_UNDER_TEST_TARGET_IS_' + arch_name.upper()
            make_variables[CC_VAR] = '1'

        # Set LLVM_RELEASE_IS_PLUS_ASSERTS when appropriate, to allow
        # testing older LLVM source trees.
        llvm_source_version = self.llvm_source_version
        if llvm_source_version and llvm_source_version.isdigit() and \
           int(llvm_source_version) < 107758:
            make_variables['LLVM_RELEASE_IS_PLUS_ASSERTS'] = 1

        # Set ARCH appropriately, based on the inferred target.
        #
        # FIXME: We should probably be more strict about this.
        cc_target = cc_info.get('cc_target')
        llvm_arch = self.llvm_arch
        if cc_target and llvm_arch is None:
            # cc_target is expected to be a (GCC style) target
            # triple. Pick out the arch component, and then try to
            # convert it to an LLVM nightly test style architecture
            # name, which is of course totally different from all of
            # GCC names, triple names, LLVM target names, and LLVM
            # triple names. Stupid world.
            #
            # FIXME: Clean this up once everyone is on 'lnt runtest
            # nt' style nightly testing.
            arch = cc_target.split('-', 1)[0].lower()
            if len(arch) == 4 and arch[0] == 'i' and arch.endswith('86') and \
               arch[1] in '3456789':  # i[3-9]86
                llvm_arch = 'x86'
            elif arch in ('x86_64', 'amd64'):
                llvm_arch = 'x86_64'
            elif arch in ('powerpc', 'powerpc64', 'powerpc64le', 'ppu'):
                llvm_arch = 'PowerPC'
            elif (arch == 'arm' or arch.startswith('armv') or
                  arch == 'thumb' or arch.startswith('thumbv') or
                  arch == 'xscale'):
                llvm_arch = 'ARM'
            elif arch in ('aarch64', 'arm64'):
                llvm_arch = 'AArch64'
            elif arch.startswith('alpha'):
                llvm_arch = 'Alpha'
            elif arch.startswith('sparc'):
                llvm_arch = 'Sparc'
            elif arch in ('mips', 'mipsel', 'mips64', 'mips64el'):
                llvm_arch = 'Mips'

        if llvm_arch is not None:
            make_variables['ARCH'] = llvm_arch
        else:
            logger.warning("unable to infer ARCH, " +
                           "some tests may not run correctly!")

        # Add in any additional make flags passed in via --make-param.
        for entry in self.make_parameters:
            if '=' not in entry:
                name, value = entry, ''
            else:
                name, value = entry.split('=', 1)

            make_variables[name] = value

        # Set remote execution variables, if used.
        if self.remote:
            # make a copy of args for report, without remote options.
            public_vars = make_variables.copy()
            make_variables['REMOTE_HOST'] = self.remote_host
            make_variables['REMOTE_USER'] = self.remote_user
            make_variables['REMOTE_PORT'] = str(self.remote_port)
            make_variables['REMOTE_CLIENT'] = self.remote_client
        else:
            public_vars = make_variables

        # Set qemu user mode variables, if used.
        if self.qemu_user_mode:
            make_variables['USER_MODE_EMULATION'] = '1'
            make_variables['RUNUNDER'] = self.qemu_user_mode_command

        # Set USE_PERF flag, if specified.
        if self.use_perf:
            make_variables['USE_PERF'] = '1'

        return make_variables, public_vars

###


def scan_for_test_modules(config):
    base_modules_path = os.path.join(config.test_suite_root, 'LNTBased')
    if config.only_test is None:
        test_modules_path = base_modules_path
    elif config.only_test.startswith('LNTBased'):
        test_modules_path = os.path.join(config.test_suite_root,
                                         config.only_test)
    else:
        return

    # We follow links here because we want to support the ability for having
    # various "suites" of LNTBased tests in separate repositories, and allowing
    # users to just checkout them out elsewhere and link them into their LLVM
    # test-suite source tree.
    for dirpath, dirnames, filenames in os.walk(test_modules_path,
                                                followlinks=True):
        # Ignore the example tests, unless requested.
        if not config.include_test_examples and 'Examples' in dirnames:
            dirnames.remove('Examples')

        # Only use the SPEC test module if the ref input was requested.
        if not config.test_spec_ref and re.search('/spec', dirpath):
            continue

        # Check if this directory defines a test module.
        if 'TestModule' not in filenames:
            continue

        # If so, don't traverse any lower.
        del dirnames[:]

        # Add to the list of test modules.
        assert dirpath.startswith(base_modules_path + '/')
        yield dirpath[len(base_modules_path) + 1:]


def execute_command(test_log, basedir, args, report_dir):
    logfile = test_log

    if report_dir is not None:
        logfile = subprocess.PIPE
        # Open a duplicated logfile at the global dir.
        _, logname = os.path.split(test_log.name)
        global_log_path = os.path.join(report_dir, logname)
        global_log = open(global_log_path, 'a+')

    p = subprocess.Popen(args=args, stdin=None, stdout=logfile,
                         stderr=subprocess.STDOUT, cwd=basedir,
                         env=os.environ)

    if report_dir is not None:
        while p.poll() is None:
            line = p.stdout.readline()
            if len(line) > 0:
                test_log.write(line)
                global_log.write(line)

        global_log.close()

    return p.wait()


# FIXME: Support duplicate logfiles to global directory.
def execute_test_modules(test_log, test_modules, test_module_variables,
                         basedir, config, make_variables):
    # For now, we don't execute these in parallel, but we do forward the
    # parallel build options to the test.
    test_modules.sort()

    print('%s: executing test modules' % (timestamp(), ), file=sys.stderr)
    results = []
    for name in test_modules:
        # First, load the test module file.
        locals = globals = {}
        test_path = os.path.join(config.test_suite_root, 'LNTBased', name)
        # This is where shared code between test modules should go.
        sys.path.append(os.path.join(config.test_suite_root, 'LNTBased/lib'))
        test_obj_path = os.path.join(basedir, 'LNTBased', name)
        module_path = os.path.join(test_path, 'TestModule')
        module_file = open(module_path)
        try:
            exec(module_file, locals, globals)
        except Exception:
            info = traceback.format_exc()
            fatal("unable to import test module: %r\n%s" % (
                    module_path, info))

        # Lookup and instantiate the test class.
        test_class = globals.get('test_class')
        if test_class is None:
            fatal("no 'test_class' global in import test module: %r" % (
                    module_path,))
        try:
            test_instance = test_class()
        except Exception:
            info = traceback.format_exc()
            fatal("unable to instantiate test class for: %r\n%s" % (
                    module_path, info))

        if not isinstance(test_instance, TestModule):
            fatal("invalid test class (expected lnt.tests.nt.TestModule "
                  "subclass) for: %r" % module_path)

        # Create the per test variables, and ensure the output directory
        # exists.
        variables = test_module_variables.copy()
        variables['MODULENAME'] = name
        variables['SRCROOT'] = test_path
        variables['OBJROOT'] = test_obj_path
        mkdir_p(test_obj_path)

        # Execute the tests.
        try:
            test_samples = test_instance._execute_test(test_log, variables,
                                                       make_variables, config)
        except Exception:
            info = traceback.format_exc()
            fatal("exception executing tests for: %r\n%s" % (
                    module_path, info))

        # Check that the test samples are in the expected format.
        is_ok = True
        try:
            test_samples = list(test_samples)
            for item in test_samples:
                if not isinstance(item, lnt.testing.TestSamples):
                    is_ok = False
                    break
        except Exception:
            is_ok = False
        if not is_ok:
            fatal("test module did not return samples list: %r" % (
                    module_path,))

        results.append((name, test_samples))

    return results


def compute_test_module_variables(make_variables, config):
    # Set the test module options, which we try and restrict to a tighter
    # subset than what we pass to the LNT makefiles.
    test_module_variables = {
        'CC': make_variables['TARGET_LLVMGCC'],
        'CXX': make_variables['TARGET_LLVMGXX'],
        'CFLAGS': (make_variables['TARGET_FLAGS'] + ' ' +
                   make_variables['OPTFLAGS']),
        'CXXFLAGS': (make_variables['TARGET_FLAGS'] + ' ' +
                     make_variables['OPTFLAGS']),
    }

    # Add the remote execution variables.
    if config.remote:
        test_module_variables['REMOTE_HOST'] = make_variables['REMOTE_HOST']
        test_module_variables['REMOTE_USER'] = make_variables['REMOTE_USER']
        test_module_variables['REMOTE_PORT'] = make_variables['REMOTE_PORT']
        test_module_variables['REMOTE_CLIENT'] = \
            make_variables['REMOTE_CLIENT']

    # Add miscellaneous optional variables.
    if 'LD_ENV_OVERRIDES' in make_variables:
        value = make_variables['LD_ENV_OVERRIDES']
        assert value.startswith('env ')
        test_module_variables['LINK_ENVIRONMENT_OVERRIDES'] = value[4:]

    # This isn't possible currently, just here to mark what the option variable
    # would be called.
    if 'COMPILE_ENVIRONMENT_OVERRIDES' in make_variables:
        test_module_variables['COMPILE_ENVIRONMENT_OVERRIDES'] = \
            make_variables['COMPILE_ENVIRONMENT_OVERRIDES']

    if 'EXECUTION_ENVIRONMENT_OVERRIDES' in make_variables:
        test_module_variables['EXECUTION_ENVIRONMENT_OVERRIDES'] = \
            make_variables['EXECUTION_ENVIRONMENT_OVERRIDES']

    # We pass the test execution values as variables too, this might be better
    # passed as actual arguments.
    test_module_variables['THREADS'] = config.threads
    test_module_variables['BUILD_THREADS'] = \
        config.build_threads or config.threads
    return test_module_variables


def execute_nt_tests(test_log, make_variables, basedir, config):
    report_dir = config.report_dir
    common_args = ['make', '-k']
    common_args.extend('%s=%s' % (k, v) for k, v in make_variables.items())
    if config.only_test is not None:
        common_args.extend(['-C', config.only_test])

    # If we are using isolation, run under sandbox-exec.
    if config.use_isolation:
        # Write out the sandbox profile.
        sandbox_profile_path = os.path.join(basedir, "isolation.sb")
        print("%s: creating sandbox profile %r" % (
            timestamp(), sandbox_profile_path), file=sys.stderr)
        with open(sandbox_profile_path, 'w') as f:
            print("""
;; Sandbox profile for isolation test access.
(version 1)

;; Allow everything by default, and log debug messages on deny.
(allow default)
(debug deny)

;; Deny all file writes by default.
(deny file-write*)

;; Deny all network access by default.
(deny network*)

;; Explicitly allow writes to temporary directories, /dev/, and the sandbox
;; output directory.
(allow file-write*      (regex #"^/private/var/tmp/")
                        (regex #"^/private/tmp/")
                        (regex #"^/private/var/folders/")
                        (regex #"^/dev/")
                        (regex #"^%s"))""" % (basedir, ), file=f)
        common_args = ['sandbox-exec', '-f', sandbox_profile_path] +\
            common_args

    # Run a separate 'make build' step if --build-threads was given.
    if config.build_threads > 0:
        args = common_args + ['-j', str(config.build_threads), 'build']
        print('%s: running: %s' % (timestamp(),
                                   ' '.join('"%s"' % a
                                            for a in args)), file=test_log)
        test_log.flush()

        print('%s: building "nightly tests" with -j%u...' % (
            timestamp(), config.build_threads), file=sys.stderr)
        res = execute_command(test_log, basedir, args, report_dir)
        if res != 0:
            print("Failure while running make build! " \
                  "See log: %s" % test_log.name, file=sys.stderr)

    # Then 'make report'.
    args = common_args + ['-j', str(config.threads),
                          'report', 'report.%s.csv' % config.test_style]
    print('%s: running: %s' % (timestamp(),
                               ' '.join('"%s"' % a
                                        for a in args)), file=test_log)
    test_log.flush()

    # FIXME: We shouldn't need to set env=os.environ here, but if we don't
    # somehow MACOSX_DEPLOYMENT_TARGET gets injected into the environment on OS
    # X (which changes the driver behavior and causes generally weirdness).
    print('%s: executing "nightly tests" with -j%u...' % (
        timestamp(), config.threads), file=sys.stderr)

    res = execute_command(test_log, basedir, args, report_dir)

    if res != 0:
        print("Failure while running nightly tests!  "\
              "See log: %s" % test_log.name, file=sys.stderr)


# Keep a mapping of mangled test names, to the original names in the
# test-suite.
TEST_TO_NAME = {}
KNOWN_SAMPLE_KEYS = ('compile', 'exec', 'hash',
                     'gcc.compile', 'bc.compile', 'llc.compile',
                     'llc-beta.compile', 'jit.compile', 'gcc.exec', 'llc.exec',
                     'llc-beta.exec', 'jit.exec')


def load_nt_report_file(report_path, config):
    # Compute the test samples to report.
    sample_keys = []

    def append_to_sample_keys(tup):
        stat = tup[1]
        assert stat in KNOWN_SAMPLE_KEYS
        if stat not in config.exclude_stat_from_submission:
            sample_keys.append(tup)
    if config.test_style == "simple":
        test_namespace = 'nts'
        time_stat = ''
        # for now, user time is the unqualified Time stat
        if config.test_time_stat == "real":
            time_stat = 'Real_'
        append_to_sample_keys((True, 'compile', 'CC_' + time_stat + 'Time',
                               None, 'CC', float))
        append_to_sample_keys((False, 'hash', 'CC_Hash', None, 'CC', str))
        append_to_sample_keys((True, 'exec', 'Exec_' + time_stat + 'Time',
                               None, 'Exec', float))
    else:
        test_namespace = 'nightlytest'
        append_to_sample_keys((True, 'gcc.compile', 'GCCAS', 'time'))
        append_to_sample_keys((True, 'bc.compile', 'Bytecode', 'size'))
        if config.test_llc:
            append_to_sample_keys((True, 'llc.compile', 'LLC compile', 'time'))
        if config.test_llcbeta:
            append_to_sample_keys((True, 'llc-beta.compile',
                                   'LLC-BETA compile', 'time'))
        if config.test_jit:
            append_to_sample_keys((True, 'jit.compile', 'JIT codegen', 'time'))
        append_to_sample_keys((True, 'gcc.exec', 'GCC', 'time'))
        if config.test_llc:
            append_to_sample_keys((True, 'llc.exec', 'LLC', 'time'))
        if config.test_llcbeta:
            append_to_sample_keys((True, 'llc-beta.exec', 'LLC-BETA', 'time'))
        if config.test_jit:
            append_to_sample_keys((True, 'jit.exec', 'JIT', 'time'))

    # Load the report file.
    report_file = open(report_path, 'rb')
    reader_it = iter(csv.reader(report_file))

    # Get the header.
    header = next(reader_it)
    if header[0] != 'Program':
        fatal('unexpected report file, missing header')

    # Verify we have the keys we expect.
    if 'Program' not in header:
        fatal('missing key %r in report header' % 'Program')
    for item in sample_keys:
        required = item[0]
        header_name = item[2]
        if required and header_name not in header:
            fatal('missing key %r in report header' % header_name)

    # We don't use the test info, currently.
    test_info = {}
    test_samples = []
    no_errors = True
    for row in reader_it:
        record = dict(zip(header, row))

        program = record['Program']

        if config.only_test is not None:
            program = os.path.join(config.only_test, program)
        if config.rerun_test is not None:
            program = os.path.join(config.rerun_test, program)

        program_real = program
        program_mangled = program.replace('.', '_')
        test_base_name = program_mangled

        # Check if this is a subtest result, in which case we ignore missing
        # values.
        if '_Subtest_' in test_base_name:
            is_subtest = True
            test_base_name = test_base_name.replace('_Subtest_', '.')

        else:
            is_subtest = False

        test_base_name = '%s.%s' % (test_namespace, test_base_name)

        TEST_TO_NAME[test_base_name] = program_real

        for info in sample_keys:
            if len(info) == 4:
                required, name, key, tname = info
                success_key = None
                conv_f = float
            else:
                required, name, key, tname, success_key, conv_f = info

            test_name = '%s.%s' % (test_base_name, name)
            if not required and key not in record:
                continue
            value = record[key]
            if success_key is None:
                success_value = value
            else:
                success_value = record[success_key]

            # FIXME: Move to simpler and more succinct format, using .failed.
            if success_value == '*':
                if is_subtest:
                    continue
                status_value = lnt.testing.FAIL
                no_errors = False
            elif success_value == 'xfail':
                status_value = lnt.testing.XFAIL
            else:
                status_value = lnt.testing.PASS

            if test_namespace == 'nightlytest':
                test_samples.append(lnt.testing.TestSamples(
                        test_name + '.success',
                        [status_value != lnt.testing.FAIL], test_info))
            else:
                if status_value != lnt.testing.PASS:
                    test_samples.append(lnt.testing.TestSamples(
                            test_name + '.status', [status_value], test_info))
            if value != '*':
                sample_test_name = test_name
                if tname is not None:
                    sample_test_name += '.' + tname
                test_samples.append(lnt.testing.TestSamples(
                    sample_test_name, [conv_f(value)], test_info,
                    conv_f=conv_f))

    report_file.close()

    return test_samples, no_errors


def prepare_report_dir(config):
    # Set up the sandbox.
    sandbox_path = config.sandbox_path
    print(sandbox_path)
    if not os.path.exists(sandbox_path):
        print("%s: creating sandbox: %r" % (
            timestamp(), sandbox_path), file=sys.stderr)
        os.mkdir(sandbox_path)

    # Create the per-test directory.
    report_dir = config.report_dir
    if os.path.exists(report_dir):
        needs_clean = True
    else:
        needs_clean = False
        os.mkdir(report_dir)

    # Unless not using timestamps, we require the report dir not to exist.
    if needs_clean and config.timestamp_build:
        fatal('refusing to reuse pre-existing build dir %r' % report_dir)


def prepare_build_dir(config, iteration):
    # report_dir is supposed to be canonicalized, so we do not need to
    # call os.path.realpath before mkdir.
    build_dir = config.build_dir(iteration)
    if iteration is None:
        return build_dir

    if os.path.exists(build_dir):
        needs_clean = True
    else:
        needs_clean = False
        os.mkdir(build_dir)

    # Unless not using timestamps, we require the basedir not to exist.
    if needs_clean and config.timestamp_build:
        fatal('refusing to reuse pre-existing build dir %r' % build_dir)
    return build_dir


def update_tools(make_variables, config, iteration):
    """Update the test suite tools. """

    print('%s: building test-suite tools' % (timestamp(), ), file=sys.stderr)
    args = ['make', 'tools']
    args.extend('%s=%s' % (k, v) for k, v in make_variables.items())
    build_tools_log_path = os.path.join(config.build_dir(iteration),
                                        'build-tools.log')
    build_tools_log = open(build_tools_log_path, 'w')
    print('%s: running: %s' % (timestamp(),
                               ' '.join('"%s"' % a
                                        for a in args)), file=build_tools_log)
    build_tools_log.flush()
    res = execute_command(build_tools_log, config.build_dir(iteration),
                          args, config.report_dir)
    build_tools_log.close()
    if res != 0:
        fatal('Unable to build tools, aborting! See log: %s' %
              build_tools_log_path)


def configure_test_suite(config, iteration):
    """Run configure on the test suite."""

    basedir = config.build_dir(iteration)
    configure_log_path = os.path.join(basedir, 'configure.log')
    configure_log = open(configure_log_path, 'w')

    args = [os.path.realpath(os.path.join(config.test_suite_root,
                                          'configure'))]
    if config.without_llvm:
        args.extend(['--without-llvmsrc', '--without-llvmobj'])
    else:
        args.extend(['--with-llvmsrc=%s' % config.llvm_src_root,
                     '--with-llvmobj=%s' % config.llvm_obj_root])

    if config.test_suite_externals:
        args.append('--with-externals=%s' %
                    os.path.realpath(config.test_suite_externals))

    args.extend(['--target=%s' % config.target])

    print('%s: running: %s' % (timestamp(),
                               ' '.join('"%s"' % a
                                        for a in args)), file=configure_log)
    configure_log.flush()

    print('%s: configuring...' % timestamp(), file=sys.stderr)
    res = execute_command(configure_log, basedir, args, config.report_dir)
    configure_log.close()
    if res != 0:
        fatal('Configure failed, log is here: %r' % configure_log_path)


def copy_missing_makefiles(config, basedir):
    """When running with only_test something, makefiles will be missing,
    so copy them into place. """
    suffix = ''
    for component in config.only_test.split('/'):
        suffix = os.path.join(suffix, component)
        obj_path = os.path.join(basedir, suffix)
        src_path = os.path.join(config.test_suite_root, suffix)
        if not os.path.exists(obj_path):
            print('%s: initializing test dir %s' % (timestamp(), suffix))
            os.mkdir(obj_path)
            shutil.copyfile(os.path.join(src_path, 'Makefile'),
                            os.path.join(obj_path, 'Makefile'))


def run_test(nick_prefix, iteration, config):
    print("%s: checking source versions" % (
        timestamp(), ), file=sys.stderr)

    test_suite_source_version = get_source_version(config.test_suite_root)

    # Compute the make variables.
    make_variables, public_make_variables = config.compute_run_make_variables()

    # Compute the test module variables, which are a restricted subset of the
    # make variables.
    test_module_variables = compute_test_module_variables(make_variables,
                                                          config)

    # Scan for LNT-based test modules.
    print("%s: scanning for LNT-based test modules" % (
        timestamp(), ), file=sys.stderr)
    test_modules = list(scan_for_test_modules(config))
    print("%s: found %d LNT-based test modules" % (
        timestamp(), len(test_modules)), file=sys.stderr)

    nick = nick_prefix
    if config.auto_name:
        # Construct the nickname from a few key parameters.
        cc_info = config.cc_info
        cc_nick = '%s_%s' % (cc_info.get('cc_name'), cc_info.get('cc_build'))
        nick += "__%s__%s" % (cc_nick, cc_info.get('cc_target').split('-')[0])
    print("%s: using nickname: %r" % (timestamp(), nick), file=sys.stderr)

    basedir = prepare_build_dir(config, iteration)

    # FIXME: Auto-remove old test directories in the source directory (which
    # cause make horrible fits).

    start_time = timestamp()
    print('%s: starting test in %r' % (start_time, basedir), file=sys.stderr)

    # Configure the test suite.
    if config.run_configure or not os.path.exists(os.path.join(
            basedir, 'Makefile.config')):
        configure_test_suite(config, iteration)

    # If running with --only-test, creating any dirs which might be missing and
    # copy Makefiles.
    if config.only_test is not None and \
       not config.only_test.startswith("LNTBased"):
        copy_missing_makefiles(config, basedir)

    # If running without LLVM, make sure tools are up to date.
    if config.without_llvm:
        update_tools(make_variables, config, iteration)

    # Always blow away any existing report.
    build_report_path = config.build_report_path(iteration)
    if os.path.exists(build_report_path):
        os.remove(build_report_path)

    # Execute the tests.
    test_log = open(config.test_log_path(iteration), 'w')

    # Run the make driven tests if needed.
    run_nightly_test = (config.only_test is None or
                        not config.only_test.startswith("LNTBased"))
    if run_nightly_test:
        execute_nt_tests(test_log, make_variables, basedir, config)

    # Run the extension test modules, if needed.
    test_module_results = execute_test_modules(test_log, test_modules,
                                               test_module_variables, basedir,
                                               config, make_variables)
    test_log.close()

    end_time = timestamp()

    # Load the nightly test samples.
    if config.test_style == "simple":
        test_namespace = 'nts'
    else:
        test_namespace = 'nightlytest'
    if run_nightly_test:
        print('%s: loading nightly test data...' % timestamp(), file=sys.stderr)
        # If nightly test went screwy, it won't have produced a report.
        print(build_report_path)
        if not os.path.exists(build_report_path):
            fatal('nightly test failed, no report generated')

        test_samples, no_errors = \
            load_nt_report_file(build_report_path, config)
    else:
        test_samples = []
        no_errors = True

    # Merge in the test samples from all of the test modules.
    existing_tests = set(s.name for s in test_samples)
    for module, results in test_module_results:
        for s in results:
            if s.name in existing_tests:
                fatal("test module %r added duplicate test: %r" % (
                        module, s.name))
            existing_tests.add(s.name)
        test_samples.extend(results)

    print('%s: capturing machine information' % (timestamp(), ), file=sys.stderr)
    # Collect the machine and run info.
    #
    # FIXME: Import full range of data that the Clang tests are using?
    machine_info = {}
    machine_info['hardware'] = capture(["uname", "-m"],
                                       include_stderr=True).strip()
    machine_info['os'] = capture(["uname", "-sr"], include_stderr=True).strip()
    if config.cc_reference is not None:
        machine_info['gcc_version'] = capture(
            [config.cc_reference, '--version'],
            include_stderr=True).split('\n')[0]

    # FIXME: We aren't getting the LLCBETA options.
    run_info = {}
    run_info['tag'] = test_namespace
    run_info['no_errors'] = no_errors
    run_info.update(config.cc_info)

    # Capture sw_vers if this looks like Darwin.
    if 'Darwin' in machine_info['os']:
        run_info['sw_vers'] = capture(['sw_vers'], include_stderr=True).strip()

    # Query remote properties if in use.
    if config.remote:
        remote_args = [config.remote_client,
                       "-l", config.remote_user,
                       "-p", str(config.remote_port),
                       config.remote_host]
        run_info['remote_uname'] = capture(remote_args + ["uname", "-a"],
                                           include_stderr=True).strip()

        # Capture sw_vers if this looks like Darwin.
        if 'Darwin' in run_info['remote_uname']:
            run_info['remote_sw_vers'] = capture(remote_args + ["sw_vers"],
                                                 include_stderr=True).strip()

    # Query qemu user mode properties if in use.
    if config.qemu_user_mode:
        run_info['qemu_user_mode'] = config.qemu_user_mode_command

    # Add machine dependent info.
    if config.use_machdep_info:
        machdep_info = machine_info
    else:
        machdep_info = run_info

    machdep_info['uname'] = capture(["uname", "-a"],
                                    include_stderr=True).strip()
    machdep_info['name'] = capture(["uname", "-n"],
                                   include_stderr=True).strip()

    # FIXME: Hack, use better method of getting versions. Ideally, from
    # binaries so we are more likely to be accurate.
    if config.llvm_source_version is not None:
        run_info['llvm_revision'] = config.llvm_source_version
    run_info['test_suite_revision'] = test_suite_source_version
    run_info.update(public_make_variables)

    # Set the run order from the user, if given.
    if config.run_order is not None:
        run_info['run_order'] = config.run_order

    else:
        # Otherwise, use the inferred run order from the compiler.
        run_info['run_order'] = config.cc_info['inferred_run_order']

    # Add any user specified parameters.
    for target, params in ((machine_info, config.machine_parameters),
                           (run_info, config.run_parameters)):
        for entry in params:
            if '=' not in entry:
                name, value = entry, ''
            else:
                name, value = entry.split('=', 1)
            if name in target:
                logger.warning("parameter %r overwrote existing value: %r" %
                               (name, target.get(name)))
            print(target, name, value)
            target[name] = value

    # Generate the test report.
    lnt_report_path = config.report_path(iteration)
    print('%s: generating report: %r' % (timestamp(),
                                         lnt_report_path), file=sys.stderr)
    machine = lnt.testing.Machine(nick, machine_info)
    run = lnt.testing.Run(start_time, end_time, info=run_info)

    report = lnt.testing.Report(machine, run, test_samples)
    lnt_report_file = open(lnt_report_path, 'w')
    print(report.render(), file=lnt_report_file)
    lnt_report_file.close()

    return report

###


def _construct_report_path(basedir, only_test, test_style, file_type="csv"):
    """Get the full path to report files in the sandbox.
    """
    report_path = os.path.join(basedir)
    if only_test is not None:
        report_path = os.path.join(report_path, only_test)
    report_path = os.path.join(report_path,
                               ('report.%s.' % test_style) + file_type)
    return report_path


def rerun_test(config, name, num_times):
    """Take the test at name, and rerun it num_times with the previous settings
    stored in config.

    """
    # Extend the old log file.
    logfile = open(config.test_log_path(None), 'a')

    # Grab the real test name instead of the LNT benchmark URL.
    real_name = TEST_TO_NAME["nts." + name]

    relative_test_path = os.path.dirname(real_name)
    test_name = os.path.basename(real_name)

    test_full_path = os.path.join(
        config.report_dir, relative_test_path)

    assert os.path.exists(test_full_path), \
        "Previous test directory not there?" + test_full_path

    results = []
    no_errors = True
    for _ in xrange(0, num_times):
        test_results, t_no_errors = _execute_test_again(
            config, test_name, test_full_path, relative_test_path, logfile)
        no_errors &= t_no_errors
        results.extend(test_results)

    # Check we got an exec and status from each run.
    assert len(results) >= num_times, \
        "Did not get all the runs?" + str(results)

    logfile.close()
    return results, no_errors


def _prepare_testsuite_for_rerun(test_name, test_full_path, config):
    """Rerun  step 1: wipe out old files to get ready for rerun.

    """
    output = os.path.join(test_full_path, "Output/")
    test_path_prefix = output + test_name + "."
    os.remove(test_path_prefix + "out-" + config.test_style)

    # Remove all the test-suite accounting files for this benchmark
    to_go = glob.glob(test_path_prefix + "*.time")
    to_go.extend(glob.glob(test_path_prefix + "*.txt"))
    to_go.extend(glob.glob(test_path_prefix + "*.csv"))

    assert len(to_go) >= 1, "Missing at least one accounting file."
    for path in to_go:
        print("Removing:", path)
        os.remove(path)


def _execute_test_again(config, test_name, test_path, test_relative_path,
                        logfile):
    """(Re)Execute the benchmark of interest. """

    _prepare_testsuite_for_rerun(test_name, test_path, config)

    # Grab old make invocation.
    mk_vars, _ = config.compute_run_make_variables()
    to_exec = ['make', '-k']
    to_exec.extend('%s=%s' % (k, v) for k, v in mk_vars.items())

    # We need to run the benchmark's makefile, not the global one.
    if config.only_test is not None:
        to_exec.extend(['-C', config.only_test])
    else:
        if test_relative_path:
            to_exec.extend(['-C', test_relative_path])
            config.rerun_test = test_relative_path
    # The target for the specific benchmark.
    # Make target.
    benchmark_report_target = "Output/" + test_name + \
        "." + config.test_style + ".report.txt"
    # Actual file system location of the target.
    benchmark_report_path = os.path.join(config.build_dir(None),
                                         test_path,
                                         benchmark_report_target)
    to_exec.append(benchmark_report_target)

    returncode = execute_command(logfile,
                                 config.build_dir(None), to_exec,
                                 config.report_dir)
    assert returncode == 0, "Remake command failed."
    assert os.path.exists(benchmark_report_path), "Missing " \
        "generated report: " + benchmark_report_path

    # Now we need to pull out the results into the CSV format LNT can read.
    schema = os.path.join(config.test_suite_root,
                          "TEST." + config.test_style + ".report")
    result_path = os.path.join(config.build_dir(None),
                               test_path, "Output",
                               test_name + "." + config.test_style +
                               ".report.csv")

    gen_report_template = "{gen} -csv {schema} < {input} > {output}"
    gen_cmd = gen_report_template.format(gen=config.generate_report_script,
                                         schema=schema,
                                         input=benchmark_report_path,
                                         output=result_path)
    bash_gen_cmd = ["/bin/bash", "-c", gen_cmd]

    assert not os.path.exists(result_path), "Results should not exist yet." + \
        result_path
    returncode = execute_command(logfile, config.build_dir(None), bash_gen_cmd,
                                 config.report_dir)
    assert returncode == 0, "command failed"
    assert os.path.exists(result_path), "Missing results file."

    results, no_errors = load_nt_report_file(result_path, config)
    assert len(results) > 0
    return results, no_errors


def _unix_quote_args(s):
    return list(map(pipes.quote, shlex.split(s)))


# When set to true, all benchmarks will be rerun.
# TODO: remove me when rerun patch is done.
NUMBER_OF_RERUNS = 4

SERVER_FAIL = u'FAIL'
SERVER_PASS = u'PASS'

# Local test results names have these suffixes
# Test will have the perf suffix if it passed, or
# if it failed it will have a status suffix.
LOCAL_COMPILE_PERF = "compile"
LOCAL_COMPILE_STATUS = "compile.status"
LOCAL_HASH = "hash"
LOCAL_HASH_STATUS = "hash.status"
LOCAL_EXEC_PERF = "exec"
LOCAL_EXEC_STATUS = "exec.status"

# Server results have both status and performance in each entry
SERVER_COMPILE_RESULT = "compile_time"
SERVER_EXEC_RESULT = "execution_time"
SERVER_SCORE_RESULT = "score"
SERVER_MEM_RESULT = "mem"
SERVER_HASH_RESULT = "hash"
SERVER_CODESIZE_RESULT = "code_size"


class PastRunData(object):
    """To decide if we need to rerun, we must know
    what happened on each test in the first runs.
    Because the server returns data in a different format than
    the local results, this class is comprised of a per-test
    per-run aggregate of the two reports."""
    def __init__(self, name):
        self.name = name
        self.compile_status = None
        self.compile_time = None
        self.execution_status = None
        self.execution_time = None
        self.valid = False

    def check(self):
        """Make sure this run data is complete."""
        assert self.name is not None
        msg = "Malformed test: %s" % (repr(self))
        assert self.compile_status is not None, msg
        assert self.execution_status is not None, msg
        assert self.compile_time is not None, msg

        self.valid = True

    def is_rerunable(self):
        """Decide if we should rerun this test."""
        assert self.valid
        # Don't rerun if compile failed.
        if self.compile_status == SERVER_FAIL:
            return False

        # Don't rerun on correctness failure or test pass.
        if self.execution_status == UNCHANGED_FAIL or \
           self.execution_status == UNCHANGED_PASS or \
           self.execution_status == SERVER_FAIL:
            return False

        # Do rerun on regression or improvement.
        if self.execution_status == REGRESSED or \
           self.execution_status == IMPROVED:
            return True

        assert False, "Malformed run data: " \
            "you should not get here. " + str(self)

    def __repr__(self):
        template = "<{}: CS {}, CT {}, ES {}, ET {}>"
        return template.format(self.name,
                               repr(self.compile_status),
                               repr(self.compile_time),
                               repr(self.execution_status),
                               repr(self.execution_time))


def _process_reruns(config, server_reply, local_results):
    """Rerun each benchmark which the server reported "changed", N more
    times.
    """
    try:
        server_results = server_reply['test_results'][0]['results']
    except KeyError:
        # Server might send us back an error.
        if server_reply.get('error', None):
            logger.warning("Server returned an error:" + server_reply['error'])
        fatal("No Server results. Cannot do reruns.")
    # Holds the combined local and server results.
    collated_results = dict()

    for b in local_results.tests:
        # format: suite.test/path/and/name.type<.type>
        fields = b.name.split('.')

        test_type_size = -1
        if fields[-1] == "status":
            test_type_size = -2

        test_type = '.'.join(fields[test_type_size:])

        test_name = '.'.join(fields[1:test_type_size])

        updating_entry = collated_results.get(test_name,
                                              PastRunData(test_name))

        # Filter out "LNTBased" benchmarks for rerun, they
        # won't work. LNTbased look like nts.module.test
        # So just filter out anything with .
        if '.' in test_name:
            continue

        if test_type == LOCAL_COMPILE_PERF:
            updating_entry.compile_time = b.data
        elif test_type == LOCAL_COMPILE_STATUS:
            updating_entry.compile_status = SERVER_FAIL
        elif test_type == LOCAL_EXEC_PERF:
            updating_entry.execution_time = b.data
        elif test_type == LOCAL_EXEC_STATUS:
            updating_entry.execution_status = SERVER_FAIL
        elif test_type == LOCAL_HASH:
            # do not trigger reruns just because the binary has changed.
            pass
        elif test_type == LOCAL_HASH_STATUS:
            updating_entry.hash_status = SERVER_FAIL
        else:
            assert False, "Unexpected local test type."

        collated_results[test_name] = updating_entry

    # Now add on top the server results to any entry we already have.
    for full_name, results_status, perf_status in server_results:
        fields = full_name.split(".")
        test_name = '.'.join(fields[:-1])
        test_type = fields[-1]

        new_entry = collated_results.get(test_name, None)
        # Some tests will come from the server, which we did not run locally.
        # Drop them.
        if new_entry is None:
            continue
        # Set these, if they were not set with fails above.
        if SERVER_COMPILE_RESULT in test_type:
            if new_entry.compile_status is None:
                new_entry.compile_status = results_status
        elif (SERVER_EXEC_RESULT in test_type or
              SERVER_SCORE_RESULT in test_type or
              SERVER_MEM_RESULT in test_type):
            if new_entry.execution_status is None:
                # If the server has not seen the test before, it will return
                # None for the performance results analysis. In this case we
                # will assume no rerun is needed, so assign unchanged.
                if perf_status is None:
                    derived_perf_status = UNCHANGED_PASS
                else:
                    derived_perf_status = perf_status
                new_entry.execution_status = derived_perf_status
        elif SERVER_CODESIZE_RESULT in test_type:
            # NT suite can't do code size, so don't rerun.
            pass
        else:
            assert False, "Unexpected server result type." + test_type
        collated_results[test_name] = new_entry

    # Double check that all values are there for all tests.
    for test in collated_results.values():
        test.check()

    rerunable_benches = list(filter(lambda bench: bench.is_rerunable(),
                                    collated_results.values()))
    rerunable_benches.sort(key=lambda x: x.name)
    # Now lets do the reruns.
    rerun_results = []
    summary = "Rerunning {} of {} benchmarks."
    logger.info(summary.format(len(rerunable_benches),
                               len(collated_results)))

    for i, bench in enumerate(rerunable_benches):
        logger.info("Rerunning: {} [{}/{}]".format(bench.name,
                                                   i + 1,
                                                   len(rerunable_benches)))

        fresh_samples, t_no_errors = rerun_test(config,
                                                bench.name, NUMBER_OF_RERUNS)
        rerun_results.extend(fresh_samples)

    return rerun_results


usage_info = """

Script for running the tests in LLVM's test-suite repository.

This script expects to run against a particular LLVM source tree, build, and
compiler. It is only responsible for running the tests in the test-suite
repository, and formatting the results for submission to an LNT server.

Basic usage:

\b
  lnt runtest nt \\
    --sandbox FOO \\
    --cc ~/llvm.obj.64/Release/bin/clang \\
    --test-suite ~/llvm-test-suite

where --sandbox is the directory to build and store results in, --cc and --cxx
are the full paths to the compilers to test, and --test-suite is the path to
the test-suite source.

To do a quick test, you can add something like:

    -j 16 --only-test SingleSource

which will run with 16 threads and only run the tests inside SingleSource.

To do a really quick test, you can further add

    --no-timestamp --no-configure

which will cause the same build directory to be used, and the configure step
will be skipped if it appears to already have been configured. This is
effectively an incremental retest. It is useful for testing the scripts or
nightly test, but it should not be used for submissions."""


class NTTest(builtintest.BuiltinTest):
    def run_test(self, opts):

        opts.cflag_string = ' '.join(opts.cflag_string)

        # The --without--llvm option is the default if no LLVM paths are given.
        if opts.llvm_src_root is None and opts.llvm_obj_root is None:
            opts.without_llvm = True

        # Deprecate --simple
        if opts.test_simple:
            logger.warning("--simple is deprecated, it is the default.")
        del opts.test_simple

        if opts.test_style == "simple":
            # TEST=simple doesn't use a reference compiler.
            if opts.cc_reference is not None:
                self._fatal('--cc-reference is unused with --simple')
            if opts.cxx_reference is not None:
                self._fatal('--cxx-reference is unused with --simple')
            # TEST=simple doesn't use a llc options.
            if opts.mcpu is not None:
                self._fatal('--mcpu is unused with --simple (use --cflag)')
            if opts.relocation_model is not None:
                self._fatal('--relocation-model is unused with --simple '
                            '(use --cflag)')
            if opts.disable_fp_elim:
                self._fatal('--disable-fp-elim is unused with --simple '
                            '(use --cflag)')
        else:
            if opts.without_llvm:
                self._fatal('--simple is required with --without-llvm')

            # Attempt to infer cc_reference and cxx_reference if not given.
            if opts.cc_reference is None:
                opts.cc_reference = which('gcc') or which('cc')
                if opts.cc_reference is None:
                    self._fatal('unable to infer --cc-reference (required)')
            if opts.cxx_reference is None:
                opts.cxx_reference = which('g++') or which('c++')
                if opts.cxx_reference is None:
                    self._fatal('unable to infer --cxx-reference (required)')

        if opts.cc_under_test is None:
            self._fatal('--cc is required')

        # Resolve the cc_under_test path.
        opts.cc_under_test = resolve_command_path(opts.cc_under_test)

        if not lnt.testing.util.compilers.is_valid(opts.cc_under_test):
            self._fatal('--cc does not point to a valid executable.')

        # If there was no --cxx given, attempt to infer it from the --cc.
        if opts.cxx_under_test is None:
            opts.cxx_under_test = \
                lnt.testing.util.compilers.infer_cxx_compiler(
                    opts.cc_under_test)
            if opts.cxx_under_test is not None:
                logger.info("inferred C++ compiler under test as: %r" %
                            (opts.cxx_under_test,))

        # The cxx_under_test option is required if we are testing C++.
        if opts.test_cxx and opts.cxx_under_test is None:
            self._fatal('--cxx is required')

        if opts.cxx_under_test is not None:
            opts.cxx_under_test = resolve_command_path(opts.cxx_under_test)

        # Always set cxx_under_test, since it may be used as the linker even
        # when not testing C++ code.
        if opts.cxx_under_test is None:
            opts.cxx_under_test = opts.cc_under_test

        # Validate that the compilers under test exist.
        if not os.path.exists(opts.cc_under_test):
            self._fatal("invalid --cc argument %r, does not exist" % (
                opts.cc_under_test))
        if not os.path.exists(opts.cxx_under_test):
            self._fatal("invalid --cxx argument %r, does not exist" % (
                opts.cxx_under_test))

        # FIXME: As a hack to allow sampling old Clang revisions, if we are
        # given a C++ compiler that doesn't exist, reset it to just use the
        # given C compiler.
        if not os.path.exists(opts.cxx_under_test):
            logger.warning("invalid cxx_under_test, " +
                           "falling back to cc_under_test")
            opts.cxx_under_test = opts.cc_under_test

        if opts.without_llvm:
            if opts.llvm_src_root is not None:
                self._fatal('--llvm-src is not allowed with --without-llvm')
            if opts.llvm_obj_root is not None:
                self._fatal('--llvm-obj is not allowed with --without-llvm')
        else:
            if opts.llvm_src_root is None:
                self._fatal('--llvm-src is required')
            if opts.llvm_obj_root is None:
                self._fatal('--llvm-obj is required')

            # Make LLVM source and object paths absolute, this is required.
            opts.llvm_src_root = os.path.abspath(opts.llvm_src_root)
            opts.llvm_obj_root = os.path.abspath(opts.llvm_obj_root)
            if not os.path.exists(opts.llvm_src_root):
                self._fatal('--llvm-src argument does not exist')
            if not os.path.exists(opts.llvm_obj_root):
                self._fatal('--llvm-obj argument does not exist')

        if opts.test_suite_root is None:
            self._fatal('--test-suite is required')
        elif not os.path.exists(opts.test_suite_root):
            self._fatal("invalid --test-suite argument, does not exist: %r" % (
                opts.test_suite_root))

        if opts.remote:
            if opts.remote_port is None:
                self._fatal('--remote-port is required with --remote')
            if opts.remote_user is None:
                self._fatal('--remote-user is required with --remote')
        else:
            if opts.remote_port is not None:
                self._fatal('--remote is required with --remote-port')
            if opts.remote_user is not None:
                self._fatal('--remote is required with --remote-user')

        if opts.spec_with_pgo and not opts.test_spec_ref:
            self._fatal('--spec-with-pgo is only supported with '
                        '--spec-with-ref')

        # libLTO should exist, if given.
        if opts.liblto_path:
            if not os.path.exists(opts.liblto_path):
                self._fatal('invalid --liblto-path argument %r' % (
                    opts.liblto_path,))

        # Support disabling test suite externals separately from providing
        # path.
        if not opts.test_externals:
            opts.test_suite_externals = '/dev/null'
        else:
            if not os.path.exists(opts.test_suite_externals):
                self._fatal(
                    "invalid --test-externals argument, does not exist: %r" % (
                        opts.test_suite_externals))

        # Set up iOS simulator options.
        if opts.ios_simulator_sdk:
            # Warn if the user asked to run under an iOS simulator SDK, but
            # didn't set an isysroot for compilation.
            if opts.isysroot is None:
                logger.warning('expected --isysroot when executing with '
                               '--ios-simulator-sdk')

        config = TestConfiguration(vars(opts), timestamp())
        # FIXME: We need to validate that there is no configured output in the
        # test-suite directory, that borks things. <rdar://problem/7876418>
        prepare_report_dir(config)

        # These notes are used by the regression tests to check if we've
        # handled flags correctly.
        logger.info('TARGET_FLAGS: {}'.format(' '.join(config.target_flags)))
        if config.qemu_user_mode:
            logger.info('QEMU_USER_MODE_COMMAND: {}'
                        .format(config.qemu_user_mode_command))

        # Multisample, if requested.
        merge_run = None
        if opts.multisample is not None:
            # Collect the sample reports.
            reports = []

            for i in range(opts.multisample):
                print("%s: (multisample) running iteration %d" %\
                        (timestamp(), i), file=sys.stderr)
                report = run_test(opts.label, i, config)
                reports.append(report)

            # Create the merged report.
            #
            # FIXME: Do a more robust job of merging the reports?
            print("%s: (multisample) creating merged report" % (
                timestamp(), ), file=sys.stderr)
            machine = reports[0].machine
            run = reports[0].run
            run.end_time = reports[-1].run.end_time
            test_samples = sum([r.tests
                                for r in reports], [])

            # Write out the merged report.
            lnt_report_path = config.report_path(None)
            report = lnt.testing.Report(machine, run, test_samples)
            lnt_report_file = open(lnt_report_path, 'w')
            print(report.render(), file=lnt_report_file)
            lnt_report_file.close()

        else:
            test_results = run_test(opts.label, None, config)
            if opts.rerun:
                self.log("Performing any needed reruns.")
                server_report = self.submit_helper(config)
                new_samples = _process_reruns(config, server_report,
                                              test_results)
                test_results.update_report(new_samples)

                # persist report with new samples.
                lnt_report_path = config.report_path(None)

                lnt_report_file = open(lnt_report_path, 'w')
                print(test_results.render(), file=lnt_report_file)
                lnt_report_file.close()
                merge_run = 'replace'

            if config.output is not None:
                self.print_report(test_results, config.output)

        server_report = self.submit_helper(config, merge_run)

        ImportData.print_report_result(server_report,
                                       sys.stdout,
                                       sys.stderr,
                                       config.verbose)
        return server_report

    def submit_helper(self, config, merge_run=None):
        """Submit the report to the server.  If no server
        was specified, use a local mock server.
        """
        report_path = config.report_path(None)
        assert os.path.exists(report_path), "Passed an invalid report file. " \
            "Should have never gotten here!"

        result = None
        if config.submit_url:
            from lnt.util import ServerUtil
            for server in config.submit_url:
                self.log("submitting result to %r" % (server,))
                try:
                    result = ServerUtil.submitFile(server, report_path, False,
                                                   merge_run=merge_run)
                except (urllib2.HTTPError, urllib2.URLError) as e:
                    logger.warning("submitting to {} failed with {}"
                                   .format(server, e))
        else:
            # Simulate a submission to retrieve the results report.
            # Construct a temporary database and import the result.
            self.log("submitting result to dummy instance")

            import lnt.server.db.v4db
            import lnt.server.config
            db = lnt.server.db.v4db.V4DB("sqlite:///:memory:",
                                         lnt.server.config.Config
                                         .dummy_instance())
            session = db.make_session()
            result = lnt.util.ImportData.import_and_report(
                None, None, db, session, report_path, 'json', 'nts')

        if result is None:
            fatal("Results were not obtained from submission.")

        return result


def _tools_check():
    """
    Check that the required software is installed in the system.

    This check is used to make sure the tests won't fail because of a missing
    tool (like yacc or tclsh).

    As new tools end up required by the tests, add them here.
    """
    from subprocess import call

    # Let's try only on Linux, for now
    if platform.system() != 'Linux':
        return

    FNULL = open(os.devnull, 'w')

    status = call(["which", "yacc"], stdout=FNULL, stderr=FNULL)
    if status > 0:
        raise SystemExit("""error: yacc not available on your system.""")

    status = call(["which", "awk"], stdout=FNULL, stderr=FNULL)
    if status > 0:
        raise SystemExit("""error: awk not available on your system.""")

    status = call(["which", "groff"], stdout=FNULL, stderr=FNULL)
    if status > 0:
        raise SystemExit("""error: groff not available on your system.""")

    status = call(["which", "tclsh"], stdout=FNULL, stderr=FNULL)
    if status > 0:
        raise SystemExit("""error: tclsh not available on your system.""")


# FIXME: an equivalent to argparse's add_argument_group is not implemented
#        on click. Need to review it when such functionality is available.
#        https://github.com/pallets/click/issues/373
@click.command("nt", help=usage_info, short_help=__doc__)
@click.argument("label", default=platform.uname()[1], required=False,
                type=click.UNPROCESSED)
#  Sandbox
@click.option("-s", "--sandbox", "sandbox_path", required=True,
              help="parent directory to build and run tests in",
              type=click.UNPROCESSED)
@click.option("--no-timestamp", "timestamp_build", flag_value=False,
              default=True, show_default=True,
              help="don't timestamp build directory (for testing)")
@click.option("--no-configure", "run_configure", flag_value=False,
              default=True, show_default=True,
              help="don't run configure if Makefile.config is "
                   "present (only useful with --no-timestamp)")
#  Inputs
@click.option("--without-llvm", is_flag=True, show_default=True,
              help="don't use any LLVM source or build products")
@click.option("--llvm-src", "llvm_src_root",
              help="path to the LLVM source tree",
              type=click.UNPROCESSED)
@click.option("--llvm-obj", "llvm_obj_root", metavar="PATH",
              help="path to the LLVM source tree",
              type=click.UNPROCESSED)
@click.option("--test-suite", "test_suite_root", metavar="PATH",
              help="path to the LLVM test-suite sources",
              type=click.UNPROCESSED)
@click.option("--test-externals", "test_suite_externals",
              show_default=True,
              help="path to the LLVM test-suite externals",
              default='/dev/null', metavar="PATH",
              type=click.UNPROCESSED)
#  Test Compiler
@click.option("--cc", "cc_under_test", metavar="CC",
              help="path to the C compiler to test",
              type=click.UNPROCESSED)
@click.option("--cxx", "cxx_under_test", metavar="CXX",
              help="path to the C++ compiler to test",
              type=click.UNPROCESSED)
@click.option("--cc-reference",
              help="path to the reference C compiler",
              type=click.UNPROCESSED)
@click.option("--cxx-reference",
              help="path to the reference C++ compiler",
              type=click.UNPROCESSED)
#  Test Options
@click.option("--arch", help="Set -arch in TARGET_FLAGS")
@click.option("--llvm-arch",
              help="Set the ARCH value used in the makefiles to",
              type=click.UNPROCESSED)
@click.option("--make-param", "make_parameters", multiple=True,
              help="Add 'NAME' = 'VAL' to the makefile parameters",
              type=click.UNPROCESSED)
@click.option("--isysroot", "isysroot", metavar="PATH",
              help="Set -isysroot in TARGET_FLAGS",
              type=click.UNPROCESSED)
@click.option("--liblto-path", metavar="PATH",
              help="Specify the path to the libLTO library",
              type=click.UNPROCESSED)
@click.option("--mcpu", metavar="CPU",
              help="Set -mcpu in TARGET_LLCFLAGS",
              type=click.UNPROCESSED)
@click.option("--relocation-model", metavar="MODEL",
              help="Set -relocation-model in TARGET_LLCFLAGS",
              type=click.UNPROCESSED)
@click.option("--disable-fp-elim", is_flag=True,
              help="Set -disable-fp-elim in TARGET_LLCFLAGS")
@click.option("--optimize-option", show_default=True,
              help="Set optimization level for {LLC_,LLI_,}OPTFLAGS",
              type=click.Choice(['-O0', '-O1', '-O2',
                                 '-O3', '-Os', '-Oz']),
              default='-O3')
@click.option("--cflag", "cflags", multiple=True,
              help="Additional flags to set in TARGET_FLAGS",
              type=click.UNPROCESSED, default=[], metavar="FLAG")
@click.option("--cflags", "cflag_string", multiple=True,
              help="Additional flags to set in TARGET_FLAGS, space "
                   "separated string. These flags are appended after "
                   "*all* the individual --cflag arguments.",
              type=click.UNPROCESSED, default='', metavar="FLAG")
@click.option("--mllvm", multiple=True,
              help="Add -mllvm FLAG to TARGET_FLAGS",
              type=click.UNPROCESSED, default=[], metavar="FLAG")
@click.option("--spec-with-pgo", is_flag=True, help="Use PGO with SPEC")
@click.option("--build-mode", metavar="NAME", show_default=True,
              default='Release+Asserts',
              help="Select the LLVM build mode to use",
              type=click.UNPROCESSED)
@click.option("--simple", "test_simple", is_flag=True,
              help="Use TEST=simple instead of TEST=nightly")
@click.option("--test-style", type=click.Choice(['nightly', 'simple']),
              default='simple', help="Set the test style to run")
@click.option("--test-time-stat", type=click.Choice(['user', 'real']),
              default='user', show_default=True,
              help="Set the test timing statistic to gather")
@click.option("--disable-cxx", "test_cxx", flag_value=False, default=True,
              show_default=True, help="Disable C++ tests")
@click.option("--disable-externals", "test_externals", flag_value=False,
              default=True, show_default=True,
              help="Disable test suite externals (if configured)")
@click.option("--enable-integrated-as", "test_integrated_as", is_flag=True,
              help="Enable TEST_INTEGRATED_AS tests")
@click.option("--enable-jit", "test_jit", is_flag=True,
              help="Enable JIT tests")
@click.option("--disable-llc", "test_llc",
              help="Disable LLC tests",
              flag_value=False, show_default=True, default=True)
@click.option("--enable-llcbeta", "test_llcbeta",
              help="Enable LLCBETA tests", is_flag=True)
@click.option("--disable-lto", "test_lto",
              help="Disable use of link-time optimization",
              flag_value=False, show_default=True, default=True)
@click.option("--small", "test_small",
              help="Use smaller test inputs and disable large tests",
              is_flag=True)
@click.option("--large", "test_large",
              help="Use larger test inputs", is_flag=True)
@click.option("--spec-with-ref", "test_spec_ref",
              help="Use reference test inputs for SPEC.  "
              "This is currently experimental", is_flag=True)
@click.option("--benchmarking-only", "test_benchmarking_only",
              help="Benchmarking-only mode", is_flag=True)
@click.option("--only-test", "only_test", metavar="PATH",
              help="Only run tests under PATH",
              type=click.UNPROCESSED, default=None)
@click.option("--include-test-examples",
              help="Include test module examples",
              is_flag=True)
#  Test Execution
@click.option("-j", "--threads", "threads",
              help="Number of testing threads",
              type=int, default=1, metavar="N")
@click.option("--build-threads", "build_threads",
              help="Number of compilation threads",
              type=int, default=0, metavar="N")
@click.option("--use-perf", type=click.UNPROCESSED, default=None,
              help="Use perf to obtain high accuracy timing")
@click.option("--rerun", help="Rerun tests that have regressed.",
              is_flag=True)
@click.option("--remote", is_flag=True,
              help="Execute remotely, see "
                   "--remote-{host,port,user,client}")
@click.option("--remote-host", default="localhost", metavar="HOST",
              help="Set remote execution host", type=click.UNPROCESSED)
@click.option("--remote-port", type=int, default=None,
              metavar="PORT", help="Set remote execution port")
@click.option("--remote-user", help="Set remote execution user",
              type=click.UNPROCESSED, default=None, metavar="USER",)
@click.option("--remote-client", type=click.UNPROCESSED, default="ssh",
              help="Set remote execution client", metavar="RSH")
@click.option("--use-ios-simulator", "ios_simulator_sdk",
              help=("Execute using an iOS simulator SDK (using "
                    "environment overrides)"),
              type=click.UNPROCESSED, default=None, metavar="SDKPATH")
@click.option("--use-isolation", "use_isolation",
              help=("Execute using a sandboxing profile to limit "
                    "OS access (e.g., to the network or "
                    "non-test directories)"),
              is_flag=True)
@click.option("--qemu-user-mode", "qemu_user_mode",
              help=("Enable qemu user mode emulation using this "
                    "qemu executable"),
              type=click.UNPROCESSED, default=None)
@click.option("--qemu-flag", "qemu_flags",
              help="Additional flags to pass to qemu", multiple=True,
              type=click.UNPROCESSED, metavar="FLAG")
@click.option("--qemu-flags", "qemu_string",
              help="Additional flags to pass to qemu, space "
                   "separated string. These flags are appended after "
                   "*all* the individual --qemu-flag arguments.",
              type=click.UNPROCESSED, default='', metavar="FLAG")
@click.option("--multisample", "multisample",
              help="Accumulate test data from multiple runs",
              type=int, default=None, metavar="N")
#  Output Options
@click.option("--no-auto-name", "auto_name",
              help="Don't automatically derive submission name",
              flag_value=False, show_default=True, default=True)
@click.option("--no-machdep-info", "use_machdep_info",
              help=("Don't put machine (instance) dependent "
                    "variables with machine info"),
              flag_value=False, show_default=True, default=True)
@click.option("--run-order", "run_order", metavar="STR",
              help="String to use to identify and order this run",
              type=click.UNPROCESSED, default=None)
@click.option("--machine-param", "machine_parameters",
              metavar="NAME=VAL",
              help="Add 'NAME' = 'VAL' to the machine parameters",
              type=click.UNPROCESSED, multiple=True, default=[])
@click.option("--run-param", "run_parameters",
              metavar="NAME=VAL",
              help="Add 'NAME' = 'VAL' to the run parameters",
              type=click.UNPROCESSED, multiple=True, default=[])
@click.option("--submit", "submit_url", metavar="URLORPATH",
              help=("autosubmit the test result to the given server"
                    " (or local instance)"),
              type=click.UNPROCESSED, default=[], multiple=True)
@click.option("--output", "output", metavar="PATH",
              help="write raw report data to PATH (or stdout if '-')",
              default=None)
@click.option("-v", "--verbose", "verbose",
              help="show verbose test results", is_flag=True)
@click.option("--exclude-stat-from-submission",
              "exclude_stat_from_submission",
              help="Do not submit the stat of this type ",
              multiple=True, type=click.Choice(KNOWN_SAMPLE_KEYS),
              default=['hash'])
@submit_options
def cli_action(*args, **kwargs):
    _tools_check()
    nt = NTTest()

    for key, value in kwargs.items():
        setattr(nt.opts, key, value)

    results = nt.run_test(nt.opts)
    nt.show_results_url(results)

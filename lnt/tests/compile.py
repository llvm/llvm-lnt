import errno
import hashlib
import json
import os
import platform
import pprint
import re
import shlex
import shutil
import subprocess
import sys
import zipfile
import logging
from datetime import datetime

import lnt.testing
import lnt.testing.util.compilers
from lnt.testing.util.commands import note, error, fatal, resolve_command_path
from lnt.testing.util.misc import TeeStream, timestamp
from lnt.testing.util import commands, machineinfo
from lnt.util import stats

def args_to_quoted_string(args):
    def quote_arg(arg):
        if "'" in arg or '(' in arg or ')' in arg:
            return '"%s"' % arg
        elif '"' in arg or ' ' in arg:
            return "'%s'" % arg
        return arg
    return ' '.join([quote_arg(a)
                     for a in args])

# Interface to runN.
#
# FIXME: Simplify.
#
# FIXME: Figure out a better way to deal with need to run as root. Maybe farm
# memory sampling process out into something we can setuid? Eek.
def runN(args, N, cwd, preprocess_cmd=None, env=None, sample_mem=False,
         ignore_stderr=False, stdout=None, stderr=None):
    cmd = ['runN', '-a']
    if sample_mem:
        cmd = ['sudo'] + cmd + ['-m']
    if preprocess_cmd is not None:
        cmd.extend(('-p', preprocess_cmd))
    if stdout is not None:
        cmd.extend(('--stdout', stdout))
    if stderr is not None:
        cmd.extend(('--stderr', stderr))
    cmd.extend(('--min-sample-time', repr(opts.min_sample_time)))
    cmd.extend(('--max-num-samples', '100'))
    cmd.append(str(int(N)))
    cmd.extend(args)

    if opts.verbose:
        g_log.info("running: %s" % " ".join("'%s'" % arg
                                               for arg in cmd))
    p = subprocess.Popen(args=cmd,
                         stdin=None,
                         stdout=subprocess.PIPE,
                         stderr=subprocess.PIPE,
                         env=env,
                         cwd=cwd)
    stdout,stderr = p.communicate()
    res = p.wait()

    data = None
    try:
        data = eval(stdout)
    except:
        error("failed to parse output: %s\n" % stdout)

    if not ignore_stderr and stderr.strip():
        error("stderr isn't empty: %s\n" % stderr)
        data = None

    if res:
        error("res != 0: %s\n" % res)
        data = None

    return data

# Test functions.
def get_input_path(opts, *names):
    return os.path.join(opts.test_suite_externals, opts.test_subdir,
                        *names)

def get_output_path(*names):
    return os.path.join(g_output_dir, *names)

def get_runN_test_data(name, variables, cmd, ignore_stderr=False,
                       sample_mem=False, only_mem=False,
                       stdout=None, stderr=None, preprocess_cmd=None, env=None):
    if only_mem and not sample_mem:
        raise ArgumentError,"only_mem doesn't make sense without sample_mem"

    data = runN(cmd, variables.get('run_count'), cwd='/tmp',
                ignore_stderr=ignore_stderr, sample_mem=sample_mem,
                stdout=stdout, stderr=stderr, preprocess_cmd=preprocess_cmd,
                env=env)
    if data is not None:
        if data.get('version') != 0:
            raise ValueError,'unknown runN data format'
        data_samples = data.get('samples')
    keys = []
    if not only_mem:
        keys.extend([('user',1),('sys',2),('wall',3)])
    if sample_mem:
        keys.append(('mem',4))
    for key,idx in keys:
        tname = '%s.%s' % (name,key)
        success = False
        samples = []
        if data is not None:
            success = True
            samples = [sample[idx] for sample in data_samples]
        yield (success, tname, samples)

# FIXME: Encode dependency on output automatically, for simpler test execution.
def test_cc_command(base_name, run_info, variables, input, output, flags,
                    extra_flags, has_output=True, ignore_stderr=False):
    name = '%s/(%s)' % (base_name,' '.join(flags),)
    input = get_input_path(opts, input)
    output = get_output_path(output)

    cmd = [variables.get('cc')]
    cmd.extend(extra_flags)
    cmd.append(input)
    cmd.extend(flags)

    # Inhibit all warnings, we don't want to count the time to generate them
    # against newer compilers which have added (presumably good) warnings.
    cmd.append('-w')

    # Do a memory profiling run, if requested.
    #
    # FIXME: Doing this as a separate step seems silly. We shouldn't do any
    # extra run just to get the memory statistics.
    if opts.memory_profiling:
        # Find the cc1 command, which we use to do memory profiling. To do this
        # we execute the compiler with '-###' to figure out what it wants to do.
        cc_output = commands.capture(cmd + ['-o','/dev/null','-###'],
                                     include_stderr=True).strip()
        cc_commands = []
        for ln in cc_output.split('\n'):
            # Filter out known garbage.
            if (ln == 'Using built-in specs.' or
                ln.startswith('Configured with:') or
                ln.startswith('Target:') or
                ln.startswith('Thread model:') or
                ' version ' in ln):
                continue
            cc_commands.append(ln)

        if len(cc_commands) != 1:
            fatal('unable to determine cc1 command: %r' % cc_output)

        cc1_cmd = shlex.split(cc_commands[0])
        for res in get_runN_test_data(name, variables, cc1_cmd,
                                      ignore_stderr=ignore_stderr,
                                      sample_mem=True, only_mem=True):
            yield res

    commands.rm_f(output)
    for res in get_runN_test_data(name, variables, cmd + ['-o',output],
                                  ignore_stderr=ignore_stderr):
        yield res

    # If the command has output, track its size.
    if has_output:
        tname = '%s.size' % (name,)
        success = False
        samples = []
        try:
            stat = os.stat(output)
            success = True

            # For now, the way the software is set up things are going to get
            # confused if we don't report the same number of samples as reported
            # for other variables. So we just report the size N times.
            #
            # FIXME: We should resolve this, eventually.
            for i in range(variables.get('run_count')):
                samples.append(stat.st_size)
        except OSError,e:
            if e.errno != errno.ENOENT:
                raise
        yield (success, tname, samples)

def test_compile(name, run_info, variables, input, output, pch_input,
                 flags, stage, extra_flags=[]):
    extra_flags = list(extra_flags)

    cc_name = variables.get('cc_name')
    is_llvm = not (cc_name == 'gcc')
    is_clang = not (cc_name in ('gcc', 'llvm-gcc'))

    # Ignore irgen stages for non-LLVM compilers.
    if not is_llvm and stage in ('irgen', 'irgen_only'):
        return ()

    # Ignore 'init', 'irgen_only', and 'codegen' stages for non-Clang.
    if not is_clang and stage in ('init', 'irgen_only', 'codegen'):
        return ()

    # Force gnu99 mode for all compilers.
    if not is_clang:
        extra_flags.append('-std=gnu99')

    stage_flags,has_output = { 'pch-gen' : (('-x','objective-c-header'),True),
                               'driver' : (('-###','-fsyntax-only'), False),
                               'init' : (('-fsyntax-only',
                                          '-Xclang','-init-only'),
                                         False),
                               'syntax' : (('-fsyntax-only',), False),
                               'irgen_only' : (('-emit-llvm','-c',
                                                '-Xclang','-emit-llvm-only'),
                                               False),
                               'irgen' : (('-emit-llvm','-c'), True),
                               'codegen' : (('-c',
                                             '-Xclang', '-emit-codegen-only'),
                                            False),
                               'assembly' : (('-c',), True), }[stage]

    # Ignore stderr output (instead of failing) in 'driver' stage, -### output
    # goes to stderr by default.
    ignore_stderr = stage == 'driver'

    extra_flags.extend(stage_flags)
    if pch_input is not None:
        assert pch_input.endswith('.gch')
        extra_flags.extend(['-include', get_output_path(pch_input[:-4])])

    extra_flags.extend(['-I', os.path.dirname(get_input_path(opts, input))])

    return test_cc_command(name, run_info, variables, input, output, flags,
                           extra_flags, has_output, ignore_stderr)

def test_build(base_name, run_info, variables, project, build_config, num_jobs,
               codesize_util=None):
    name = '%s(config=%r,j=%d)' % (base_name, build_config, num_jobs)
        
    # Check if we need to expand the archive into the sandbox.
    archive_path = get_input_path(opts, project['archive'])
    with open(archive_path) as f:
        archive_hash = hashlib.md5(f.read() + str(project)).hexdigest()

    # Compute the path to unpack to.
    source_path = get_output_path("..", "Sources", project['name'])

    # Load the hash of the last unpack, in case the archive has been updated.
    last_unpack_hash_path = os.path.join(source_path, "last_unpack_hash.txt")
    if os.path.exists(last_unpack_hash_path):
        with open(last_unpack_hash_path) as f:
            last_unpack_hash = f.read()
    else:
        last_unpack_hash = None

    # Unpack if necessary.
    if last_unpack_hash == archive_hash:
        g_log.info('reusing sources %r (already unpacked)' % name)
    else:
        # Remove any existing content, if necessary.
        try:
            shutil.rmtree(source_path)
        except OSError, e:
            if e.errno != errno.ENOENT:
                raise

        # Extract the zip file.
        #
        # We shell out to unzip here because zipfile's extractall does not
        # appear to preserve permissions properly.
        commands.mkdir_p(source_path)
        g_log.info('extracting sources for %r' % name)
        
        if archive_path[-6:] == "tar.gz":
            p = subprocess.Popen(args=['tar', '-xzf', archive_path],
                                 stdin=None,
                                 stdout=subprocess.PIPE,
                                 stderr=subprocess.PIPE,
                                 cwd=source_path)
        else:
            p = subprocess.Popen(args=['unzip', '-q', archive_path],
                                 stdin=None,
                                 stdout=subprocess.PIPE,
                                 stderr=subprocess.PIPE,
                                 cwd=source_path)            
        stdout,stderr = p.communicate()
        if p.wait() != 0:
            fatal(("unable to extract archive %r at %r\n"
                   "-- stdout --\n%s\n"
                   "-- stderr --\n%s\n") % (archive_path, source_path,
                                            stdout, stderr))
        if p.wait() != 0:
            fatal

        # Apply the patch file, if necessary.
        patch_files = project.get('patch_files', [])
        for patch_file in patch_files:
            g_log.info('applying patch file %r for %r' % (patch_file, name))
            patch_file_path = get_input_path(opts, patch_file)
            p = subprocess.Popen(args=['patch', '-i', patch_file_path,
                                       '-p', '1'],
                                 stdin=None,
                                 stdout=subprocess.PIPE,
                                 stderr=subprocess.PIPE,
                                 cwd=source_path)
            stdout,stderr = p.communicate()
            if p.wait() != 0:
                fatal(("unable to apply patch file %r in %r\n"
                       "-- stdout --\n%s\n"
                       "-- stderr --\n%s\n") % (patch_file_path, source_path,
                                                stdout, stderr))

        # Write the hash tag.
        with open(last_unpack_hash_path, "w") as f:
            f.write(archive_hash)

    # Create an env dict in case the user wants to use it.
    env = dict(os.environ)
    
    # Form the test build command.
    build_info = project['build_info']
    
    # Add arguments to ensure output files go into our build directory.
    dir_name = '%s_%s_j%d' % (base_name, build_config, num_jobs)    
    output_base = get_output_path(dir_name)
    build_base = os.path.join(output_base, 'build', build_config)
        
    # Create the build base directory and by extension output base directory.
    commands.mkdir_p(build_base)

    cmd = []
    preprocess_cmd = None
    
    if build_info['style'].startswith('xcode-'):
        file_path = os.path.join(source_path, build_info['file'])
        cmd.extend(['xcodebuild'])

        # Add the arguments to select the build target.
        if build_info['style'] == 'xcode-project':
            cmd.extend(('-target', build_info['target'],
                        '-project', file_path))
        elif build_info['style'] == 'xcode-workspace':
            cmd.extend(('-scheme', build_info['scheme'],
                        '-workspace', file_path))
        else:
            fatal("unknown build style in project: %r" % project)

        # Add the build configuration selection.
        cmd.extend(('-configuration', build_config))

        cmd.append('OBJROOT=%s' % (os.path.join(build_base, 'obj')))
        cmd.append('SYMROOT=%s' % (os.path.join(build_base, 'sym')))
        cmd.append('DSTROOT=%s' % (os.path.join(build_base, 'dst')))
        cmd.append('SHARED_PRECOMPS_DIR=%s' % (os.path.join(build_base, 'pch')))

        # Add arguments to force the appropriate compiler.
        cmd.append('CC=%s' % (opts.cc,))
        cmd.append('CPLUSPLUS=%s' % (opts.cxx,))

        # We need to force this variable here because Xcode has some completely
        # broken logic for deriving this variable from the compiler
        # name. <rdar://problem/7989147>        
        cmd.append('LD=%s' % (opts.ld,))
        cmd.append('LDPLUSPLUS=%s' % (opts.ldxx,))

        # Force off the static analyzer, in case it was enabled in any projects
        # (we don't want to obscure what we are trying to time).
        cmd.append('RUN_CLANG_STATIC_ANALYZER=NO')

        # Inhibit all warnings, we don't want to count the time to generate them
        # against newer compilers which have added (presumably good) warnings.
        cmd.append('GCC_WARN_INHIBIT_ALL_WARNINGS=YES')

        # Add additional arguments to force the build scenario we want.
        cmd.extend(('-jobs', str(num_jobs)))

        # If the user specifies any additional options to be included on the command line,
        # append them here.
        cmd.extend(build_info.get('extra_args', []))
        
        # If the user specifies any extra environment variables, put
        # them in our env dictionary.
        env_format = {
            'build_base' : build_base
        }
        extra_env = build_info.get('extra_env', {})        
        for k in extra_env:
            extra_env[k] = extra_env[k] % env_format
        env.update(extra_env)

        # Create preprocess cmd
        preprocess_cmd = 'rm -rf "%s"' % (build_base,)
        
    elif build_info['style'] == 'make':        
        # Get the subdirectory in Source where our sources exist.
        src_dir = os.path.dirname(os.path.join(source_path, build_info['file']))
        # Grab our config from build_info. This is config is currently only used in
        # the make build style since Xcode, the only other build style as of today,
        # handles changing configuration through the configuration type variables.
        # Make does not do this so we have to use more brute force to get it right.
        config = build_info.get('config', {}).get(build_config, {})
        
        # Copy our source directory over to build_base.
        # We do this since we assume that we are processing a make project which
        # has already been configured and so that we do not need to worry about
        # make install or anything like that. We can just build the project and
        # use the user supplied path to its location in the build directory.        
        copied_src_dir = os.path.join(build_base, os.path.basename(dir_name))
        shutil.copytree(src_dir, copied_src_dir)
        
        # Create our make command.
        cmd.extend(['make', '-C', copied_src_dir, build_info['target'], "-j",
                    str(num_jobs)])
        
        # If the user specifies any additional options to be included on the command line,
        # append them here.
        cmd.extend(config.get('extra_args', []))
        
        # If the user specifies any extra environment variables, put
        # them in our env dictionary.
        
        # We create a dictionary for build_base so that users can use
        # it optionally in an environment variable via the python
        # format %(build_base)s.
        env_format = {
            'build_base' : build_base
        }
        
        extra_env = config.get('extra_env', {})
        for k in extra_env:
            extra_env[k] = extra_env[k] % env_format
        env.update(extra_env)

        # Set build base to copied_src_dir so that if codesize_util
        # is not None, we pass it the correct path.
        build_base = copied_src_dir
    else:
        fatal("unknown build style in project: %r" % project)
    
    # Collect the samples.
    g_log.info('executing full build: %s' % args_to_quoted_string(cmd))
    stdout_path = os.path.join(output_base, "stdout.log")
    stderr_path = os.path.join(output_base, "stderr.log")

    for res in get_runN_test_data(name, variables, cmd,
                                  stdout=stdout_path, stderr=stderr_path,
                                  preprocess_cmd=preprocess_cmd, env=env):
        yield res

    # If we have a binary path, get the text size of our result.
    binary_path = build_info.get('binary_path', None)
    if binary_path is not None and codesize_util is not None:
        tname = "%s.size" % (name,)
        success = False
        samples = []
        
        try:
            # We use a dictionary here for our formatted processing of binary_path so
            # that if the user needs our build config he can get it via %(build_config)s
            # in his string and if he does not, an error is not thrown.
            format_args = {"build_config":build_config}
            cmd = codesize_util + [os.path.join(build_base,
                                                binary_path % format_args)]
            result = subprocess.check_output(cmd).strip()
            if result != "fail":
                bytes = long(result)
                success = True
                
                # For now, the way the software is set up things are going to get
                # confused if we don't report the same number of samples as reported
                # for other variables. So we just report the size N times.
                #
                # FIXME: We should resolve this, eventually.
                for i in range(variables.get('run_count')):
                    samples.append(bytes)
        except OSError as e:
            if e.errno != errno.ENOENT:
                raise
        yield (success, tname, samples)
    
    # Check that the file sizes of the output log files "make sense", and warn
    # if they do not. That might indicate some kind of non-determinism in the
    # test command, which makes timing less useful.
    stdout_sizes = []
    stderr_sizes = []
    run_count = variables['run_count']
    for i in range(run_count):
        iter_stdout_path = '%s.%d' % (stdout_path, i)
        iter_stderr_path = '%s.%d' % (stderr_path, i)
        if os.path.exists(iter_stdout_path):
            stdout_sizes.append(os.stat(iter_stdout_path).st_size)
        else:
            stdout_sizes.append(None)
        if os.path.exists(iter_stderr_path):
            stderr_sizes.append(os.stat(iter_stderr_path).st_size)
        else:
            stderr_sizes.append(None)

    if len(set(stdout_sizes)) != 1:
        g_log.warning(('test command had stdout files with '
                          'different sizes: %r') % stdout_sizes)
    if len(set(stderr_sizes)) != 1:
        g_log.warning(('test command had stderr files with '
                          'different sizes: %r') % stderr_sizes)

    # Unless cleanup is disabled, rerun the preprocessing command.
    if not opts.save_temps and preprocess_cmd:
        g_log.info('cleaning up temporary results')
        if os.system(preprocess_cmd) != 0:
            g_log.warning("cleanup command returned a non-zero exit status")

###

def curry(fn, **kw_args):
    return lambda *args: fn(*args, **kw_args)

def get_single_file_tests(flags_to_test, test_suite_externals,
                          subdir):
    # Load the project description file from the externals.
    path = os.path.join(test_suite_externals, subdir,
                        "project_list.json")
    with open(path) as f:
        config = json.load(f).get("single-file", {})

        if len(config) == 0:
            g_log.warning("config file %s has no data." % path)
        
        all_pch = config.get("pch", [])
        all_inputs = config.get("tests", [])        
    
    stages_to_test = ['driver', 'init', 'syntax', 'irgen_only', 'irgen',
                      'codegen', 'assembly']
    base_path = os.path.join(test_suite_externals, subdir, 'single-file')
    
    if not os.access(base_path, os.F_OK | os.R_OK):
        g_log.warning('single-file directory does not exist. Dir: %s' \
                         % base_path)
    else:
        # I did not want to handle the control flow in this manner, but due to
        # the nature of python generators I can not just return in the previous
        # warning case.
        for f in flags_to_test:
            # FIXME: Note that the order matters here, because we need to make sure
            # to generate the right PCH file before we try to use it. Ideally the
            # testing infrastructure would just handle this.
            for pch in all_pch:
                path, name, output = pch['path'], pch['name'], pch['output']
                
                yield (os.path.join('pch-gen', name),
                       curry(test_compile,
                             input=os.path.join(base_path, path),
                             output=output, pch_input=None,
                             flags=f, stage='pch-gen'))
                
            for input in all_inputs:
                path, pch_input = input['path'], input.get('pch_input', None)
                extra_flags = input['extra_flags']
                
                name = path
                output = os.path.splitext(os.path.basename(path))[0] + '.o'
                for stage in stages_to_test:
                    yield ('compile/%s/%s' % (name, stage),
                           curry(test_compile,
                                 input=os.path.join(base_path, path),
                                 output=output, pch_input=pch_input, flags=f,
                                 stage=stage, extra_flags=extra_flags))

def get_full_build_tests(jobs_to_test, configs_to_test,
                         test_suite_externals, test_suite_externals_subdir):
    # Load the project description file from the externals.
    path = os.path.join(test_suite_externals, test_suite_externals_subdir,
                           "project_list.json")

    g_log.info("Loading config file: %s" % path)
    with open(path) as f:
        data = json.load(f)

    codesize_util = data.get('codesize_util', None)
    
    for jobs in jobs_to_test:
        for project in data['projects']:
            for config in configs_to_test:
                # Check the style.
                yield ('build/%s' % (project['name'],),
                       curry(test_build, project=project, build_config=config,
                             num_jobs=jobs, codesize_util=codesize_util))

def get_tests(test_suite_externals, test_suite_externals_subdir, flags_to_test,
              jobs_to_test, configs_to_test):
    for item in get_single_file_tests(flags_to_test, test_suite_externals,
                                      test_suite_externals_subdir):
        yield item

    for item in get_full_build_tests(jobs_to_test, configs_to_test,
                                     test_suite_externals,
                                     test_suite_externals_subdir):
        yield item

###

import builtintest
from optparse import OptionParser, OptionGroup

g_output_dir = None
g_log = None
usage_info = """
Script for testing compile time performance.

This tests:
 - PCH Generation for Cocoa.h
   o File Size
   o Memory Usage
   o Time
 - Objective-C Compile Time, with PCH
   o File Sizes
   o Memory Usage
   o Time
 - C Compile Time, without PCH
   o File Sizes
   o Memory Usage
   o Time
 - Full Build Times
   o Total Build Time (using xcodebuild)

TODO:
 - Objective-C Compile Time, with PCH
   o PCH Utilization

FIXME: One major hole here is that we aren't testing one situation which does
sometimes show up with PCH, where we have a PCH file + a second significant body
of code (e.g., a large user framework, or a poorly PCHified project). In
practice, this can be a significant hole because PCH has a substantial impact on
how lookup, for example, is done.

We run each of the tests above in a number of dimensions:
 - O0
 - O0 -g
 - Os

We run each of the compile time tests in various stages:
 - ### (driver time)
 - init (driver + compiler init)
 - fsyntax-only (lex/parse/sema time)
 - emit-llvm-only (IRgen time)
 - emit-llvm (.bc output time and size, mostly to track output file size)
 - emit-codegen-only (codegen time, without assembler)
 - c (assembly time and size)
"""

class CompileTest(builtintest.BuiltinTest):
    def describe(self):
        return 'Single file compile-time performance testing'

    def run_test(self, name, args):
        global opts
        parser = OptionParser(
            ("%(name)s [options] [<output file>]\n" +
             usage_info) % locals())
        parser.add_option("-s", "--sandbox", dest="sandbox_path",
                          help="Parent directory to build and run tests in",
                          type=str, default=None, metavar="PATH")

        group = OptionGroup(parser, "Test Options")
        group.add_option("", "--no-timestamp", dest="timestamp_build",
                         help="Don't timestamp build directory (for testing)",
                         action="store_false", default=True)
        group.add_option("", "--cc", dest="cc", type='str',
                         help="Path to the compiler under test",
                         action="store", default=None)
        group.add_option("", "--cxx", dest="cxx",
                         help="Path to the C++ compiler to test",
                         type=str, default=None)
        group.add_option("", "--ld", dest="ld",
                         help="Path to the c linker to use. (Xcode Distinction)",
                         type=str, default=None)
        group.add_option("", "--ldxx", dest="ldxx",
                         help="Path to the cxx linker to use. (Xcode Distinction)",
                         type=str, default=None)
        group.add_option("", "--test-externals", dest="test_suite_externals",
                         help="Path to the LLVM test-suite externals",
                         type=str, default=None, metavar="PATH")
        group.add_option("", "--machine-param", dest="machine_parameters",
                         metavar="NAME=VAL",
                         help="Add 'NAME' = 'VAL' to the machine parameters",
                         type=str, action="append", default=[])
        group.add_option("", "--run-param", dest="run_parameters",
                         metavar="NAME=VAL",
                         help="Add 'NAME' = 'VAL' to the run parameters",
                         type=str, action="append", default=[])
        group.add_option("", "--run-order", dest="run_order", metavar="STR",
                         help="String to use to identify and order this run",
                         action="store", type=str, default=None)
        group.add_option("", "--test-subdir", dest="test_subdir",
                         help="Subdirectory of test external dir to look for tests in.",
                         type=str, default="lnt-compile-suite-src")
        parser.add_option_group(group)

        group = OptionGroup(parser, "Test Selection")
        group.add_option("", "--no-memory-profiling", dest="memory_profiling",
                         help="Disable memory profiling",
                         action="store_false", default=True)
        group.add_option("", "--multisample", dest="run_count", metavar="N",
                         help="Accumulate test data from multiple runs",
                         action="store", type=int, default=3)
        group.add_option("", "--min-sample-time", dest="min_sample_time",
                         help="Ensure all tests run for at least N seconds",
                         metavar="N", action="store", type=float, default=.5)
        group.add_option("", "--save-temps", dest="save_temps",
                         help="Save temporary build output files",
                         action="store_true", default=False)
        group.add_option("", "--show-tests", dest="show_tests",
                         help="Only list the availables tests that will be run",
                         action="store_true", default=False)
        group.add_option("", "--test", dest="tests", metavar="NAME",
                         help="Individual test to run",
                         action="append", default=[])
        group.add_option("", "--test-filter", dest="test_filters",
                         help="Run tests matching the given pattern",
                         metavar="REGEXP", action="append", default=[])
        group.add_option("", "--flags-to-test", dest="flags_to_test",
                         help="Add a set of flags to test (space separated)",
                         metavar="FLAGLIST", action="append", default=[])
        group.add_option("", "--jobs-to-test", dest="jobs_to_test",
                         help="Add a job count to test (full builds)",
                         metavar="NUM", action="append", default=[], type=int)
        group.add_option("", "--config-to-test", dest="configs_to_test",
                         help="Add build configuration to test (full builds)",
                         metavar="NAME", action="append", default=[],
                         choices=('Debug','Release'))
        parser.add_option_group(group)

        group = OptionGroup(parser, "Output Options")
        group.add_option("", "--no-machdep-info", dest="use_machdep_info",
                         help=("Don't put machine (instance) dependent "
                               "variables in machine info"),
                         action="store_false", default=True)
        group.add_option("", "--machine-name", dest="machine_name", type='str',
                         help="Machine name to use in submission [%default]",
                         action="store", default=platform.uname()[1])
        group.add_option("", "--submit", dest="submit_url", metavar="URLORPATH",
                          help=("autosubmit the test result to the given server "
                                "(or local instance) [%default]"),
                          type=str, default=None)
        group.add_option("", "--commit", dest="commit",
                          help=("whether the autosubmit result should be committed "
                                "[%default]"),
                          type=int, default=True)
        group.add_option("", "--output", dest="output", metavar="PATH",
                          help="write raw report data to PATH (or stdout if '-')",
                          action="store", default=None)
        group.add_option("-v", "--verbose", dest="verbose",
                          help="show verbose test results",
                          action="store_true", default=False)

        parser.add_option_group(group)

        opts,args = parser.parse_args(args)

        if len(args) != 0:
            parser.error("invalid number of arguments")

        # Resolve the cc_under_test path.
        opts.cc = resolve_command_path(opts.cc)

        if not lnt.testing.util.compilers.is_valid(opts.cc):
            parser.error('--cc does not point to a valid executable.')


        # Attempt to infer the cxx compiler if not given.
        if opts.cc and opts.cxx is None:
            opts.cxx = lnt.testing.util.compilers.infer_cxx_compiler(opts.cc)
            if opts.cxx is not None:
                note("inferred C++ compiler under test as: %r" % (opts.cxx,))

        # Validate options.
        if opts.cc is None:
            parser.error('--cc is required')
        if opts.cxx is None:
            parser.error('--cxx is required (and could not be inferred)')
        if opts.sandbox_path is None:
            parser.error('--sandbox is required')
        if opts.test_suite_externals is None:
            parser.error("--test-externals option is required")

        # Force the CC and CXX variables to be absolute paths.
        cc_abs = os.path.abspath(commands.which(opts.cc))
        cxx_abs = os.path.abspath(commands.which(opts.cxx))
        
        if not os.path.exists(cc_abs):
            parser.error("unable to determine absolute path for --cc: %r" % (
                    opts.cc,))
        if not os.path.exists(cxx_abs):
            parser.error("unable to determine absolute path for --cc: %r" % (
                    opts.cc,))
        opts.cc = cc_abs
        opts.cxx = cxx_abs

        # If no ld was set, set ld to opts.cc
        if opts.ld is None:
            opts.ld = opts.cc
        # If no ldxx was set, set ldxx to opts.cxx
        if opts.ldxx is None:
            opts.ldxx = opts.cxx
        
        # Set up the sandbox.
        global g_output_dir
        if not os.path.exists(opts.sandbox_path):
            print >>sys.stderr, "%s: creating sandbox: %r" % (
                timestamp(), opts.sandbox_path)
            os.mkdir(opts.sandbox_path)
        if opts.timestamp_build:
            report_name = "test-%s" % (timestamp().replace(' ','_').replace(':','-'))
        else:
            report_name = "build"
        g_output_dir = os.path.join(os.path.abspath(opts.sandbox_path),report_name)
            
        try:
            os.mkdir(g_output_dir)
        except OSError,e:
            if e.errno == errno.EEXIST:
                parser.error("sandbox output directory %r already exists!" % (
                        g_output_dir,))
            else:
                raise

        # Setup log file
        global g_log
        def setup_log(output_dir):
            def stderr_log_handler():
                h = logging.StreamHandler()
                f = logging.Formatter("%(asctime)-7s: %(levelname)s: %(message)s",
                                      "%Y-%m-%d %H:%M:%S")
                h.setFormatter(f)
                return h
            def file_log_handler(path):
                h = logging.FileHandler(path, mode='w')
                f = logging.Formatter("%(asctime)-7s: %(levelname)s: %(message)s",
                                      "%Y-%m-%d %H:%M:%S")
                h.setFormatter(f)
                return h
            l = logging.Logger('compile_test')
            l.setLevel(logging.INFO)
            l.addHandler(file_log_handler(os.path.join(output_dir, 'test.log')))
            l.addHandler(stderr_log_handler())
            return l
        g_log = setup_log(g_output_dir)
        
        # Collect machine and run information.
        machine_info, run_info = machineinfo.get_machine_information(
            opts.use_machdep_info)

        # FIXME: Include information on test source versions.
        #
        # FIXME: Get more machine information? Cocoa.h hash, for example.

        for name,cmd in (('sys_cc_version', ('/usr/bin/gcc','-v')),
                         ('sys_as_version', ('/usr/bin/as','-v','/dev/null')),
                         ('sys_ld_version', ('/usr/bin/ld','-v')),
                         ('sys_xcodebuild', ('xcodebuild','-version'))):
            run_info[name] = commands.capture(cmd, include_stderr=True).strip()

        # Set command line machine and run information.
        for info,params in ((machine_info, opts.machine_parameters),
                            (run_info, opts.run_parameters)):
            for entry in params:
                if '=' not in entry:
                    name,value = entry,''
                else:
                    name,value = entry.split('=', 1)
                info[name] = value

        # Set user variables.
        variables = {}
        variables['cc'] = opts.cc
        variables['run_count'] = opts.run_count

        # Get compiler info.
        cc_info = lnt.testing.util.compilers.get_cc_info(variables['cc'])
        variables.update(cc_info)

        # Set the run order from the user, if given.
        if opts.run_order is not None:
            variables['run_order'] = opts.run_order
        else:
            # Otherwise, use the inferred run order.
            variables['run_order'] = cc_info['inferred_run_order']
            note("inferred run order to be: %r" % (variables['run_order'],))

        if opts.verbose:
            format = pprint.pformat(variables)
            msg = '\n\t'.join(['using variables:'] + format.splitlines())
            note(msg)

            format = pprint.pformat(machine_info)
            msg = '\n\t'.join(['using machine info:'] + format.splitlines())
            note(msg)

            format = pprint.pformat(run_info)
            msg = '\n\t'.join(['using run info:'] + format.splitlines())
            note(msg)

        # Compute the set of flags to test.
        if not opts.flags_to_test:
            flags_to_test = [('-O0',), ('-O0','-g',), ('-Os','-g'), ('-O3',)]
        else:
            flags_to_test = [string.split(' ')
                             for string in opts.flags_to_test]

        # Compute the set of job counts to use in full build tests.
        if not opts.jobs_to_test:
            jobs_to_test = [1, 2, 4, 8]
        else:
            jobs_to_test = opts.jobs_to_test

        # Compute the build configurations to test.
        if not opts.configs_to_test:
            configs_to_test = ['Debug', 'Release']
        else:
            configs_to_test = opts.configs_to_test

        # Compute the list of all tests.
        all_tests = list(get_tests(opts.test_suite_externals, opts.test_subdir,
                                   flags_to_test, jobs_to_test,
                                   configs_to_test))

        # Show the tests, if requested.
        if opts.show_tests:
            print >>sys.stderr, 'Available Tests'
            for name in sorted(set(name for name,_ in all_tests)):
                print >>sys.stderr, '  %s' % (name,)
            print
            raise SystemExit

        # Find the tests to run.
        if not opts.tests and not opts.test_filters:
            tests_to_run = list(all_tests)
        else:
            all_test_names = set(test[0] for test in all_tests)

            # Validate the test names.
            requested_tests = set(opts.tests)
            missing_tests = requested_tests - all_test_names
            if missing_tests:
                    parser.error(("invalid test names %s, use --show-tests to "
                                  "see available tests") % (
                            ", ".join(map(repr, missing_tests)),))

            # Validate the test filters.
            test_filters = [re.compile(pattern)
                            for pattern in opts.test_filters]

            # Form the list of tests.
            tests_to_run = [test
                            for test in all_tests
                            if (test[0] in requested_tests or
                                [True
                                 for filter in test_filters
                                 if filter.search(test[0])])]
        if not tests_to_run:
            parser.error(
                "no tests requested (invalid --test or --test-filter options)!")

        # Ensure output directory is available.
        if not os.path.exists(g_output_dir):
            os.mkdir(g_output_dir)
        
        # Execute the run.
        run_info.update(variables)
        run_info['tag'] = tag = 'compile'

        testsamples = []
        start_time = datetime.utcnow()
        g_log.info('run started')
        g_log.info('using CC: %r' % opts.cc)
        g_log.info('using CXX: %r' % opts.cxx)
        try:
            for basename,test_fn in tests_to_run:
                for success,name,samples in test_fn(basename, run_info,
                                                         variables):
                    g_log.info('collected samples: %r' % name)
                    num_samples = len(samples)
                    if num_samples:
                        samples_median = '%.4f' % (stats.median(samples),)
                        samples_mad = '%.4f' % (
                            stats.median_absolute_deviation(samples),)
                    else:
                        samples_median = samples_mad = 'N/A'
                    g_log.info('N=%d, median=%s, MAD=%s' % (
                        num_samples, samples_median, samples_mad))
                    test_name = '%s.%s' % (tag, name)
                    if not success:
                        testsamples.append(lnt.testing.TestSamples(
                                test_name + '.status', [lnt.testing.FAIL]))
                    if samples:
                        testsamples.append(lnt.testing.TestSamples(
                                test_name, samples))
        except KeyboardInterrupt:
            raise SystemExit("\ninterrupted\n")
        except:
            import traceback
            g_log.error('*** EXCEPTION DURING TEST, HALTING ***')
            g_log.error('--')
            g_log.error(traceback.format_exc())
            g_log.error('--')
            run_info['had_errors'] = 1

        end_time = datetime.utcnow()

        g_log.info('run complete')
        
        # Package up the report.
        machine = lnt.testing.Machine(opts.machine_name, machine_info)
        run = lnt.testing.Run(start_time, end_time, info = run_info)

        # Write out the report.
        lnt_report_path = os.path.join(g_output_dir, 'report.json')
        report = lnt.testing.Report(machine, run, testsamples)

        # Save report to disk for submission.
        self.print_report(report, lnt_report_path)

        # Then, also print to screen if requested.
        if opts.output is not None:
            self.print_report(report, opts.output)

        self.submit(lnt_report_path, opts)

        return report

def create_instance():
    return CompileTest()

__all__ = ['create_instance']

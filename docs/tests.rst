.. _tests:

Test Producers
==============

On the client-side, LNT comes with a number of built-in test data producers.
This section focuses on the LLVM test-suite (aka nightly test) generator, since
it is the primary test run using the LNT infrastructure, but note that LNT also
includes tests for other interesting pieces of data, for example Clang
compile-time performance.

LNT also makes it easy to add new test data producers and includes examples of
custom data importers (e.g., to import buildbot build information into) and
dynamic test data generators (e.g., abusing the infrastructure to plot graphs,
for example).

Running a Local Server
----------------------

It is useful to set up a local LNT server to view the results of tests, either
for personal use or to preview results before submitting them to a public
server. To set up a one-off server for testing::

  # Create a new installation in /tmp/FOO.
  $ lnt create /tmp/FOO
  created LNT configuration in '/tmp/FOO'
  ...

  # Run a local LNT server.
  $ lnt runserver /tmp/FOO &> /tmp/FOO/runserver.log &
  [2] 69694

  # Watch the server log.
  $ tail -f /tmp/FOO/runserver.log
  * Running on http://localhost:8000/
  ...

Running Tests
-------------

The built-in tests are designed to be run via the ``lnt`` tool. The
following tools for working with built-in tests are available:

  ``lnt showtests``
    List the available tests.  Tests are defined with an extensible
    architecture. FIXME: Point at docs on how to add a new test.

  ``lnt runtest [<run options>] <test name> ... test arguments ...``
    Run the named test. The run tool itself accepts a number of options which
    are common to all tests. The most common option is ``--submit=<url>`` which
    specifies the server to submit the results to after testing is complete. See
    ``lnt runtest --help`` for more information on the available options.

    The remainder of the options are passed to the test tool itself. The options
    are specific to the test, but well behaved tests should respond to ``lnt
    runtest <test name> --help``. The following section provides specific
    documentation on the built-in tests.

Built-in Tests
--------------

LLVM Makefile test-suite (aka LLVM Nightly Test)
~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

The ``nt`` built-in test runs the LLVM test-suite execution and performance
tests, in the "nightly test" configuration. This test allows running many
different applications and benchmarks (e.g., SPEC), with various compile
options, and in several different configurations (for example, using an LLVM
compiler like ``clang`` or ``llvm-gcc``, running under the LLVM JIT compiler
using the LLVM ``lli`` bit-code interpreter, or testing new code generator
passes).

The ``nt`` test requires that the LLVM test-suite repository, a working LLVM
compiler, and a LLVM source and build tree are available. Currently, the LLVM
build tree is expected to have been built-in the Release+Asserts configuration.
Unlike the prior ``NewNightlyTest.pl``, the ``nt`` tool does not checkout or build
any thing, it is expected that users manage their own LLVM source and build
trees. Ideally, each of the components should be based on the same LLVM revision
(except perhaps the LLVM test-suite), but this is not required.

The test runs the LLVM test-suite builds and execution inside a user specificed
sandbox directory. By default, each test run will be done in a timestamped
directory inside the sandbox, and the results left around for post-mortem
analysis. Currently, the user is responsible for cleaning up these directories
to manage disk space.

The tests are always expected to be run using out-of-tree builds -- this is a
more robust model and allow sharing the same source trees across many test
runs. One current limitation is that the LLVM test-suite repository will not
function correctly if an in-tree build is done, followed by an out-of-tree
build. It is very important that the LLVM test-suite repository be left
pristine.

The following command shows an example of running the ``nt`` test suite on a
local build::

  $ rm -rf /tmp/BAR
  $ lnt runtest nt \
       --sandbox /tmp/BAR \
       --cc ~/llvm.obj.64/Release+Asserts/bin/clang \
       --cxx ~/llvm.obj.64/Release+Asserts/bin/clang++ \
       --llvm-src ~/llvm \
       --llvm-obj ~/llvm.obj.64 \
       --test-suite ~/llvm-test-suite \
       TESTER_NAME \
        -j 16
  2010-04-17 23:46:40: using nickname: 'TESTER_NAME__clang_DEV__i386'
  2010-04-17 23:46:40: creating sandbox: '/tmp/BAR'
  2010-04-17 23:46:40: starting test in '/private/tmp/BAR/test-2010-04-17_23-46-40'
  2010-04-17 23:46:40: configuring...
  2010-04-17 23:46:50: testing...
  2010-04-17 23:51:04: loading test data...
  2010-04-17 23:51:05: generating report: '/private/tmp/BAR/test-2010-04-17_23-46-40/report.json'

The first seven arguments are all required -- they specify the sandbox path, the
compilers to test, and the paths to the required sources and builds. The
``TESTER_NAME`` argument is used to derive the name for this tester (in
conjunction which some inferred information about the compiler under test). This
name is used as a short identifier for the test machine; generally it should be
the hostname of the machine or the name of the person who is responsible for the
tester. The ``-j 16`` argument is optional, in this case it specifies that tests
should be run in parallel using up to 16 processes.

In this case, we can see from the output that the test created a new sandbox
directory, then ran the test in a subdirectory in that sandbox. The test outputs
a limited about of summary information as testing is in progress. The full
information can be found in .log files within the test build directory (e.g.,
``configure.log`` and ``test.log``).

The final test step was to generate a test report inside the test
directory. This report can now be submitted directly to an LNT server. For
example, if we have a local server running as described earlier, we can run::

  $ lnt submit --commit=1 http://localhost:8000/submitRun \
      /tmp/BAR/test-2010-04-17_23-46-40/report.json
  STATUS: 0

  OUTPUT:
  IMPORT: /tmp/FOO/lnt_tmp/data-2010-04-17_16-54-35ytpQm_.plist
    LOAD TIME: 0.34s
    IMPORT TIME: 5.23s
  ADDED: 1 machines
  ADDED: 1 runs
  ADDED: 1990 tests
  COMMITTING RESULT: DONE
  TOTAL IMPORT TIME: 5.57s

and view the results on our local server.

LNT-based NT test modules
+++++++++++++++++++++++++

In order to support more complicated tests, or tests which are not easily
integrated into the more strict SingleSource or MultiSource layout of the LLVM
test-suite module, the ``nt`` built-in test provides a mechanism for LLVM
test-suite tests that just define an extension test module. These tests are
passed the user configuration parameters for a test run and expected to return
back the test results in the LNT native format.

Test modules are defined by providing a ``TestModule`` file in a subdirectory of
the ``LNTBased`` root directory inside the LLVM test-suite repository. The
``TestModule`` file is expected to be a well-formed Python module that provides
a ``test_class`` global variable which should be a subclass of the
``lnt.tests.nt.TestModule`` abstract base class.

The test class should override the ``execute_test`` method which is passed an
options dictionary containg the NT user parameters which apply to test
execution, and the test should return the test results as a list of
``lnt.testing.TestSamples`` objects.

The ``execute_test`` method is passed the following options describing
information about the module itself:

  * ``MODULENAME`` - The name of the module (primarily intended for use in
    producing well structured test names).

  * ``SRCROOT`` - The path to the modules source directory.

  * ``OBJROOT`` - The path to a directory the module should use for temporary
    output (build products). The directory is guaranteed to exist but is not
    guaranteed to be clean.

The method is passed the following options which apply to how tests should be
executed:

  * ``THREADS`` - The number of parallel processes to run during testing.

  * ``BUILD_THREADS`` - The number of parallel processes to use while building
    tests (if applicable).

The method is passed the following options which specify how and whether tests
should be executed remotely. If any of these parameters are present then all are
guaranteed to be present.

 * ``REMOTE_HOST`` - The host name of the remote machine to execute tests on.

 * ``REMOTE_USER`` - The user to log in to the remote machine as.

 * ``REMOTE_PORT`` - The port to connect to the remote machine on.

 * ``REMOTE_CLIENT`` - The ``rsh`` compatible client to use to connect to the
   remote machine with.

The method is passed the following options which specify how to build the tests:

 * ``CC`` - The C compiler command to use.

 * ``CXX`` - The C++ compiler command to use.

 * ``CFLAGS`` - The compiler flags to use for building C code.

 * ``CXXFLAGS`` - The compiler flags to use for building C++ code.

The method is passed the following optional parameters which specify the
environment to use for various commands:

 * ``COMPILE_ENVIRONMENT_OVERRIDES`` [optional] - If given, a ``env`` style list
   of environment overrides to use when compiling.

 * ``LINK_ENVIRONMENT_OVERRIDES`` [optional] - If given, a ``env`` style list of
   environment overrides to use when linking.

 * ``EXECUTION_ENVIRONMENT_OVERRIDES`` [optional] - If given, a ``env`` style list of
   environment overrides to use when executing tests.

For more information, see the example tests in the LLVM test-suite repository
under the ``LNT/Examples`` directory.



LLVM CMake test-suite
~~~~~~~~~~~~~~~~~~~~~

The LLVM test-suite also has a new CMake driver.  It can run more tests in
more configurations than the Make based system. It also collects more
metrics than the Make system, for example code size.

Running the test-suite via CMake and lit uses a different LNT test::

  $ rm -rf /tmp/BAR
  $ lnt runtest test-suite \
       --sandbox /tmp/BAR \
       --cc ~/llvm.obj.64/Release+Asserts/bin/clang \
       --cxx ~/llvm.obj.64/Release+Asserts/bin/clang++ \
       --use-cmake=/usr/local/bin/cmake \
       --use-lit=~/llvm/utils/lit/lit.py \
       --test-suite ~/llvm-test-suite \
       --cmake-cache Release
     
Since the CMake test-suite uses lit to run the tests and compare their output,
LNT needs to know the path to your LLVM lit installation.  The test-suite Holds
some common common configurations in CMake caches. The ``--cmake-cache`` flag
and the ``--cmake-define`` flag allow you to change how LNT configures cmake
for the test-suite run.


Capturing Linux perf profile info
+++++++++++++++++++++++++++++++++

When using the CMake driver in the test-suite, LNT can also capture profile
information using linux perf. This can then be explored through the LNT webUI
as demonstrated at
http://blog.llvm.org/2016/06/using-lnt-to-track-performance.html .

To capture these profiles, use command line option ``--use-perf=all``. A
typical command line using this for evaluating the performance of generated
code looks something like the following::

  $ lnt runtest test-suite \
       --sandbox SANDBOX \
       --cc ~/bin/clang \
       --use-cmake=/usr/local/bin/cmake \
       --use-lit=~/llvm/utils/lit/lit.py \
       --test-suite ~/llvm-test-suite \
       --benchmarking-only \
       --build-threads 8 \
       --threads 1 \
       --use-perf=all \
       --exec-multisample=5 \
       --run-under 'taskset -c 1'


Bisecting: ``--single-result`` and ``--single-result-predicate``
++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++

The LNT driver for the CMake-based test suite comes with helpers for bisecting conformance and performance changes with ``llvmlab bisect``.

``llvmlab bisect`` is part of the ``zorg`` repository and allows easy bisection of some predicate through a build cache. The key to using ``llvmlab`` effectively is to design a good predicate command - one which exits with zero on 'pass' and nonzero on 'fail'.

LNT normally runs one or more tests then produces a test report. It always exits with status zero unless an internal error occurred. The ``--single-result`` argument changes LNT's behaviour - it will only run one specific test and will apply a predicate to the result of that test to determine LNT's exit status.

The ``--single-result-predicate`` argument defines the predicate to use. This is a Python expression that is executed in a context containing several pre-set variables:

  * ``status`` - Boolean passed or failed (True for passed, False for failed).
  * ``exec_time`` - Execution time (note that ``exec`` is a reserved keyword in Python!)
  * ``compile`` (or ``compile_time``) - Compilation time

Any metrics returned from the test, such as "score" or "hash" are also added to the context.

The default predicate is simply ``status`` - so this can be used to debug correctness regressions out of the box. More complex predicates are possible; for example ``exec_time < 3.0`` would bisect assuming that a 'good' result takes less than 3 seconds.

Full example using ``llvmlab`` to debug a performance improvement::

  $ llvmlab bisect --min-rev=261265 --max-rev=261369 \
    lnt runtest test-suite \
      --cc '%(path)s/bin/clang' \
      --sandbox SANDBOX \
      --test-suite /work/llvm-test-suite \
      --use-lit lit \
      --run-under 'taskset -c 5' \
      --cflags '-O3 -mthumb -mcpu=cortex-a57' \
      --single-result MultiSource/Benchmarks/TSVC/Expansion-flt/Expansion-flt \
      --single-result-predicate 'exec_time > 8.0'


Producing Diagnositic Reports
+++++++++++++++++++++++++++++

The test-suite module can produce a diagnostic report which might be useful
for figuring out what is going on with a benchmark::

  $ lnt runtest test-suite \
         --sandbox /tmp/BAR \
         --cc ~/llvm.obj.64/Release+Asserts/bin/clang \
         --cxx ~/llvm.obj.64/Release+Asserts/bin/clang++ \
         --use-cmake=/usr/local/bin/cmake \
         --use-lit=~/llvm/utils/lit/lit.py \
         --test-suite ~/llvm-test-suite \
         --cmake-cache Release \
         --diagnose --only-test SingleSource/Benchmarks/Stanford/Bubblesort

This will run the test-suite many times over, collecting useful information
in a report directory. The report collects many things like execution profiles,
compiler time reports, intermediate files, binary files, and build information.


Cross-compiling
+++++++++++++++

The best way to run the test-suite in a cross-compiling setup with the
cmake driver is to use cmake's built-in support for cross-compiling as much as
possible. In practice, the recommended way to cross-compile is to use a cmake
toolchain file (see
https://cmake.org/cmake/help/v3.0/manual/cmake-toolchains.7.html#cross-compiling)

An example command line for cross-compiling on an X86 machine, targeting
AArch64 linux, is::

  $ lnt runtest test-suite \
         --sandbox SANDBOX \
         --test-suite /work/llvm-test-suite \
         --use-lit lit \
         --cppflags="-O3" \
         --run-under=$HOME/dev/aarch64-emu/aarch64-qemu.sh \
         --cmake-define=CMAKE_TOOLCHAIN_FILE:FILEPATH=$HOME/clang_aarch64_linux.cmake

The key part here is the CMAKE_TOOLCHAIN_FILE define. As you're
cross-compiling, you may need a --run-under command as the produced binaries
probably won't run natively on your development machine, but something extra
needs to be done (e.g. running under a qemu simulator, or transferring the
binaries to a development board). This isn't explained further here.

In your toolchain file, it's important to specify that the cmake variables
defining the toolchain must be cached in CMakeCache.txt, as that's where lnt
reads them from to figure out which compiler was used when needing to construct
metadata for the json report. An example is below. The important keywords to
make the variables appear in the CMakeCache.txt are "CACHE STRING "" FORCE"::

  $ cat clang_aarch64_linux.cmake
  set(CMAKE_SYSTEM_NAME Linux )
  set(triple aarch64-linux-gnu )
  set(CMAKE_C_COMPILER /home/user/build/bin/clang CACHE STRING "" FORCE)
  set(CMAKE_C_COMPILER_TARGET ${triple} CACHE STRING "" FORCE)
  set(CMAKE_CXX_COMPILER /home/user/build/bin/clang++ CACHE STRING "" FORCE)
  set(CMAKE_CXX_COMPILER_TARGET ${triple} CACHE STRING "" FORCE)
  set(CMAKE_SYSROOT /home/user/aarch64-emu/sysroot-glibc-linaro-2.23-2016.11-aarch64-linux-gnu )
  set(CMAKE_C_COMPILER_EXTERNAL_TOOLCHAIN /home/user/aarch64-emu/gcc-linaro-6.2.1-2016.11-x86_64_aarch64-linux-gnu )
  set(CMAKE_CXX_COMPILER_EXTERNAL_TOOLCHAIN /home/user/aarch64-emu/gcc-linaro-6.2.1-2016.11-x86_64_aarch64-linux-gnu )



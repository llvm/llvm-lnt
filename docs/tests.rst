.. _tests:

Running Tests
=============

Quickstart
----------

To execute the LLVM test-suite using LNT, use the ``lnt runtest`` command. The information
below should be enough to get you started, but see the sections below for more complete
documentation.

#. Install ``lnt`` as explained in the :ref:`installation section <installation>`.

#. Make sure ``lit`` is installed, for example with ``pip install lit`` or via a
   monorepo installation accessible in your ``$PATH``. By default, ``lnt`` will
   look for a binary named ``llvm-lit`` in your ``$PATH``. Depending on how you
   install ``lit``, you may have to point ``lnt`` to the right binary by using
   the ``--use-lit <path>`` flag in the command below.

#. Checkout the LLVM test-suite, if you haven't already::

    git clone https://github.com/llvm/llvm-test-suite.git llvm-test-suite

   You should always keep the test-suite directory itself clean (that is, never
   do a configure inside your test suite). Make sure not to check it out into
   the LLVM projects directory, as LLVM's configure/make build will then want to
   automatically configure it for you.

#. Execute the ``lnt runtest test-suite`` test producer, point it at the test suite and
   the compiler you want to test::

      lnt runtest test-suite --sandbox $PWD/sandbox            \
                             --cc clang                        \
                             --cxx clang++                     \
                             --test-suite $PWD/llvm-test-suite \
                             --cmake-cache Release

   The ``--sandbox`` argument is a path to where the test suite build products and
   results will be stored (inside a timestamped directory, by default).

   We recommend adding ``--build-tool-options "-k"`` (if you are using ``make``)
   or ``--build-tool-options "-k 0"`` (if you are using ``ninja``). This ensures
   that the build tool carries on building even if there is a compilation
   failure in one of the tests. Without these options, every test after the
   compilation failure will not be compiled and will be reported as a missing
   executable.

#. If you already have a LNT server instance running, you can submit these results to it
   by passing ``--submit <path-or-URL-of-instance>``.

#. On most systems, the execution time results will be a bit noisy. There are
   a range of things you can do to reduce noise:

   * Only build the benchmarks in parallel, but do the actual running of the
     benchmark code at most one at a time (use ``--threads 1 --build-threads 6``).
     Of course, when you're also interested in the measured compile time,
     you should also build sequentially (use ``--threads 1 --build-threads 1``).
   * When running on linux: Make ``lnt`` use ``perf`` to get more accurate
     timing for short-running benchmarks (use ``--use-perf=1``).
   * Pin the running benchmark to a specific core, so the OS doesn't move the
     benchmark process from core to core (on linux, use ``--make-param="RUNUNDER=taskset -c 1"``).
   * Only run the programs that are marked as a benchmark; some of the tests
     in the test-suite are not intended to be used as a benchmark (use ``--benchmarking-only``).
   * Make sure each program gets run multiple times, so that LNT has a higher
     chance of recognizing which programs are inherently noisy (use ``--multisample=5``).
   * Disable frequency scaling / turbo boost. In case of thermal throttling it
     can skew the results.
   * Disable as many processes or services as possible on the target system.


Viewing Results
---------------

By default, ``lnt runtest test-suite`` will show the passes and failures after doing a
run, but if you are interested in viewing the result data in more detail you should install
a local LNT instance to submit the results to. See the sections on :ref:`running a server <running_server>`
and :ref:`importing data <importing_data>` for instructions on how to do that.


Test Producers
--------------

On the client-side, LNT comes with a number of built-in test data producers.
This documentation focuses on the LLVM test-suite (aka nightly test) generator,
since it is the primary test run using the LNT infrastructure, but note that LNT
also includes tests for other interesting pieces of data, for example Clang
compile-time performance.

LNT also makes it easy to add new test data producers and includes examples of
custom data importers (e.g., to import buildbot build information into) and
dynamic test data generators (e.g., abusing the infrastructure to plot graphs,
for example).


Built-in Tests
--------------

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


LLVM CMake test-suite
~~~~~~~~~~~~~~~~~~~~~

The llvm test-suite can be run with the ``test-suite`` built-in test.

Running the test-suite via CMake and lit uses a different LNT test::

  rm -rf /tmp/BAR
  lnt runtest test-suite                                \
       --sandbox /tmp/BAR                               \
       --cc ~/llvm.obj.64/Release+Asserts/bin/clang     \
       --cxx ~/llvm.obj.64/Release+Asserts/bin/clang++  \
       --use-cmake=/usr/local/bin/cmake                 \
       --use-lit=~/llvm/utils/lit/lit.py                \
       --test-suite llvm-test-suite                     \
       --cmake-cache Release

Since the CMake test-suite uses lit to run the tests and compare their output,
LNT needs to know the path to your LLVM lit installation. The test-suite holds
some common configurations in CMake caches. The ``--cmake-cache`` flag
and the ``--cmake-define`` flag allow you to change how LNT configures cmake
for the test-suite run.


Capturing Linux perf profile info
~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

When using the CMake driver in the test-suite, LNT can also capture profile
information using linux perf. This can then be explored through the LNT webUI
as demonstrated at
http://blog.llvm.org/2016/06/using-lnt-to-track-performance.html .

To capture these profiles, use command line option ``--use-perf=all``. A
typical command line using this for evaluating the performance of generated
code looks something like the following::

  lnt runtest test-suite                  \
       --sandbox SANDBOX                  \
       --cc ~/bin/clang                   \
       --use-cmake=/usr/local/bin/cmake   \
       --use-lit=~/llvm/utils/lit/lit.py  \
       --test-suite llvm-test-suite       \
       --benchmarking-only                \
       --build-threads 8                  \
       --threads 1                        \
       --use-perf=all                     \
       --exec-multisample=5               \
       --run-under 'taskset -c 1'


Bisecting: ``--single-result`` and ``--single-result-predicate``
~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

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

  llvmlab bisect --min-rev=261265 --max-rev=261369                            \
    lnt runtest test-suite                                                    \
      --cc '%(path)s/bin/clang'                                               \
      --sandbox SANDBOX                                                       \
      --test-suite /work/llvm-test-suite                                      \
      --use-lit lit                                                           \
      --run-under 'taskset -c 5'                                              \
      --cflags '-O3 -mthumb -mcpu=cortex-a57'                                 \
      --single-result MultiSource/Benchmarks/TSVC/Expansion-flt/Expansion-flt \
      --single-result-predicate 'exec_time > 8.0'


Producing Diagnositic Reports
~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

The test-suite module can produce a diagnostic report which might be useful
for figuring out what is going on with a benchmark::

  lnt runtest test-suite                                  \
         --sandbox /tmp/BAR                               \
         --cc ~/llvm.obj.64/Release+Asserts/bin/clang     \
         --cxx ~/llvm.obj.64/Release+Asserts/bin/clang++  \
         --use-cmake=/usr/local/bin/cmake                 \
         --use-lit=~/llvm/utils/lit/lit.py                \
         --test-suite llvm-test-suite                     \
         --cmake-cache Release                            \
         --diagnose --only-test SingleSource/Benchmarks/Stanford/Bubblesort

This will run the test-suite many times over, collecting useful information
in a report directory. The report collects many things like execution profiles,
compiler time reports, intermediate files, binary files, and build information.


Cross-compiling
~~~~~~~~~~~~~~~

The best way to run the test-suite in a cross-compiling setup with the
cmake driver is to use cmake's built-in support for cross-compiling as much as
possible. In practice, the recommended way to cross-compile is to use a cmake
toolchain file (see
https://cmake.org/cmake/help/v3.0/manual/cmake-toolchains.7.html#cross-compiling)

An example command line for cross-compiling on an X86 machine, targeting
AArch64 linux, is::

  lnt runtest test-suite                                    \
         --sandbox SANDBOX                                  \
         --test-suite /work/llvm-test-suite                 \
         --use-lit lit                                      \
         --cppflags="-O3"                                   \
         --run-under=$HOME/dev/aarch64-emu/aarch64-qemu.sh  \
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

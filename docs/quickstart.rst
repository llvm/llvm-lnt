.. _quickstart:

Quickstart Guide
================

This quickstart guide is designed for LLVM developers who are primarily
interested in using LNT to test compilers using the LLVM test-suite.

Installation
------------

You can install the latest stable release of LNT from PyPI. We recommend doing
that from a virtual environment::

    python3 -m venv .venv
    source .venv/bin/activate
    pip install llvm-lnt

This will install the client-side tools. If you also want to run a production
server, you should instead include the server-side optional requirements::

    pip install "llvm-lnt[server]"

That's it! ``lnt`` should now be accessible from the virtual environment.


Running Tests
-------------

To execute the LLVM test-suite using LNT you use the ``lnt runtest``
command. The information below should be enough to get you started, but see the
:ref:`tests` section for more complete documentation.

#. Checkout the LLVM test-suite, if you haven't already::

     git clone https://github.com/llvm/llvm-test-suite.git ~/llvm-test-suite

   You should always keep the test-suite directory itself clean (that is, never
   do a configure inside your test suite). Make sure not to check it out into
   the LLVM projects directory, as LLVM's configure/make build will then want to
   automatically configure it for you.

#. Execute the ``lnt runtest test-suite`` test producer, point it at the test suite and
   the compiler you want to test::

     lnt runtest test-suite \
       --sandbox /tmp/BAR \
       --cc ~/llvm.obj.64/Release+Asserts/bin/clang \
       --cxx ~/llvm.obj.64/Release+Asserts/bin/clang++ \
       --test-suite ~/llvm-test-suite \
       --cmake-cache Release

   The ``SANDBOX`` value is a path to where the test suite build products and
   results will be stored (inside a timestamped directory, by default).

   We recommend adding ``--build-tool-options "-k"`` (if you are using ``make``)
   or ``--build-tool-options "-k 0"`` (if you are using ``ninja``). This ensures
   that the build tool carries on building even if there is a compilation
   failure in one of the tests. Without these options, every test after the
   compilation failure will not be compiled and will be reported as a missing
   executable.

#. On most systems, the execution time results will be a bit noisy. There are
   a range of things you can do to reduce noisiness (with LNT runtest test-suite
   command line options when available between brackets):

   * Only build the benchmarks in parallel, but do the actual running of the
     benchmark code at most one at a time. (``--threads 1 --build-threads 6``).
     Of course, when you're also interested in the measured compile time,
     you should also build sequentially. (``--threads 1 --build-threads 1``).
   * When running under linux: Make lnt use linux perf to get more accurate
     timing for short-running benchmarks (``--use-perf=1``)
   * Pin the running benchmark to a specific core, so the OS doesn't move the
     benchmark process from core to core. (Under linux:
     ``--make-param="RUNUNDER=taskset -c 1"``)
   * Only run the programs that are marked as a benchmark; some of the tests
     in the test-suite are not intended to be used as a benchmark.
     (``--benchmarking-only``)
   * Make sure each program gets run multiple times, so that LNT has a higher
     chance of recognizing which programs are inherently noisy
     (``--multisample=5``)
   * Disable frequency scaling / turbo boost. In case of thermal throttling it
     can skew the results.
   * Disable as many processes or services as possible on the target system.


Viewing Results
---------------

By default, ``lnt runtest test-suite`` will show the passes and failures after doing a
run, but if you are interested in viewing the result data in more detail you
should install a local LNT instance to submit the results to.

You can create a local LNT instance with, e.g.::

    lnt create ~/myperfdb

This will create an LNT instance at ``~/myperfdb`` which includes the
configuration of the LNT application and a SQLite database for storing the
results.

Once you have a local instance, you can either submit results directly with::

     lnt import ~/myperfdb SANDBOX/test-<stamp>/report.json

or as part of a run with::

     lnt runtest --submit ~/myperfdb nt ... arguments ...

Once you have submitted results into a database, you can run the LNT web UI
with::

     lnt runserver ~/myperfdb

which runs the server on ``http://localhost:8000`` by default.

In the future, LNT will grow a robust set of command line tools to allow
investigation of performance results without having to use the web UI.

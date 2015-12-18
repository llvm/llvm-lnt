.. _concepts:

Concepts
========

LNT's data model is pretty simple, and just following the :ref:`quickstart` can
get you going with performance testing. Moving beyond that, it is useful to have
an understanding of some of the core concepts in LNT. This can help you get the
most out of LNT.

Orders Machines and Tests
-------------------------

LNT's data model was designed to track the performance of a system in many configurations
over its evolution.  In LNT, and Order is the x-axis of your performance graphs.  It is 
the thing that is changing.  Examples of common orders are software versions, 
Subversion revisions, and time stamps. Orders can also be used to represent
treatments, such as a/b.  You can put anything you want into LNT as an order,
as long as it can be sorted by Python's sort function.

A Machine in LNT is the logical bucket which results are categorized by. 
Comparing results from the same machine is easy, across machines is harder.
Sometimes machine can literally be a machine, but more abstractly, it can be any
configuration you are interested in tracking. For example, to store results
from an Arm test machine, you could have a machine call "ArmMachine"; but, you 
may want to break machines up further for example "ArmMachine-Release"
"ArmMachine-Debug", when you compile the thing you want to test in two modes.
When doing testing of LLVM, we often string all the useful parameters of the
configuration into one machines name:: 

    <hardware>-<arch>-<optimization level>-<branch-name>

Tests are benchmarks, the things you are actually testing.

Runs and Samples
----------------

Samples are the actual data points LNT collects. Samples have a value, and
belong to a metric, for example a 4.00 second (value) compile time (metric).  
Runs are the unit in which data is submitted.  A Run represents one run through
a set of tests.  A run has a Order which it was run
on, a Machine it ran on, and a set of Tests that were run, and for each Test
one or more samples.  For example, a run on ArmMachine at
Order r1234 might have two Tests, test-a which had 4.0 compile time and 3.5
and 3.6 execution times and test-b which just has a 5.0 execution time. As new
runs are submitted with later orders (r1235, r1236), LNT will start tracking
the per-machine, per-test, per-metric performance of each order.  This is how
LNT tracks performance over the evolution of your code.

Test Suites
-----------

LNT uses the idea of a Test Suite to control what metrics are collected.  Simply,
the test suite acts as a definition of the data that should be stored about
the tests that are being run.  LNT currently comes with two default test suites.
The Nightly Test Suite (NTS) (which is run far more often than nightly now), 
collects 6 metrics per test: compile time, compile status, execution time, execution
status, score and size.  The Compile (compile) Test Suite, is focused on metrics
for compile quality: wall, system and user compile time, compile memory usage
and code size.  Other test suites can be added to LNT if these sets of metrics
don't mactch your needs.

Any program can submit results data to LNT, and specify any test suite.  The
data format is a simple JSON file, and that file needs to be HTTP POSTed to the
submitRun URL.

The most common program to submit data to LNT is the LNT client application
itself.  The ``lnt runtest nt`` command can run the LLVM test suite, and submit
data under the NTS test suite. Likewise the ``lnt runtest compile`` command
can run a set of compile time benchmarks and submit to the Compile test suite.

Given how simple it is to make your own results and send them to LNT,
it is common to not use the LNT client application at all, and just have a
custom script run your tests and submit the data to the LNT server.

.. _importing_data:

Importing Data in a Text File
=============================

The LNT importreport command will import data in a simple text file format. The
command takes a space separated key value file and creates an LNT report file,
which can be submitted to a LNT server.  Example input file::

    foo.exec 123
    bar.size 456
    foo/bar/baz.size 789

The format is "test-name.metric", so exec and size are valid metrics for the
test suite you are submitting to.

Example::

    echo -n "foo.exec 25\nbar.score 24.2\nbar/baz.size 110.0\n" > results.txt
    lnt importreport --machine=my-machine-name --order=1234 --testsuite=nts results.txt report.json
    lnt submit http://mylnt.com/default/submitRun --commit=1 report.json


Importing Data from Other Test Systems
======================================

The lnt importreport tool is an easy way to import data into LNTs test format.
Or you can write your own importer.

First, make sure you've understood the underlying :ref:`concepts` used by LNT.

Given how simple it is to make your own results and send them to LNT,
it is common to not use the LNT client application at all, and just have a
custom script run your tests and submit the data to the LNT server. Details
on how to do this are in :mod:`lnt.testing`

If for some reason you prefer to generate the json file more directly, the
current format looks like below. It remains recommended to use the APIs in
:mod:`lnt.testing` to be better protected against future changes to the json
format::

  {
     "Machine": {
        "Info": {
          (_String_: _String_)* // optional extra info about the machine.
        },
        "Name": _String_ // machine name, mandatory
     },
     "Run": {
        "End Time": "%Y-%m-%d %H:%M:%S", // mandatory
        "Start Time": "%Y-%m-%d %H:%M:%S", // mandatory
        "Info": {
          "run_order": _String_, // mandatory
          "tag": "nts" // mandatory
          (_String_: _String_)* // optional extra info about the run.
        }
     },
     "Tests": [
          {
              "Data": [ (float+) ],
              "Info": {},
              "Name": "nts._ProgramName_._metric_"
          }+
      ]
   }


A concrete small example is::

  {
     "Machine": {
        "Info": {
        },
        "Name": "LNT-AArch64-A53-O3__clang_DEV__aarch64"
     },
     "Run": {
        "End Time": "2016-04-07 14:25:52",
        "Start Time": "2016-04-07 09:33:48",
        "Info": {
          "run_order": "265649",
          "tag": "nts"
        }
     },
     "Tests": [
          {
              "Data": [
                  0.1056,
                  0.1055
              ],
              "Info": {},
              "Name": "nts.suite1/program1.exec"
          },
          {
              "Data": [
                  0.2136
              ],
              "Info": {},
              "Name": "nts.suite2/program1.exec"
          }
      ]
   }

Make sure that:
 * The Run.Info.tag value is "nts".
 * The test names always start with "nts.".
 * The extension of the test name indicate what kind of data is recorded.
   Currently accepted extensions in the NTS database are:

   * ".exec": represents execution time - a lower number is better.
   * ".score": represent a benchmark score - a higher number is better.
   * ".hash": represents a hash of the binary program being executed. This is
     used to detect if between compiler versions, the generated code has
     changed.
   * ".compile": represents the compile time of the program.

 All of these metrics are optional.


.. _custom_testsuites:

Custom Test Suites
==================

LNTs test suites are derived from a set of metadata definitions for each suite.
Simply put, suites are a collections of metrics that are collected for each run.
You can define your own test-suites if the schema in a different suite does not
already meet your needs.

Creating a suite requires database access, and shell access to the machine.
First create the metadata tables, then tell LNT to build the suites tables from
the new metadata you have added.

 * Open the database you want to add the suite to.
 * Add a new row to the TestSite table, note the ID.
 * Add machine and run fields to TestSuiteMachineFields and TestSuiteRunFields.
 * Add an Order to TestSuiteOrderFields.  The only order name that is regularly
   tested is llvm_project_revision, so you may want to use that name.
 * Add new entries to the TestSuiteSampleFields for each metric you want to
   collect.
 * Now create the new LNT tables via the shell interface. In this example
   we make a tables for the size testsuite in the ecc database::

    $ lnt runserver --shell ./foo
    Started file logging.
    Logging to : lnt.log
    Python 2.7.5 (default, Mar  9 2014, 22:15:05)
    [GCC 4.2.1 Compatible Apple LLVM 5.0 (clang-500.0.68)] on darwin
    Type "help", "copyright", "credits" or "license" for more information.
    (InteractiveConsole)
    >>> g.db_name = "ecc"
    >>> db = ctx.request.get_db()
    >>> db
    <lnt.server.db.v4db.V4DB object at 0x10ac4afd0>
    >>> import lnt.server.db.migrations.new_suite as ns
    >>> ns.init_new_testsuite(db.engine, db.session, "size")
    >>> db.session.commit()


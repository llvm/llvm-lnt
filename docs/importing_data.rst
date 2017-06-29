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

.. _json_format:

LNT Report File Format
======================

The lnt importreport tool is an easy way to import data into LNTs test format.
You can also create LNTs report data directly for additional flexibility.

First, make sure you've understood the underlying :ref:`concepts` used by LNT.

.. code-block:: none

  {
      "format_version": "2",
      "machine": {
          "name": _String_      // machine name, mandatory
          (_String_: _String_)* // optional extra info
      },
      "run": {
          "start_time": "%Y-%m-%d %H:%M:%S", // mandatory
          "end_time": "%Y-%m-%d %H:%M:%S",   // mandatory
          (_String_: _String_)* // optional extra info about the run.
          // At least one of the extra fields is used as ordering and is
          // mandatory. For the 'nts' and 'Compile' schemas this is the
          // 'llvm_project_revision' field.
      },
      "tests": [
          {
              "name": _String_,   // test name mandatory
              (_String_: _Data_)* // List of metrics, _Data_ allows:
                                  // number, string or list of numbers
          }+
      ]
  }

A concrete small example is

.. literalinclude:: report-example.json
    :language: json


Given how simple it is to make your own results and send them to LNT,
it is common to not use the LNT client application at all, and just have a
custom script run your tests and submit the data to the LNT server. Details
on how to do this are in :mod:`lnt.testing`

.. _nts_suite:

Default Test Suite (NTS)
========================

The default test-suite schema is called NTS. It was originally designed for
nightly test runs of the llvm test-suite. However it should fit many other
benchmark suites as well. The following metrics are supported for a test:

* ``execution_time``: Execution time in seconds; lower is better.
* ``score``: Benchmarking score; higher is better.
* ``compile_time``: Compiling time in seconds; lower is better.
* ``execution_status``: A non zero value represents an execution failure.
* ``compilation_status``: A non zero value represents a compilation failure.
* ``hash_status``: A non zero value represents a failure computing the
  executable hash.
* ``mem_byts``: Memory usage in bytes during execution; lower is better.
* ``code_size``: Code size (usually the size of the text segment) in bytes;
  lower is better.

The `run` information is expected to contain this:

* ``llvm_project_revision``: The revision or version of the compiler
  used for the tests. Used to sort runs.

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


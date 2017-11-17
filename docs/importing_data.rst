.. _importing_data:

Importing Data
==============

Importing Data in a Text File
-----------------------------

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
    lnt submit http://mylnt.com/db_default/submitRun report.json

.. _json_format:

LNT Report File Format
----------------------

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
          ("start_time": "%Y-%m-%dT%H:%M:%S",)? // optional, ISO8061 timestamp
          ("end_time": "%Y-%m-%dT%H:%M:%S",)?   // optional, ISO8061 timestamp, can equal start_time if not known.
          (_String_: _String_,)* // optional extra info about the run.
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
------------------------

The default test-suite schema is called NTS. It was originally designed for
nightly test runs of the llvm test-suite. However it should fit many other
benchmark suites as well. The following metrics are supported for a test:

* ``execution_time``: Execution time in seconds; lower is better.
* ``score``: Benchmarking score; higher is better.
* ``compile_time``: Compiling time in seconds; lower is better.
* ``hash``: A string with the executable hash (usually md5sum of the stripped binary)
* ``mem_bytes``: Memory usage in bytes during execution; lower is better.
* ``code_size``: Code size (usually the size of the text segment) in bytes;
  lower is better.
* ``execution_status``: A non zero value represents an execution failure.
* ``compile_status``: A non zero value represents a compilation failure.
* ``hash_status``: A non zero value represents a failure computing the
  executable hash.

The `run` information is expected to contain this:

* ``llvm_project_revision``: The revision or version of the compiler
  used for the tests. Used to sort runs.

.. _custom_testsuites:

Custom Test Suites
------------------

LNT test suite schemas define which metrics can be tracked for a test and what
extra information is known about runs and machines.  You can define your own
test suite schemas in a yaml file. The LNT administrator has to place (or
symlink) this yaml file into the servers schema directory.

Example:

.. literalinclude:: my_suite.yaml
    :language: yaml

* LNT currently supports the following metric types:

  - ``Real``: 8-byte IEEE floating point values.
  - ``Hash``: String values; limited to 256, sqlite is not enforcing the limit.
  - ``Status``: StatusKind enum values (limited to 'PASS', 'FAIL', 'XFAIL' right
    now).

* You need to mark at least 1 of the run fields as ``order: true`` so LNT knows
  how to sort runs.
* Note that runs are not be limited to the fields defined in the schema for
  the run and machine information. The fields in the schema merely declare which
  keys get their own column in the database and a prefered treatment in the UI.

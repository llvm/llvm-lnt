.. _importing_data:

Importing Data from Other Test Systems
======================================

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

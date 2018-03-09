Performance profiles
====================

LNT has support for storing and displaying performance profiles. The intent of these profiles is to expose code generation differences between test samples and to allow easy identification of hot sections of code.

Principles of profiles in LNT
-----------------------------

Profiles in LNT are represented in a custom format. The user interface operates purely on queries to this custom format. Adapters are written to convert from other formats to LNT's profile format. Profile data is uploaded as part of the normal JSON report to the LNT server.

Producing profile data
----------------------

Profile generation can be driven directly through python API calls (for which ``lnt profile`` is a wrapper) or using the ``lnt runtests`` tool.

Producing profile data via ``lnt runtests test-suite``
~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

.. note::

   Profile collection via LNT is currently only supported on **Linux systems** as the only adapter that has currently been written uses Linux's ``perf`` infrastructure. When more adapters have been written, LNT can grow support for them.

If your test system is already using ``lnt runtests`` to build and run tests, the simplest way to produce profiles is simply to add a single parameter::

  --use-perf=all

The ``--use-perf`` option specifies what to use Linux Perf for. The options are:

* ``none``: Don't use ``perf`` for anything
* ``time``: Use ``perf`` to measure compile and execution time. This can be much more accurate than ``time``.
* ``profile``: Use ``perf`` for profiling only.
* ``all``: Use ``perf`` for profiling and timing.

The produced profiles live alongside each test executable, named ``$TEST.perf_data``. These profiles are processed and converted into LNT's profile format at the end of test execution and are inserted into the produced ``report.json``.

Producing profile data without ``lnt runtests test-suite``
~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

A supported usecase of LNT is to use the LNT server for performance tracking but to use a different test driver than ``lnt runtests`` to actually build, run and collect statistics for tests.

The profiling data sits inside the JSON report submitted to LNT. This section will describe how to add profile data to an already-existing JSON report; See :ref:`importing_data` for details of the general structure of the JSON report.

The first step is to produce the profile data itself in LNT format suitable for sending via JSON. To import a profile, use the ``lnt profile upgrade`` command::

  lnt profile upgrade my_profile.perf_data /tmp/my_profile.lntprof

``my_profile.perf_data`` is assumed here to be in Linux Perf format but can be any format for which an adapter is registered (this currently is only Linux Perf but it is expected that more will be added over time).

``/tmp/my_profile.lntprof`` is now an LNT profile in a space-efficient binary form. To prepare it to be sent via JSON, we must base-64 encode it::

  base64 -i /tmp/my_profile.lntprof > /tmp/my_profile.txt

Now we just need to add it to the report. Profiles look similar to hashes in that they are samples with string data::

  {
    "format_version": "2",
    "machine": {
       ...
    },
    "run": {
       ...
    },
    "tests": [
       {
           "name": "nts.suite1/program1",
           "execution_time": [ 0.1056, 0.1055 ],
           "profile": "eJxNj8EOgjAMhu99Cm9wULMOEHgBE888QdkASWCQFWJ8e1v04JIt+9f//7qmfkVoEj8yMXdzO70v/RJn2hJYrRQiveSWATdJvwe3jUtgecgh9Wsh9T6gyJvKUjm0kegK0mmt9UCjJUSgB5q8KsobUJOQ96dozr8tAbRApPbssOeCcm83ddoLC7ijMcA/RGUUwXt7iviPEDLJN92yh62LR7I8aBUMysgLnaKNFNzzMo8y7uGplQ4sa/j6rfn60WYaGdRhtT9fP5+JUW4="
       }
    ]
}

Supported formats
-----------------

Linux Perf
~~~~~~~~~~

Perf profiles are read directly from the binary ``perf.data`` file without using the ``perf`` wrapper tool or any Linux/GPL headers. This makes it runnable on non-Linux platforms although this is only really useful for debugging as the profiled binary / libraries are expected to be readable.

The perf import code uses a C++ extension called cPerf that was written for the LNT project. It is less functional than ``perf annotate`` or ``perf report`` but produces much the same data in a machine readable form about 6x quicker. It is written in C++ because it is difficult to write readable Python that performs efficiently on binary data. Once the event stream has been aggregated, a python dictionary object is created and processing returns to Python. Speed is important at this stage because the profile import may be running on older or less powerful hardware and LLVM's test-suite contains several hundred tests that must be imported!

.. note::

   In recent versions of Perf a new subcommand exists: ``perf data``. This outputs the event trace in `CTF format <https://www.efficios.com/ctf>`_ which can then be queried using `babeltrace <http://diamon.org/babeltrace/>`_ and its Python bindings. This would allow to remove a lot of custom code in LNT as long as it is similarly performant.

Adding support for a new profile format
~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

To create a new profile adapter, a new Python class must be created in the ``lnt.testing.profile`` package which subclasses the ``ProfileImpl`` class:

.. autoclass:: lnt.testing.profile.profile.ProfileImpl
   :members:

Your subclass can either implement all functions as specified, or do what ``perf.py`` does which is only implement the ``checkFile()`` and ``deserialize()`` static functions. In this model inside ``deserialize()`` you would parse your profile data into a simple dictionary structure and create a ``ProfileV1Impl`` object from it. This is a really simple profile implementation that just works from a dictionary representation:

.. automodule:: lnt.testing.profile.profilev1impl
   :members:

Viewing profiles
----------------

Once profiles are submitted to LNT, they are available either through a manual URL or through the "runs" page.

On the run results page, "view profile" links should appear when table rows are hovered over if profile data is available.

.. note::

   It is known that this hover-over effect isn't touchscreen friendly and is perhaps unintuitive. This page should be modified soon to make the profile data link more obvious.

Alternatively a profile can be viewed by manually constructing a URL::

  db_default/v4/nts/profile/<test-id>/<run1-id>/<run2-id>

Where:

* ``test-id`` is the database TestID of the test to display
* ``run1-id`` is the database RunID of the run to appear on the left of the display
* ``run2-id`` is the database RunID of the run to appear on the right of the display

Obviously, this URL is somewhat hard to construct, so using the links from the run page as above is recommended.

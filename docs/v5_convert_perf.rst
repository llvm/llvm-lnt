.. _v5_convert_perf:

Converting perf Profiles for v5
===============================

``lnt v5 convert-perf`` converts a profile recorded by Linux ``perf record``
into a profile document, the form in which a run submitted to an LNT v5
instance carries a test's profile.


Example
-------

To convert ``bench.perf_data``, the profile of the test ``bench``::

    lnt v5 convert-perf bench.perf_data > bench.profile.json

To attach it to that test in ``run.json``, a v5 run submission, convert it with
``--encode``, which gives the string a test's ``profile`` holds::

    lnt v5 convert-perf --encode bench.perf_data -o bench.profile
    jq --rawfile profile bench.profile \
        '(.tests[] | select(.name == "bench")).profile = ($profile | rtrimstr("\n"))' \
        run.json > run-with-profile.json

See ``lnt v5 convert-perf --help`` for the other options.


Reading the profile
-------------------

The profile is read the way v4 reads one (see :doc:`profiles`), by the same
code:

- Only binaries holding more than 1% of some counter's samples are read, and
  only their functions holding more than 0.5% of some counter's samples are
  listed. The profile's counters are still totals over every sample.
- The profiled binaries must still be where they were profiled, or their copies
  under ``--binary-cache-root``, which is prefixed to their paths. They are read
  with ``objdump`` (``--objdump``), whose output is also the instructions' text.
- Only the given file is read, whereas v4 also merges the files whose names
  start with its name.

Every counter is a raw count. An instruction that has no count for a counter,
because no sample of it landed there, leaves the counter out, which a v5
instance reads as 0.


Function names
--------------

Each function is named by its demangled name, which ``c++filt`` (``--cxxfilt``)
gives. A function listed under several names, such as an alias, or a symbol
that is both static and dynamic, is listed once, under the first of its names
in alphabetical order.

A function is named by its mangled name instead when its demangled name is
longer than 2048 bytes in UTF-8, or is already another function's: for
example, a complete-object and a base-object constructor that are not aliases
both demangle to ``A::A()``.

The instructions' text is left as ``objdump`` prints it, so the functions it
refers to keep their mangled names.


What is left out
----------------

A v5 instance refuses a profile, and with it the whole run carrying it, that
does not stay within its limits. The command therefore leaves out the
functions an instance would refuse, each with a warning:

- a function whose name, even mangled, is longer than 2048 bytes, or is another
  function's;
- a function with more than 100,000 instructions;
- a function at an address larger than 2\ :sup:`63` - 1, such as the kernel's.

The profile's counters still include them. A profile that remains too large
for an instance -- more than 10,000 functions, or a document of more than
32 MiB, or 4 MiB compressed -- is an error. These limits are the ones a v5
instance had when this version of LNT was released, and the instance has the
final say.


Output
------

The command writes the profile document as one line of JSON, or with
``--encode``, gzip-compressed and then base64-encoded, to its standard output,
or with ``-o FILE``, to ``FILE``. Converting the same profile again gives the
same output.

The command reports on its standard error the functions it leaves out, and
warns when the profile lists no function, which typically means that the
profiled binaries could not be read. It exits with a non-zero status if the
profile cannot be converted.

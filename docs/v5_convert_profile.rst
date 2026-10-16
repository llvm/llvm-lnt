.. _v5_convert_profile:

Converting Profiles for v5
==========================

``lnt v5 convert-profile`` converts a profile into a profile document, the form
in which a run submitted to an LNT v5 instance carries a test's profile. So
far, the only format it reads is that of Linux ``perf record``.


Example
-------

To convert ``bench.perf_data``, the profile of the test ``bench``::

    lnt v5 convert-profile bench.perf_data > bench.profile.json

To get the profile document in the format a v5 run submission uses for a
test's ``profile`` (gzip-compressed, then base64-encoded), convert it with
``--encode``::

    lnt v5 convert-profile --encode bench.perf_data -o bench.profile

See ``lnt v5 convert-profile --help`` for the other options.


Function names
--------------

Each function is named by its demangled name, which ``c++filt`` (``--cxxfilt``)
gives. A function listed under several names, such as an alias, or a symbol
that is both static and dynamic, is listed only once.

A function is named by its mangled name instead when its demangled name is
longer than 2048 bytes in UTF-8, or if its demangling collides with the name
of another function. For example, a complete-object and a base-object constructor
that are not aliases both demangle to ``A::A()``.

The instructions' text is whatever ``objdump`` produces.


What is left out
----------------

A v5 instance refuses a profile (and its run) that does not stay within its limits.
The command therefore leaves out the functions that would be refused by the server
on submission:

- a function whose name (even mangled) is longer than 2048 bytes;
- a function with more than 100,000 instructions;
- a function at an address larger than 2\ :sup:`63` - 1, e.g. the kernel's.

The profile's counters still include them. A profile that remains too large
for an instance -- more than 10,000 functions, or a document of more than
32 MiB, or 4 MiB compressed -- is an error.

.. _intro:

Introduction
============

LNT is an infrastructure for performance testing. The software itself consists
of two main parts, a web application for accessing and visualizing performance
data, and command line utilities to allow users to generate and submit test
results to the server.

The package was originally written for use in testing LLVM compiler technologies,
but is designed to be usable for the performance testing of any software. LNT uses
a simple and extensible format for interchanging data between the test producers and
the server; this allows the LNT server to receive and store data for a wide variety
of applications.

Both the LNT client and server are written in Python, however the test data
itself can be passed in one of several formats, including property lists and
JSON. This makes it easy to produce test results from almost any language.

.. _installation:

Installation
------------

You can install the latest stable release of LNT from PyPI. We recommend doing
that from a virtual environment::

   python3 -m venv .venv
   source .venv/bin/activate
   pip install llvm-lnt

This will install the client-side tools. If you want to run a production server,
you should instead install ``llvm-lnt`` while including the server-side optional
requirements::

   pip install "llvm-lnt[server]"

That's it! ``lnt`` should now be accessible from the virtual environment.

If you are an LLVM developer who is mostly interested in just using LNT to run
the test-suite against some compiler, then you should fast forward to the section
on :ref:`running tests <tests>`. If you want to run your own LNT server, jump to
the section on :ref:`running a server <running_server>`. Otherwise, jump to the
:ref:`table of contents <contents>` to get started.

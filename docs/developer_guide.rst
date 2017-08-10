.. _developer_guide:

Developer Guide
===============

This developer guide aims to get you started with developing LNT. At the
moment, a lot of detailed info is missing, but hopefully this will get you
started.

Installation
------------

See :ref:`quickstart` for setting up an installation. Use the "develop" option
when running ~/lnt/setup.py.

Running LNT's Regression Tests
------------------------------

LNT has a growing body of regression tests that makes it easier to improve LNT
without accidentally breaking existing functionality. Just like when developing
most other LLVM sub-projects, you should consider adding regression tests for
every feature you add or every bug you fix. The regression tests must pass at
all times, therefore you should run the regression tests as part of your
development work-flow, just like you do when developing on other LLVM
sub-projects.

The LNT regression tests make use of lit and other tools like FileCheck. At
the moment, probably the easiest way to get them installed is to compile LLVM
and use the binaries that are generated there. Assuming you've build LLVM
into $LLVMBUILD, and installed lnt in $LNTINSTALL you can run the regression
tests using the following command::

     PATH=$LLVMBUILD/bin:$LNTINSTALL/bin:$PATH llvm-lit -sv ./tests

If you don't like temporary files being created in your LNT source directory,
you can run the tests in a different directory too::

     mkdir ../run_lnt_tests
     cd ../run_lnt_tests
     PATH=$LLVMBUILD/bin:$LNTINSTALL/bin:$PATH llvm-lit -sv ../lnt/tests

For simple changes, adding a regression test and making sure all regression
tests pass, is often a good enough testing approach. For some changes, the
existing regression tests aren't good enough at the moment, and manual testing
will be needed.

For any changes that touch on the LNT database design, you'll need to run tests
on at least sqlite and postgres database engines.  By default the regression
tests uses sqlite. To enable additional regression tests against a postgress
database, use a command like the following::

     PATH=$LLVMBUILD/bin:$LNTINSTALL/bin:$PATH llvm-lit -sv -Dpostgres=1 ../lnt/tests

You'll need to use at least postgres version 9.2 to run the regression tests.

LNT MySQL Support
=================

The lnt.llvm.org server runs on MySQL. Testing has been more limited than sqlite and Postgres.  To run the regression
tests there needs to be MySQL installed in the local path. The LNT tests will create their own instance of a MySQL
server and database to test in::

    llvm-lit -sv -Dmysql=1 ../lnt/tests

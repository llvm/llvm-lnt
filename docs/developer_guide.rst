.. _developer_guide:

Developer Guide
===============

This developer guide aims to get you started with developing LNT. At the
moment, a lot of detailed info is missing, but hopefully this will get you
started.

Installation
------------

For development purposes, we recommend checking out the sources, setting up a
virtual environment and installing the development dependencies::

    python3 -m venv .venv
    source .venv/bin/activate
    pip install ".[dev]"

This will install the current version of the package, along with the dependencies
required for development (``lit``, ``filecheck``, etc).

Running LNT's Regression Tests
------------------------------

LNT has a growing body of regression tests that makes it easier to improve LNT
without accidentally breaking existing functionality. Just like when developing
most other LLVM sub-projects, you should consider adding regression tests for
every feature you add or every bug you fix. The regression tests must pass at
all times, therefore you should run the regression tests as part of your
development work-flow, just like you do when developing on other LLVM
sub-projects.

We use ``tox`` as the high-level driver to run tests. To run them locally,
simply run the ``tox`` command from the root of the repository. We also have
various unit tests which execute using LLVM's ``lit`` utility. You can run
individual unit tests with ``lit`` directly (assuming you have installed
the development dependencies in your virtual environment)::

    lit -sv tests/lnttool/submit.shtest

For simple changes, adding a regression test and making sure all regression
tests pass, is often a good enough testing approach. For some changes, the
existing regression tests aren't good enough at the moment, and manual testing
will be needed.

Optional Tests
~~~~~~~~~~~~~~

Some tests require additional tools to be installed and are not enabled by
default. You can enable them by passing additional flags to ``lit``:

  ``-Dpostgres=1``
    Enable postgres database support testing. This requires at least
    postgres version 9.2 and the ``initdb`` and ``postgres`` binaries in your path.
    Note that you do not need to setup an actual server, the tests will create
    temporary instances on demand.

  ``-Dmysql=1``
    Enable mysql database support testing. This requires MySQL-python to be
    installed and expects the ``mysqld`` and ``mysqladmin`` binaries in your path.
    Note that you do not need to setup an actual server, the tests will create
    temporary instances on demand.

  ``-Dtidylib=1``
    Check generated html pages for errors using ``tidy-html5``. This requires
    ``pytidylib`` and ``tidy-html5`` to be installed.

  ``-Dcheck-coverage=1``
    Enable ``coverage.py`` reporting, assuming the coverage module has been
    installed and ``sitecustomize.py`` in the virtualenv has been modified
    appropriately.

Example::

    lit -sv -Dpostgres=1 -Dmysql=1 -Dtidylib=1 ./tests

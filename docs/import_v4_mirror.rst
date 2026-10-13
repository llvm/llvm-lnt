.. _import_v4_mirror:

Importing a v4 Mirror into v5
=============================

``lnt v5 import-v4-mirror`` imports a test suite from a mirror made by
``lnt mirror-v4`` (see :ref:`mirror_v4`) into a test suite of an LNT v5
instance, through the v5 REST API. It is meant for moving an instance from v4 to
v5: the mirror is a snapshot of the v4 instance, imported once.

The v5 concepts and formats referred to below (the test suite schema, the run
submission format, the error codes) are specified in ``v5/docs/design``, and
sections of it are referred to by their identifiers, e.g. ``D4``.


Example
-------

To import the ``nts`` suite of a mirror of the ``spec`` database into the
``spec_nts`` suite of a v5 instance::

    lnt v5 import-v4-mirror ./lnt-mirror --suite nts \
        --target https://lnt.example.com --target-suite spec_nts --token <token>

Adding ``--dry-run`` checks that the whole suite can be converted, without
contacting the v5 instance. See ``lnt v5 import-v4-mirror --help`` for the
other options.


What is imported
----------------

Everything the mirror holds for the suite: its schema, its machines, and its
runs with their samples. Since the mirror holds neither regressions nor
profiles, neither are imported (see :ref:`mirror_v4`).

The command reads the mirror as ``mirror_v4.rst`` specifies: it refuses a
manifest whose ``format_version`` is not ``"1"``, reads only the files the
manifest references, and refuses to run if any of them is missing or does not
have the hash the manifest records.

Each v4 entity becomes one v5 entity, as described in the following sections.
Anything that cannot be converted as described is an error: the command never
guesses.


Conversion
----------

Schema
~~~~~~

The target suite's schema (D4) is derived from the v4 schema and the suite's
machines:

- **Metrics**: one per v4 metric, with the same name. ``Real`` becomes ``real``,
  ``Status`` becomes ``integer``, and ``Hash`` becomes ``text``; any other type
  is an error. ``bigger_is_better``, ``unit`` and ``unit_abbrev`` are kept,
  except that an empty ``unit`` or ``unit_abbrev`` becomes null. So does a
  ``display_name`` equal to the metric's name, which is how v4 reports a metric
  without one. Other keys, such as ``ignore_same_hash``, are dropped.
- **Machine fields**: one ``text`` field per v4 machine field, followed by one
  ``text`` field per other key found on any of the suite's machines, other than
  ``id`` and ``name``, in alphabetical order. v4 machines can hold keys that
  their schema does not declare, whereas v5 machines cannot (O2).
- **Commit fields**: none.
- **Run fields**: the v4 schema must have exactly one run field marked
  ``order``, which defines commits (see below). Other run fields are not
  declared anywhere: v5 runs have no declared fields, so their values go into
  ``run_parameters``.

The derived schema must be a valid v5 schema (D4): a name that v5 does not
accept, or that collides with a built-in column (D5), is an error.

The v4 instance may report the schema inaccurately (see :ref:`mirror_v4`), so
``--schema FILE`` replaces the derived schema with a v5 schema document, in the
format ``GET /api/suites/{name}`` returns. Its ``name`` is replaced by the
target suite's. It must declare every metric and machine field that the derived
schema declares, with the same type; it may differ in anything else.

Machines
~~~~~~~~

Each v4 machine becomes a v5 machine, untracked (``tracked: false``), so that
the instance's administrator chooses which machines are tracked once the import
is done. Its fields are the values of its keys, other than ``id`` and
``name``, that are not null. Every value must be a string.

Its name is the v4 machine's name, with every ``/`` replaced by ``_``, since a v5
machine name cannot contain one (I1). v4 machine names are not unique, whereas
v5 machine names are: among the v4 machines with the same name, the one with
the lowest identifier keeps the name, and each of the others gets a suffix
``-import-<id>``, where ``<id>`` is its v4 identifier. For example, v4 machines
352 and 372, both named ``x86_64-O3``, become ``x86_64-O3`` and
``x86_64-O3-import-372``.

The resulting names must be unique, and valid v5 machine names (D5, I1): it is
an error otherwise.

Commits
~~~~~~~

A run's commit is the value of its order field, as a string, unchanged. It must
be a valid v5 commit value (D5, I1).

The commit's ordinal is the number the value holds when it matches
``^r?[0-9]+$`` (e.g. ``602079`` or ``r602079``), provided it fits the ordinal's
column (D5). Any other commit has no ordinal. Two different values with the
same ordinal (e.g. ``602079`` and ``r602079``) are an error, since ordinals are
unique (O6).

Commits get no tag and no fields.

Runs
~~~~

Each v4 run becomes one v5 run submission (O1):

- ``uuid``: the version 5 UUID of the v4 run's API URL, in the ``URL``
  namespace of RFC 9562, i.e. of ``<url>/api/db_<database>/v4/<suite>/runs/<id>``
  where ``<url>`` and ``<database>`` are the mirror's ``source``. Importing the
  same run again therefore always names the same v5 run.
- ``machine``: the run's machine, as described above.
- ``commit``: ``value`` and, if it has one, ``ordinal``, as described above.
- ``run_parameters``: every key of the v4 run that is not null, except ``id``,
  ``order_id``, ``order_by`` and the order field. This keeps ``start_time`` and
  ``end_time``: the v5 run's ``submitted_at`` is the time of the import, which
  is when v5 receives it.
- ``tests``: one entry per test name, in the order the names first appear among
  the v4 samples. Each v4 sample becomes one v5 sample, holding the metrics that
  are not null in it, even if that leaves none. A key of a v4 sample other than
  ``id``, ``run_id``, ``name`` and the suite's metrics is an error.

The command checks each value against its metric's type, as D3 defines it.


Submission
----------

1. If the target suite does not exist, the command creates it with the schema
   above, which requires a token with ``manage`` scope. If it exists, its
   schema must be the one the command would create, normalized as D4
   describes: it is an error otherwise, and nothing is submitted.
2. The command lists the runs the target suite already has, and skips those
   whose UUID it would submit. This is how an interrupted import resumes.
3. The other runs are submitted in increasing order of their v4 identifier, by
   ``--workers`` concurrent requests. A ``409 duplicate`` means the run was
   submitted already, and counts as a success. Network errors, 5xx responses and
   ``409 retry`` are retried a few times. Any other failure, and any run that
   cannot be converted, is reported along with the v4 run and machine it
   concerns, and the command carries on with the next run.

The command exits with a non-zero status if any run failed. Running it again
submits only the runs that are still missing.

With ``--dry-run``, the command derives the schema, converts every run, and
reports what it would submit and every error, without contacting the v5
instance.

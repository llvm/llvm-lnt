.. _convert_v4_mirror:

Converting a v4 Mirror for v5
=============================

``lnt v5 convert-v4-mirror`` converts a test suite of a mirror made by
``lnt mirror-v4`` (see :ref:`mirror_v4`) into runs that ``lnt v5 submit`` can
submit to a test suite of an LNT v5 instance (see :ref:`v5_submit`).


Example
-------

To import the ``nts`` suite of a mirror into the ``nts`` suite of a v5
instance, convert it, and then submit the converted runs, creating the suite
with the schema the conversion derived::

    lnt v5 convert-v4-mirror ./lnt-mirror --suite nts \
        --schema-out nts-schema.json > nts.jsonl
    lnt v5 submit https://lnt.example.com --suite nts \
        --create-suite nts-schema.json --token <token> nts.jsonl

Once the mirror has been refreshed, converting it again and submitting the
result submits the runs that the v5 instance does not have yet::

    lnt v5 convert-v4-mirror ./lnt-mirror --suite nts | \
        lnt v5 submit https://lnt.example.com --suite nts --token <token>

See ``lnt v5 convert-v4-mirror --help`` for the other options.


What is converted
-----------------

Everything the mirror holds for the suite: its schema, its machines, and its
runs with their samples. Since the mirror holds neither regressions nor
profiles, neither are converted (see :ref:`mirror_v4`).

Each v4 entity becomes one v5 entity, as described in the following sections.
Anything that cannot be converted as described is an error: the command never
guesses.


Conversion
----------

Schema
~~~~~~

The target suite's schema is derived from the v4 schema and the suite's
machines:

- **Metrics**: one per v4 metric, with the same name. ``Real`` becomes ``real``,
  ``Status`` becomes ``integer``, and ``Hash`` becomes ``text``; any other type
  is an error. ``bigger_is_better``, ``unit`` and ``unit_abbrev`` are kept,
  except that an empty ``unit`` or ``unit_abbrev`` becomes null. So does a
  ``display_name`` equal to the metric's name, which is how v4 reports a metric
  without one. Other keys are dropped.
- **Machine fields**: one ``text`` field per v4 machine field, followed by one
  ``text`` field per other key found on any of the suite's machines, other than
  ``id`` and ``name``, in alphabetical order. v4 machines can hold keys that
  their schema does not declare, whereas v5 machines cannot.
- **Commit fields**: none.
- **Run fields**: the v4 schema must have exactly one run field marked
  ``order``, which defines commits (see below). Other run fields are not
  declared anywhere: v5 runs have no declared fields, so their values go into
  ``run_parameters``.

The derived schema must be a valid v5 schema, it is an error otherwise.

Since v4 instances sometimes report their schema inaccurately, the schema to
use when importing into a v5 instance can be specified explicitly with
``--schema FILE``. The file must be in the JSON format used by v5 schemas. Its
``name`` must be the target suite's, and it must declare every metric and
machine field that the derived schema declares, with the same type; it can also
declare more.

Machines
~~~~~~~~

Each v4 machine becomes an untracked v5 machine. The intent is for the
instance's administrator to manually select which machines are to be tracked
on the dashboard. Each machine's non-null fields are carried over from v4.

Its name is the v4 machine's name, with every ``/`` and ``%`` replaced by
``_``, since a v5 machine name cannot contain either. v5 machine names are
unique, but LNT v4 allows multiple machines to share the same name. For that
reason, the import script remaps machines with duplicate names: among the v4
machines with the same name, the one with the lowest identifier (in the v4 DB)
keeps the name, and each of the others gets a suffix ``-import-<id>``, where
``<id>`` is its v4 DB id. For example, v4 machines with IDs ``352`` and
``372``, both named ``x86_64-O3``, become ``x86_64-O3`` and
``x86_64-O3-import-372``.

The resulting names must be unique and valid v5 names, otherwise it is an error.

Commits
~~~~~~~

A run's commit is the value of its order field, as a string, unchanged. A v4
suite whose order field holds a revision number may record a better identity
for the commit in another run field, such as a git SHA: with
``--commit-field FIELD``, a run's commit is the value of its ``FIELD`` instead,
when the run has one. It is an error if no run has one. Either way, the commit
must be a valid v5 commit value.

The commit's ordinal is the number the run's order field holds when it matches
``^r?[0-9]+$`` (e.g. ``602079`` or ``r602079``), provided it fits in a 32-bit
signed integer, like every v5 ordinal. Otherwise, the commit has no ordinal. It
is an error if the runs of a commit do not agree on its ordinal, or if two
different commits have the same ordinal (e.g. ``602079`` and ``r602079``), since
v5 ordinals are unique within a suite.

Commits get no tag and no fields.

Runs
~~~~

Each v4 run becomes one v5 run submission:

- ``uuid``: the version 5 UUID of the v4 run's API URL, in the ``URL``
  namespace of RFC 9562, i.e. of ``<url>/api/db_<database>/v4/<suite>/runs/<id>``,
  where ``<url>`` and ``<database>`` are the mirror's ``source``. This scheme
  ensures that importing the same run again always names the same v5 run.
- ``machine``: the run's machine, as described above.
- ``commit``: ``value`` and, if it has one, ``ordinal``, as described above.
- ``measured_at``: the v4 run's ``end_time``, which must be an ISO 8601
  timestamp. The submission time is used if this isn't provided.
- ``run_parameters``: every key of the v4 run that is not null, except ``id``,
  ``order_id``, ``order_by``, ``start_time``, ``end_time`` and the field its
  commit is taken from.
- ``tests``: one entry per test name, in the order the names first appear among
  the v4 samples. Each v4 sample becomes one v5 sample, holding the metrics that
  are not null in it, even if that leaves none.

Each sample value must have its metric's type in the target schema.


Output
------

The command writes each run's submission to its standard output, as one line of
JSON (the JSON Lines format), in increasing order of the runs' v4 identifiers.
With ``--schema-out FILE``, it also writes the target suite's schema to
``FILE``. The schema's ``name`` is the one given with ``--target-suite``, or the
mirrored suite's name by default.

The command reports on its standard error which machines it renamed, and every
run that cannot be converted, and carries on with the next run. It exits with a
non-zero status if any run cannot be converted.

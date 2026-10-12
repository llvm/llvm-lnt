.. _mirror_v4:

Mirroring a v4 Instance
=======================

``lnt mirror-v4`` copies the contents of a running LNT v4 instance into a local
directory, the *mirror*, through the instance's REST API, and keeps that copy up
to date when it is run again. It needs nothing but read access to the instance:
no database credentials, no access to the host, and no authentication token.

The mirror is a faithful copy of what the API returns. Nothing is converted or
reinterpreted on the way in, so the mirror can be used later -- for example to
migrate the data to another LNT instance -- without having to fetch it from the
instance again, and without committing ahead of time to any particular way of
converting it.

A mirror is not a backup: it tracks the instance, so data deleted from the
instance is deleted from the mirror the next time it is refreshed (see
`Mirroring`_).


Example
-------

To mirror the ``nts`` and ``compile`` suites of ``https://lnt.llvm.org`` into
``./lnt-mirror``::

    lnt mirror-v4 https://lnt.llvm.org ./lnt-mirror --suite nts
    lnt mirror-v4 https://lnt.llvm.org ./lnt-mirror --suite compile

Running the same commands again later *refreshes* the mirror, bringing it up to
date. See ``lnt mirror-v4 --help`` for the other options.


What is mirrored
----------------

For the suite being mirrored, the mirror holds:

- the suite's schema, as reported by the instance;
- every machine, including the metadata the instance stores for it;
- every run on those machines, including its run fields and parameters, and
  every sample of every test in it.

The following are **not** mirrored, because the v4 REST API does not expose
them, or does not expose them in a form that can be copied:

- regressions, field changes, and their triage state;
- profiles;
- baselines.

The schema is recorded exactly as the instance reports it, and v4 reports some
of it inaccurately:

- v4 does not store a metric's ``display_name``, ``unit`` and ``unit_abbrev``
  in its database. It only knows them for a suite whose schema file it loads at
  startup; for any other suite, it reports the metric's name as its display
  name, and no unit.
- The ``bigger_is_better`` of metrics that predate the database migration
  introducing that setting is stored as null. v4 treats a null as false, but
  reports it as true. This affects the ``nts`` and ``compile`` suites that v4
  creates in every new database, e.g. their ``execution_time`` and
  ``compile_time`` metrics.


Mirroring
---------

After a successful refresh, the suite in the mirror matches the suite on the
instance as it was at the time of the refresh:

- Runs and machines that are new on the instance are added.
- Runs and machines that were deleted from the instance are removed from the
  mirror.
- A run that was replaced on the instance -- v4 reuses the run's identifier when
  a submission replaces an earlier one -- is fetched again.
- Every run document embeds its machine's metadata. A machine whose metadata
  changed on the instance has all of its runs fetched again.
- A suite that no longer exists on the instance is an error; the mirror is left
  untouched.


Mirror Format
-------------

A mirror is a directory with the following layout::

    MIRROR_DIR/
      manifest.json                 # the manifest
      <suite>/
        schema.json                 # GET .../<suite>/schema
        machines/<machine id>.json  # GET .../<suite>/machines/<machine id>
        runs/<run id>.json.gz       # GET .../<suite>/runs/<run id>, gzipped

All paths are relative to ``MIRROR_DIR``, and ``...`` stands for
``<URL>/api/db_<database>/v4``.

A refresh stages the files it writes in ``MIRROR_DIR/.mirror-tmp/``, and clears
that directory when it starts. Its contents are never part of the mirror.

The manifest
~~~~~~~~~~~~

``manifest.json`` is the authoritative listing of the mirror's contents: a file
it does not reference is not part of the mirror, and tools reading a mirror must
ignore it. It looks like this:

.. code-block:: json

    {
      "format_version": "1",
      "source": {
        "url": "https://lnt.llvm.org",
        "database": "default"
      },
      "suites": {
        "nts": {
          "schema": {"sha256": "..."},
          "machines": {
            "1": {
              "name": "sifive-p550-rv64gc_zba_zbb-ReleaseLTO__clang_DEV__riscv64",
              "fetched_at": "2026-09-29T15:02:11Z",
              "sha256": "...",
              "runs": {
                "601": {"sha256": "..."},
                "602": {"sha256": "..."}
              }
            }
          }
        }
      }
    }

``format_version``
  The version of this format, ``"1"``. It changes whenever the format changes in
  a way that a tool reading the previous version could misread.
  ``lnt mirror-v4`` refuses to refresh a mirror of any other version, and tools
  reading a mirror should likewise refuse a version they do not know.

``source``
  The instance the mirror was copied from: its root ``url``, without a trailing
  slash, and the ``database``.

``suites``
  One entry per mirrored suite, keyed by suite name.

``suites.<suite>.schema.sha256``
  The SHA-256 of ``<suite>/schema.json``.

``suites.<suite>.machines``
  One entry per mirrored machine, keyed by the machine's v4 identifier (a
  decimal string, since JSON keys are strings). Machines are identified by
  identifier rather than by name because v4 machine names are not unique.

``...machines.<id>.name``
  The machine's name, as the instance reported it at ``fetched_at``.

``...machines.<id>.fetched_at``
  When the machine's listing, ``<suite>/machines/<id>.json``, was fetched from
  the instance: an ISO 8601 timestamp in UTC.

``...machines.<id>.sha256``
  The SHA-256 of ``<suite>/machines/<id>.json``.

``...machines.<id>.runs``
  One entry per mirrored run of the machine, keyed by the run's v4 identifier.
  Its ``sha256`` is that of the run's JSON document, i.e. of the *decompressed*
  contents of ``<suite>/runs/<id>.json.gz``.

Every hash is the lowercase hexadecimal SHA-256 of the file's bytes exactly as
the instance sent them.

The payload
~~~~~~~~~~~

Every other file holds the body of one API response, byte for byte as the
instance sent it; run documents are additionally compressed with gzip, since
they are large and compress well. The documents are therefore in whatever form
the instance's version of LNT produces, and carry that version under
``generated_by``.

``<suite>/machines/<id>.json`` holds the machine's metadata under ``machine``,
and under ``runs`` a summary of every run the instance held for that machine
when the listing was fetched. ``<suite>/runs/<id>.json.gz`` holds the run under
``run``, its machine under ``machine``, and its samples under ``tests``, one
entry per sample.

Consistency
~~~~~~~~~~~

The manifest is only ever replaced atomically, and a refresh that stops for any
reason -- a failed request, an interruption, a crash -- leaves behind a manifest
that satisfies the following:

- Every file the manifest references exists.
- Every run listed under a machine appears in the summary of runs of that
  machine's listing -- the version of it whose hash the manifest records. The
  run's mirrored ``run`` is identical to that summary, and its mirrored
  ``machine`` to the listing's ``machine``. A run the instance holds but the
  mirror could not fetch is simply not listed.

A crash can additionally leave ``<suite>/schema.json`` or a machine's listing
with a hash that no longer matches the manifest; run documents are never
modified while the manifest references them. Tools reading a mirror should
verify the hashes, and treat a mismatch as a damaged mirror. The next refresh of
the affected suite repairs it, and removes the files in ``<suite>/machines/``
and ``<suite>/runs/`` that the manifest does not reference.

Only one refresh may use a mirror at a time; a second concurrent invocation on
the same ``MIRROR_DIR`` fails rather than wait.

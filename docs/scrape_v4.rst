.. _scrape_v4:

Archiving a v4 Instance
=======================

``lnt scrape-v4`` copies the contents of a running LNT v4 instance into a local
directory, the *archive*, through the instance's REST API. It needs nothing but
read access to the instance: no database credentials, no access to the host, and
no authentication token.

The archive is a faithful copy of what the API returns. Nothing is converted or
reinterpreted on the way in, so the archive can be used later -- for example to
migrate the data to another LNT instance -- without having to scrape the
instance again, and without committing ahead of time to any particular way of
converting it.


Usage
-----

::

    lnt scrape-v4 [OPTIONS] URL ARCHIVE_DIR --suite SUITE

``URL`` is the root of the instance, e.g. ``https://lnt.llvm.org``.
``ARCHIVE_DIR`` is created if it does not exist; if it does, it must be an
archive of the same instance and database, and it is brought up to date.

``--suite SUITE``
  The test suite to scrape. Required, and given exactly once: the v4 API offers
  no way to list an instance's suites, so they cannot be discovered. An archive
  can hold several suites, scraped by separate invocations into the same
  ``ARCHIVE_DIR``; each invocation reads and writes only the suite it names.

``--database NAME``
  The database of the instance to scrape. Defaults to ``default``. An archive
  holds a single database; scrape each database into an archive of its own.

``--machine NAME``
  Only scrape the machines with this name. May be given several times. v4 does
  not require machine names to be unique, so a name selects every machine that
  carries it. A name that matches no machine, either on the instance or in the
  archive, is an error.

``--workers N``
  How many runs to fetch concurrently. Defaults to 4. Be considerate of the
  instance being scraped.

``--dry-run``
  Report what the scrape would fetch and remove, without changing the archive.

The command exits with a non-zero status if anything could not be fetched. The
archive is left consistent regardless (see `Consistency`_), and running the same
command again resumes where it stopped.


What is scraped
---------------

For the suite being scraped, the archive holds:

- the suite's schema, as reported by the instance;
- every machine, including the metadata the instance stores for it;
- every run on those machines, including its run fields and parameters, and
  every sample of every test in it.

The following are **not** scraped, because the v4 REST API does not expose
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

Take these values from the suite's schema definition rather than from the
archive where one is available.


Mirroring
---------

The archive mirrors the instance: after a successful scrape, the archived part
of the suite matches the instance as it was at the time of the scrape.

- Runs and machines that are new on the instance are added.
- Runs and machines that were deleted from the instance are removed from the
  archive.
- A run that was replaced on the instance -- v4 reuses the run's identifier when
  a submission replaces an earlier one -- is fetched again. A replacement is
  recognised by a change in the run's summary in its machine's listing (its
  start and end times, order, and run fields), so a replacement identical to
  the run it replaces in all of those goes unnoticed.
- Every run document embeds its machine's metadata. A machine whose metadata
  changed on the instance -- it was renamed, or its fields were updated -- has
  all of its runs fetched again, and so do runs moved to another machine.
- A suite that no longer exists on the instance is an error; the archive is left
  untouched.
- Machines excluded by ``--machine``, and suites other than the one named by
  ``--suite``, are left untouched.

A scrape of an up-to-date archive fetches the suite's schema and machine
listings, and no runs.


Archive Format
--------------

An archive is a directory with the following layout::

    ARCHIVE_DIR/
      archive.json                  # the manifest
      <suite>/
        schema.json                 # GET .../<suite>/schema
        machines/<machine id>.json  # GET .../<suite>/machines/<machine id>
        runs/<run id>.json.gz       # GET .../<suite>/runs/<run id>, gzipped

All paths are relative to ``ARCHIVE_DIR``, and ``...`` stands for
``<URL>/api/db_<database>/v4``.

A scrape stages the files it writes in ``ARCHIVE_DIR/.scrape-tmp/``, and clears
that directory when it starts. Its contents are never part of the archive.

The manifest
~~~~~~~~~~~~

``archive.json`` is the authoritative listing of the archive's contents. A file
the manifest does not reference is not part of the archive, and tools reading an
archive must ignore it.

.. code-block:: json

    {
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
              "scraped_at": "2026-09-29T15:02:11Z",
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

``source``
  The instance the archive was scraped from: its root ``url``, without a
  trailing slash, and the ``database``.

``suites``
  One entry per archived suite, keyed by suite name.

``suites.<suite>.schema.sha256``
  The SHA-256 of ``<suite>/schema.json``.

``suites.<suite>.machines``
  One entry per archived machine, keyed by the machine's v4 identifier (a
  decimal string, since JSON keys are strings). Machines are identified by
  identifier rather than by name because v4 machine names are not unique.

``...machines.<id>.name``
  The machine's name, as the instance reported it at ``scraped_at``.

``...machines.<id>.scraped_at``
  When the machine's listing, ``<suite>/machines/<id>.json``, was fetched from
  the instance: an ISO 8601 timestamp in UTC.

``...machines.<id>.sha256``
  The SHA-256 of ``<suite>/machines/<id>.json``.

``...machines.<id>.runs``
  One entry per archived run of the machine, keyed by the run's v4 identifier.
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

The manifest is only ever replaced atomically, and a scrape that stops for any
reason -- a failed request, an interruption, a crash -- leaves behind a manifest
that satisfies the following:

- Every file the manifest references exists.
- Every run listed under a machine appears in the summary of runs of that
  machine's listing -- the version of it whose hash the manifest records. The
  run's archived ``run`` is identical to that summary, and its archived
  ``machine`` to the listing's ``machine``. A run the instance holds but the
  archive could not fetch is simply not listed.

A crash can additionally leave ``<suite>/schema.json`` or a machine's listing
with a hash that no longer matches the manifest; run documents are never
modified while the manifest references them. Tools reading an archive should
verify the hashes, and treat a mismatch as a damaged archive. The next scrape of
the affected suite repairs it, and removes the files in ``<suite>/machines/``
and ``<suite>/runs/`` that the manifest does not reference.

Only one scrape may use an archive at a time; a second concurrent invocation on
the same ``ARCHIVE_DIR`` fails rather than wait.

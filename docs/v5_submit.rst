.. _v5_submit:

Submitting Runs to v5
=====================

``lnt v5 submit`` submits runs to a test suite of an LNT v5 instance, through
its REST API. It reads them from a file, or from its standard input, as one v5
run submission per line (the JSON Lines format), such as
``lnt v5 convert-v4-mirror`` writes (see :ref:`convert_v4_mirror`).

A v5 suite belongs to a project, and is named by the project's name and its
own, given with ``--project`` and ``--suite``, which are both required.


Example
-------

To submit the runs in ``runs.jsonl`` to the ``nts`` suite of the ``llvm``
project of a v5 instance::

    lnt v5 submit https://lnt.example.com --project llvm --suite nts \
        --token <token> runs.jsonl

See ``lnt v5 submit --help`` for the other options.


Submission
----------

Submitting runs requires a token with ``submit`` scope, given with ``--token``
or in the ``LNT_TOKEN`` environment variable.

1. With ``--create-suite FILE``, the command first creates the suite from the
   schema in ``FILE``, in the project given with ``--project``, which requires
   a token with ``manage`` scope covering the whole project. The schema's
   ``name`` must be the suite's. It is an error if the suite already exists,
   and nothing is submitted. Without ``--create-suite``, the suite must already
   exist.

   The project must exist in either case: the command never creates one.
   Creating a project requires an instance-wide token with ``manage`` scope,
   from the Projects tab of the web UI's Admin page, or through the REST API,
   e.g.::

       curl -X POST https://lnt.example.com/api/projects \
           -H 'Authorization: Bearer <token>' \
           -H 'Content-Type: application/json' \
           -d '{"name": "llvm", "display_name": "LLVM"}'

2. With ``--skip-existing``, the command lists the runs the suite already has,
   and skips the submissions whose ``uuid`` is among them. Submitting the same
   runs again therefore only submits those that are missing, e.g. after an
   interrupted submission, or once more runs have been added to the input.
   Listing takes time proportional to the size of the suite, so it is not done
   by default. Without it, the runs the suite already has are submitted again,
   and can fail, e.g. if their machine has changed since.
3. The other runs are submitted in the order they are read, by ``--workers``
   concurrent requests. A ``409 duplicate`` response means that the run was
   submitted already, and counts as a success. Network errors, 5xx responses
   and ``409 retry`` responses are retried (see below). Any other failure, and
   any line that is not a JSON object, is reported along with its line number,
   the run's UUID, machine and commit, and the instance's message, and the
   command carries on with the next run.

The command exits with a non-zero status if any run could not be submitted.

Every request the command makes is retried on a network error, a 5xx response
or a ``409 retry`` response, up to ``--retries`` times (30 by default),
``--retry-delay`` seconds apart (10 by default): enough to ride out a redeploy
of the instance. ``--retries 0`` fails fast.


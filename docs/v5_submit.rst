.. _v5_submit:

Submitting Runs to v5
=====================

``lnt v5 submit`` submits runs to a test suite of an LNT v5 instance, through
its REST API. It reads them from a file, or from its standard input, as one v5
run submission per line (the JSON Lines format), such as
``lnt v5 convert-v4-mirror`` writes (see :ref:`convert_v4_mirror`).


Example
-------

To submit the runs in ``runs.jsonl`` to the ``nts`` suite of a v5 instance::

    lnt v5 submit https://lnt.example.com --suite nts --token <token> runs.jsonl

See ``lnt v5 submit --help`` for the other options.


Submission
----------

Submitting runs requires a token with ``submit`` scope, given with ``--token``
or in the ``LNT_V5_TOKEN`` environment variable.

1. With ``--create-suite FILE``, the command first creates the suite from the
   schema in ``FILE``, which requires a token with ``manage`` scope. The
   schema's ``name`` must be the suite's. It is an error if the suite already
   exists, and nothing is submitted. Without ``--create-suite``, the suite must
   already exist.
2. With ``--skip-existing``, the command lists the runs the suite already has,
   and skips the submissions whose ``uuid`` is among them. Submitting the same
   runs again therefore only submits those that are missing, e.g. after an
   interrupted submission, or once more runs have been added to the input.
   Listing takes time proportional to the size of the suite, so it is not done
   by default. Without it, the runs the suite already has are submitted again,
   and can fail, e.g. if their machine has changed since.
3. The other runs are submitted in the order they are read, by ``--workers``
   concurrent requests. A ``409 duplicate`` response means that the run was
   submitted already, and counts as a success. Requests that fail in a way
   worth retrying are retried (see below). Any other failure, and any line that
   is not a JSON object, is reported along with its line number, the run's
   UUID, machine and commit, and the instance's message, and the command
   carries on with the next run.

The command exits with a non-zero status if any run could not be submitted.


Retries
-------

Every request the command makes, from checking the token to submitting runs,
is retried when it fails because of the network (failing to connect, or the
connection breaking or timing out), with a 5xx response, or with a
``409 retry`` response: a concurrent change to the suite's schema, or the
deletion of the machine or commit of a run being submitted. It is retried up to
``--retries`` times (30 by default), waiting ``--retry-delay`` seconds (10 by
default) before each retry, and each retry is reported. ``--retries 0`` turns
retries off.

A request that keeps failing is therefore only given up on after at least
``--retries`` times ``--retry-delay`` seconds, and later, since its failed
attempts take time too: a CDN can take about 20 seconds to give up on an
instance that is down. The defaults ride out the few minutes it takes to
redeploy an instance, during which it answers 5xx responses.

If the instance stays down longer, the runs being submitted fail one after
another, each once its own retries are exhausted, so the command takes about
(runs left / ``--workers``) times that long to finish. It is better to
interrupt it, and to submit the same runs again with ``--skip-existing`` once
the instance is back. A lower ``--retries`` is also worth it when an instance
persistently fails some runs with 5xx responses: each such run also holds back
the runs after it until it fails, since the results are reported in input
order.

A run is submitted again when the response to its submission is lost, e.g.
because the instance went down meanwhile. A run with a ``uuid`` is then
answered ``409 duplicate``, but a run without one may be stored twice.

When the command is interrupted, it sends no more requests and stops retrying,
but waits for the requests in flight to finish, which can take about 5 minutes
for an instance that does not answer.

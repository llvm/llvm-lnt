"""D5's `{suite}.test_coverage`: the tests each machine has had samples of.

`GET /tests?machine=&metric=` asks which tests have a value for a metric on a machine, and nothing
over `{suite}.sample` can answer that cheaply: no index covers "this metric is not null", so proving
that a test has *no* such value costs a read of all of its samples, and doing that per test is a
read of the whole table. This table answers it with one row per machine and test instead.

It only ever accumulates. Run submission is its one writer, and deleting runs or commits leaves it
alone, so the filters it answers may still name a test whose samples are gone -- deleting a machine
does remove its rows, by cascade. Keeping it exact would make every deletion coordinate with the
submissions in flight for the same rows, which costs far more than a stale entry in a test picker.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence

from sqlalchemy import Connection, or_
from sqlalchemy.dialects.postgresql import insert as pg_insert

from lnt_v5.suites.registry import Suite
from lnt_v5.suites.submission import SubmittedTest


def add(
    connection: Connection,
    suite: Suite,
    machine_id: int,
    tests: Sequence[SubmittedTest],
    ids: Mapping[str, int],
) -> None:
    """Record a submission's tests, and the metrics each had a value for, in one statement.

    Read from the validated submission rather than from `{suite}.sample`: the rows were written
    from these same mappings a moment ago, and every mapping carries every declared metric, `None`
    where it has no value (see `suites/submission.py`).

    Rows go in `(machine_id, test_id)` order, so that submissions for the same machine lock them in
    the same order and cannot deadlock (O8). An existing row is rewritten only when a flag turns
    true; a machine normally reports the same tests and metrics on every run, and rewriting its rows
    each time would only churn the table.
    """
    if not tests:
        return
    coverage = suite.tables.test_coverage
    metrics = [metric.name for metric in suite.schema.metrics]
    rows = sorted(
        (
            {
                "machine_id": machine_id,
                "test_id": ids[test.name],
                **{
                    name: any(sample[name] is not None for sample in test.samples)
                    for name in metrics
                },
            }
            for test in tests
        ),
        key=lambda row: row["test_id"],
    )
    statement = pg_insert(coverage)
    keys = [coverage.c.machine_id, coverage.c.test_id]
    if not metrics:
        connection.execute(statement.on_conflict_do_nothing(index_elements=keys), rows)
        return
    connection.execute(
        statement.on_conflict_do_update(
            index_elements=keys,
            set_={name: coverage.c[name] | statement.excluded[name] for name in metrics},
            where=or_(*(statement.excluded[name] & ~coverage.c[name] for name in metrics)),
        ),
        rows,
    )

"""D5's `{suite}.test_coverage`: which tests have samples on which machine, and how many.

`GET /tests?machine=&metric=` asks which tests have a value for a metric on a machine, and nothing
over `{suite}.sample` can answer that cheaply: no index covers "this metric is not null", so proving
that a test has *no* such value costs a read of all of its samples, and doing that per test is a
read of the whole table. This table answers it with one row per machine and test instead.

It is only worth having if it is exact, so every write that adds or removes samples keeps it so in
the same transaction: `add` for a run submission, `subtract` for deleting a run or a commit, and a
foreign-key cascade for deleting a machine. Counts rather than flags are what make the subtraction
possible -- a flag cannot tell whether the samples being deleted were the last ones.

Every writer updates rows in `(machine_id, test_id)` order, so that two of them contending for the
same rows lock them in the same order and cannot deadlock (D13). A deletion additionally holds the
machines it subtracts for before touching any row here; see `hold_machines`.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence

from sqlalchemy import ColumnElement, Connection, bindparam, delete, func, select, update
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
    """Count a submission's samples in, in one statement.

    Counted from the validated submission rather than read back from `{suite}.sample`: the rows
    were written from these same mappings a moment ago, and every mapping carries every declared
    metric, `None` where it has no value (see `suites/submission.py`).
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
                "sample_count": len(test.samples),
                **{
                    name: sum(sample[name] is not None for sample in test.samples)
                    for name in metrics
                },
            }
            for test in tests
        ),
        key=lambda row: row["test_id"],
    )
    statement = pg_insert(coverage)
    counted = ["sample_count", *metrics]
    connection.execute(
        statement.on_conflict_do_update(
            index_elements=[coverage.c.machine_id, coverage.c.test_id],
            set_={name: coverage.c[name] + statement.excluded[name] for name in counted},
        ),
        rows,
    )


def hold_machines(connection: Connection, suite: Suite, machines: ColumnElement[bool]) -> None:
    """Key-share lock the machines a deletion is about to subtract coverage for, in id order.

    What keeps a deletion from deadlocking against deleting one of those machines. That cascades to
    both the machine's runs and its coverage rows, in an order PostgreSQL does not promise, while
    the deletion here needs coverage rows and then runs -- so each could end up holding what the
    other waits for. A key-share lock conflicts only with deleting the machine, which makes the
    machine's deletion wait before it cascades anything, and submissions -- which lock a machine no
    more strongly than `FOR NO KEY UPDATE` -- are not held up at all.

    Must come before the caller locks any row a machine deletion cascades to, the run being deleted
    included.
    """
    machine = suite.tables.machine
    connection.execute(
        select(machine.c.id).where(machines).order_by(machine.c.id).with_for_update(key_share=True)
    ).all()


def subtract(connection: Connection, suite: Suite, runs: ColumnElement[bool]) -> None:
    """Count out the samples of the runs matching `runs`, which the caller is about to delete.

    Must run before the delete, because the cascade takes the samples with it. The caller must also
    already hold the machines involved (`hold_machines`), and a lock on the run or commit it
    deletes: a submission still in flight for that commit would otherwise have samples this count
    cannot see, but that the cascade -- which reads the latest committed state -- would then delete
    uncounted.

    Three statements, however many runs and tests: the counts are read in one, subtracted in one
    executemany in `(machine_id, test_id)` order, and the rows left with no samples removed in one.
    """
    coverage, sample, run = suite.tables.test_coverage, suite.tables.sample, suite.tables.run
    metrics = [metric.name for metric in suite.schema.metrics]
    counts = connection.execute(
        select(
            run.c.machine_id,
            sample.c.test_id,
            func.count(),
            *(func.count(sample.c[name]) for name in metrics),
        )
        .select_from(sample.join(run, run.c.id == sample.c.run_id))
        .where(runs)
        .group_by(run.c.machine_id, sample.c.test_id)
        .order_by(run.c.machine_id, sample.c.test_id)
    ).all()
    if not counts:
        return

    # Bound under names of their own: SQLAlchemy reserves a column's own name for the value an
    # UPDATE sets it to, and a metric may be called anything.
    counted = ["sample_count", *metrics]
    connection.execute(
        update(coverage)
        .where(
            coverage.c.machine_id == bindparam("machine"),
            coverage.c.test_id == bindparam("test"),
        )
        .values(
            {
                name: coverage.c[name] - bindparam(f"count_{index}")
                for index, name in enumerate(counted)
            }
        ),
        [
            {
                "machine": row[0],
                "test": row[1],
                **{f"count_{index}": row[2 + index] for index in range(len(counted))},
            }
            for row in counts
        ],
    )
    connection.execute(
        delete(coverage).where(
            coverage.c.machine_id.in_(sorted({row[0] for row in counts})),
            coverage.c.sample_count == 0,
        )
    )

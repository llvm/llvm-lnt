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
from typing import Any

from sqlalchemy import ColumnCollection, ColumnElement, Connection, Insert, and_, or_, select
from sqlalchemy.dialects.postgresql import insert as pg_insert

from lnt_v5.suites.bulk import unnest_rows
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

    A row that already holds everything the submission would add is neither rewritten nor locked, so
    that a machine's submissions, which usually report the same tests and metrics, do not queue
    behind each other (O8).
    """
    if not tests:
        return
    connection.execute(
        suite.derived(_upsert),
        {
            "machine_id": machine_id,
            "test_id": [ids[test.name] for test in tests],
            **{
                metric.name: [
                    any(sample[metric.name] is not None for sample in test.samples)
                    for test in tests
                ]
                for metric in suite.schema.metrics
            },
        },
    )


def _upsert(suite: Suite) -> Insert:
    """The statement `add` writes with, built once per suite (see `Suite.derived`).

    It reads the stored rows without a lock, and only passes on to the upsert the rows that are
    missing or would gain a flag. Skipping the others on a read that may already be stale is safe
    because flags only ever turn true: a row can only have gained flags since, so one that held
    everything then still does. A row the read shows less covered than it is goes through
    `ON CONFLICT` as if nothing were skipped, which settles a race with another submission.

    Nor can a row the read saw disappear before the transaction ends. Only deleting the machine
    deletes rows, and the run inserted before this holds a key-share lock on the machine through its
    foreign key, so that deletion either happened first, failing the run insert, or waits for us.
    """
    coverage = suite.tables.test_coverage
    metrics = [metric.name for metric in suite.schema.metrics]
    submitted = unnest_rows(coverage, ["test_id", *metrics], constants=["machine_id"]).subquery("s")
    stored = coverage.alias("c")

    def gains(
        new: ColumnCollection[str, Any], old: ColumnCollection[str, Any]
    ) -> list[ColumnElement[bool]]:
        return [new[name] & ~old[name] for name in metrics]

    rows = (
        select(submitted)
        .outerjoin(
            stored,
            and_(
                stored.c.machine_id == submitted.c.machine_id,
                stored.c.test_id == submitted.c.test_id,
            ),
        )
        .where(or_(stored.c.test_id.is_(None), *gains(submitted.c, stored.c)))
        # The order the rows are locked in (O8); `machine_id` is the same for all of them.
        .order_by(submitted.c.test_id)
    )
    statement = pg_insert(coverage).from_select(["machine_id", "test_id", *metrics], rows)
    keys = [coverage.c.machine_id, coverage.c.test_id]
    if not metrics:
        # Nothing to gain, so an existing row is never written, and `DO NOTHING` locks none.
        return statement.on_conflict_do_nothing(index_elements=keys)
    # The filter again, against the row `ON CONFLICT` locked: only in a race can it differ.
    return statement.on_conflict_do_update(
        index_elements=keys,
        set_={name: coverage.c[name] | statement.excluded[name] for name in metrics},
        where=or_(*gains(statement.excluded, coverage.c)),
    )

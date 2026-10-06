"""The sequence of changes to what code decides about a suite's tables (D6).

`suites/tables.py` describes the tables a suite is created with, and everything about them but which
dynamic columns they carry is decided by code. A later build may change any of that. Each
change also needs a step here that brings an existing suite from the structure before it to the
structure after it, because a suite created by an earlier build keeps the tables that build gave it.
`migrate.py` runs the outstanding steps of every suite at startup, and records each suite's position
in `schema.migration_version`.

A suite is at version N once it has been through the first N steps. Version 0 is the structure as
it stood before the first step was written. Steps are only ever appended: once released, a step may
already have run against some database, so editing, reordering or removing one leaves those
databases disagreeing with the code. `tests/data/migration_snapshots/` holds a snapshot of the
structure at every version, checked by `test_suite_migrations.py`, which is what makes a change to
`suites/tables.py` without a step fail a test. The snapshots hold structure only, so a step that
moves data needs a test of its own for that.

A step is frozen in the same way as a global revision is (see `migrations/versions/`): it spells
out its types and constraint names literally rather than taking them from `suites/tables.py`, which
describes the structure as of the *latest* step. It is given an Alembic `Operations` bound to the
suite's transaction -- pass `schema=suite.name` to each operation, since nothing qualifies table
names for you -- and the suite's schema, since what it changes may depend on which dynamic columns
exist. It may move data as well as change structure. The server does not start until every suite
has been through its steps, and `{suite}.sample` may hold many millions of rows, so move data with
set-based SQL rather than row by row, and expect a change that rewrites a large table to cost
downtime in proportion.
"""

from __future__ import annotations

from collections.abc import Callable, Sequence

from alembic.operations import Operations

from lnt_v5.suites.schema import SuiteSchema

Step = Callable[[Operations, SuiteSchema], None]

STEPS: Sequence[Step] = ()


def head() -> int:
    """The version a suite is at once it has been through every step this build knows.

    Read through a function rather than a constant, so that the tests exercising the mechanism can
    substitute their own steps.
    """
    return len(STEPS)

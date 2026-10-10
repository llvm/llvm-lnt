"""The migration steps for a suite's tables (D6).

`suites/tables.py` describes the tables a suite is created with. Apart from which dynamic columns
exist, everything about them is decided by code, and a later build may change it. Each such change
needs a step here, because suites created by an earlier build keep the tables that build gave them.
The step takes an existing suite from the structure before the change to the structure after it.
`migrate.py` runs each suite's outstanding steps at startup, and records in
`schema.migration_version` how many steps each suite has had.

A suite is at version N once the first N steps have been applied to it. Version 0 is the structure
from before the first step was written. Only ever add steps at the end: a released step may already
have run against some database, so editing, reordering or removing it would leave that database out
of sync with the code. `tests/data/migration_snapshots/` holds a snapshot of the structure at every
version, and `test_suite_migrations.py` checks against them, so changing `suites/tables.py` without
adding a step makes a test fail. The snapshots only cover structure, so a step that changes data
needs its own test.

Like a global revision (see `migrations/versions/`), a step is frozen: it spells out its types and
constraint names rather than taking them from `suites/tables.py`, which always describes the latest
structure. A step receives two arguments:

- An Alembic `Operations` object bound to the suite's transaction. Pass `schema=suite.name` to each
  operation; nothing qualifies table names for you.
- The suite's schema, because what the step changes may depend on which dynamic columns the suite
  has.

A step may update data as well as change the tables. The server doesn't start until every suite has
been migrated, and `{suite}.sample` can hold many millions of rows. So update data with set-based
SQL rather than row by row, and expect a step that rewrites a large table to make the deployment
take correspondingly longer.
"""

from __future__ import annotations

from collections.abc import Callable, Sequence

import sqlalchemy as sa
from alembic.operations import Operations

from lnt_v5.suites.schema import SuiteSchema

Step = Callable[[Operations, SuiteSchema], None]


def _run_uuid_collation(op: Operations, suite: SuiteSchema) -> None:
    """Version 1: `{suite}.run.uuid` in the "C" collation (D5).

    PostgreSQL rebuilds the unique index on the column, without rewriting the table.
    """
    op.alter_column(
        "run",
        "uuid",
        existing_type=sa.String(36),
        type_=sa.String(36, collation="C"),
        existing_nullable=False,
        schema=suite.name,
    )


def _regression_commit_set_null(op: Operations, suite: SuiteSchema) -> None:
    """Version 2: deleting a commit sets `{suite}.regression.commit_id` to null (D5).

    PostgreSQL cannot change a foreign key's action in place, so the key is dropped and created
    again, which checks the regressions against the commits once.
    """
    name = "fk_regression_commit_id_commit"
    op.drop_constraint(name, "regression", type_="foreignkey", schema=suite.name)
    op.create_foreign_key(
        name,
        "regression",
        "commit",
        ["commit_id"],
        ["id"],
        ondelete="SET NULL",
        source_schema=suite.name,
        referent_schema=suite.name,
    )


STEPS: Sequence[Step] = (_run_uuid_collation, _regression_commit_set_null)


def head() -> int:
    """The version of a suite that has had every step this build knows.

    Read through a function rather than a constant, so that the tests exercising the mechanism can
    substitute their own steps.
    """
    return len(STEPS)

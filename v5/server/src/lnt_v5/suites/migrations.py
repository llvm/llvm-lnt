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
structure of a suite's tables. The one exception is how a suite's namespace is named and labelled,
which a step may take from `suites/tables.py` (`new_namespace` and `label`): that depends only on
the global tables, which are always at the latest revision when steps run (D6). So those two must
stay callable inside a suite's migration transaction, and assume nothing about the suite's tables.

For the same reason, what a step reads or writes in the global tables follows their latest
structure, not the structure they had when the step was written: a step addresses the suite's
`schema` row by its id, say, since a name is unique only within its project (D7).

A step receives two arguments:

- An Alembic `Operations` object bound to the suite's transaction.
- The suite (`store.StoredSuite`): its identity and names, its schema, since what a step changes
  may depend on its dynamic columns, and the namespace its tables are in, which is not necessarily
  its name (D5). Pass `schema=suite.namespace` to each operation; nothing qualifies table names for
  you.

A step may move the suite to another namespace, by renaming it and recording the new one in
`schema.namespace` (D6). `migrate.py` then hands the later steps the new namespace.

A step may update data as well as change the tables. The server doesn't start until every suite has
been migrated, and `{suite}.sample` can hold many millions of rows. So update data with set-based
SQL rather than row by row, and expect a step that rewrites a large table to make the deployment
take correspondingly longer.
"""

from __future__ import annotations

from collections.abc import Callable, Sequence
from typing import TYPE_CHECKING, Any

import sqlalchemy as sa
from alembic.operations import Operations

from lnt_v5.suites import tables as suite_tables

if TYPE_CHECKING:
    # Only for annotations: `store` imports this module.
    from lnt_v5.suites.store import StoredSuite

type Step = Callable[[Operations, StoredSuite], None]


def _run_uuid_collation(op: Operations, suite: StoredSuite) -> None:
    """Version 1: `{suite}.run.uuid` in the "C" collation (D5).

    PostgreSQL rebuilds the unique index on the column, without rewriting the table.
    """
    op.alter_column(
        "run",
        "uuid",
        existing_type=sa.String(36),
        type_=sa.String(36, collation="C"),
        existing_nullable=False,
        schema=suite.namespace,
    )


def _regression_commit_set_null(op: Operations, suite: StoredSuite) -> None:
    """Version 2: deleting a commit sets `{suite}.regression.commit_id` to null (D5).

    PostgreSQL cannot change a foreign key's action in place, so the key is dropped and created
    again, which checks the regressions against the commits once.
    """
    name = "fk_regression_commit_id_commit"
    op.drop_constraint(name, "regression", type_="foreignkey", schema=suite.namespace)
    op.create_foreign_key(
        name,
        "regression",
        "commit",
        ["commit_id"],
        ["id"],
        ondelete="SET NULL",
        source_schema=suite.namespace,
        referent_schema=suite.namespace,
    )


def _run_measured_at(op: Operations, suite: StoredSuite) -> None:
    """Version 3: `{suite}.run.measured_at`, and the indexes ordering runs by it (D5).

    Existing runs were all measured when they were submitted, as far as anything recorded says, so
    they get their `submitted_at`. The old index is dropped before the backfill and the new ones
    created after it, so that the UPDATE maintains none of them.
    """
    op.drop_index("ix_run_machine_id_submitted_at", table_name="run", schema=suite.namespace)
    op.add_column(
        "run",
        sa.Column("measured_at", sa.DateTime(timezone=True), nullable=True),
        schema=suite.namespace,
    )
    run = sa.table(
        "run",
        sa.column("submitted_at", sa.DateTime(timezone=True)),
        sa.column("measured_at", sa.DateTime(timezone=True)),
        schema=suite.namespace,
    )
    op.execute(run.update().values(measured_at=run.c.submitted_at))
    op.alter_column(
        "run",
        "measured_at",
        existing_type=sa.DateTime(timezone=True),
        nullable=False,
        server_default=sa.text("now()"),
        schema=suite.namespace,
    )
    op.create_index(
        "ix_run_machine_id_measured_at",
        "run",
        ["machine_id", "measured_at"],
        schema=suite.namespace,
    )
    op.create_index("ix_run_measured_at_id", "run", ["measured_at", "id"], schema=suite.namespace)


def _run_summary_columns(op: Operations, suite: StoredSuite) -> None:
    """Version 4: one `{suite}.run_summary` row per run and metric, with a geomean column per sample
    aggregation, rather than one row per aggregation (D5).

    The rows are pivoted into a new table, which then replaces the old one, so that the space the
    old one took is freed at once. In this order, for two reasons:

    - The key columns are created nullable, and only made NOT NULL by the primary key, added after
      the rename. PostgreSQL 18 names a NOT NULL constraint after its table, and renaming the table
      does not rename the constraint, so declaring them NOT NULL up front would leave a name that a
      new suite does not have.
    - `pk_run_summary` also names the key's index, and index names are unique in a namespace, so
      the key can only be added once the old table, and its index of that name, are gone. Building
      it after the rows are in is also cheaper than maintaining it row by row.
    """
    aggregations = ("median", "mean", "min", "max")
    new = op.create_table(
        "run_summary_new",
        sa.Column("run_id", sa.Integer()),
        sa.Column("metric_id", sa.Integer()),
        *(sa.Column(f"geomean_{aggregation}", sa.Double()) for aggregation in aggregations),
        schema=suite.namespace,
    )
    old = sa.table(
        "run_summary",
        sa.column("run_id"),
        sa.column("metric_id"),
        sa.column("sample_agg"),
        sa.column("geomean"),
        schema=suite.namespace,
    )
    # The old key allowed one row per run, metric and aggregation, so each `min` picks out that one
    # row's geomean, or null if there is none. Inserted in key order, so that a run's rows sit
    # together, as submissions leave them.
    pivot = (
        sa.select(
            old.c.run_id,
            old.c.metric_id,
            *(
                sa.func.min(old.c.geomean).filter(old.c.sample_agg == aggregation)
                for aggregation in aggregations
            ),
        )
        .group_by(old.c.run_id, old.c.metric_id)
        .order_by(old.c.run_id, old.c.metric_id)
    )
    op.execute(new.insert().from_select(list(new.c.keys()), pivot))
    op.drop_table("run_summary", schema=suite.namespace)
    op.rename_table("run_summary_new", "run_summary", schema=suite.namespace)
    op.create_primary_key(
        "pk_run_summary", "run_summary", ["run_id", "metric_id"], schema=suite.namespace
    )
    for column, referent in (("run_id", "run"), ("metric_id", "metric")):
        op.create_foreign_key(
            f"fk_run_summary_{column}_{referent}",
            "run_summary",
            referent,
            [column],
            ["id"],
            ondelete="CASCADE",
            source_schema=suite.namespace,
            referent_schema=suite.namespace,
        )


def _inactivity_columns(op: Operations, suite: StoredSuite) -> None:
    """Version 5: `first_seen_at` and `delete_after_inactive_days` on `{suite}.machine` and
    `{suite}.commit`, and the indexes O10 finds due machines and commits through (D5).

    Nothing recorded says when an existing machine or commit was first seen, so they get the time
    of the migration: `now()` is stable within the transaction, so PostgreSQL stores it as the
    column's default for the existing rows rather than rewriting the table. None of them has the
    setting, so none is deleted on that account.
    """
    for table in ("machine", "commit"):
        op.add_column(
            table,
            sa.Column(
                "first_seen_at",
                sa.DateTime(timezone=True),
                nullable=False,
                server_default=sa.text("now()"),
            ),
            schema=suite.namespace,
        )
        op.add_column(
            table,
            sa.Column("delete_after_inactive_days", sa.Integer(), nullable=True),
            schema=suite.namespace,
        )
        op.create_check_constraint(
            f"ck_{table}_delete_after_inactive_days",
            table,
            "delete_after_inactive_days BETWEEN 1 AND 36500",
            schema=suite.namespace,
        )
    op.create_index(
        "ix_commit_delete_after_inactive_days",
        "commit",
        ["delete_after_inactive_days"],
        schema=suite.namespace,
        postgresql_where=sa.text("delete_after_inactive_days IS NOT NULL"),
    )
    op.create_index(
        "ix_run_machine_id_submitted_at",
        "run",
        ["machine_id", "submitted_at"],
        schema=suite.namespace,
    )


def _sample_repetition(op: Operations, suite: StoredSuite) -> None:
    """Version 6: `{suite}.sample` keyed by `(run_id, test_id, repetition)` rather than by `id`
    (D5).

    `repetition` is a sample's position among its test's samples in the submission. Each run's
    samples were inserted by a single `unnest` statement, in submission order, so ordering a run's
    samples of a test by `id` recovers it.

    The rows are copied into a new table that replaces the old one, as in version 4 and for its
    reasons. Altering the table in place would also leave the dropped `id` taking its space in
    every existing row.

    A suite whose schema declares a metric named `repetition` cannot be migrated: like any entry
    named after a built-in column, it is refused before any suite is migrated (D6).
    """
    # D3's mapping from a metric's type to its column, as it stands at this version.
    types: dict[str, sa.types.TypeEngine[Any]] = {
        "real": sa.Double(),
        "integer": sa.BigInteger(),
        "text": sa.Text(),
        "datetime": sa.DateTime(timezone=True),
    }
    metrics = [metric.name for metric in suite.schema.metrics]
    new = op.create_table(
        "sample_new",
        sa.Column("run_id", sa.Integer()),
        sa.Column("test_id", sa.Integer()),
        sa.Column("repetition", sa.Integer()),
        *(sa.Column(metric.name, types[metric.type.value]) for metric in suite.schema.metrics),
        schema=suite.namespace,
    )
    old = sa.table(
        "sample",
        *(sa.column(name) for name in ("id", "run_id", "test_id", *metrics)),
        schema=suite.namespace,
    )
    repetition = (
        sa.func.row_number().over(partition_by=(old.c.run_id, old.c.test_id), order_by=old.c.id) - 1
    )
    copy = sa.select(
        old.c.run_id, old.c.test_id, repetition, *(old.c[name] for name in metrics)
    ).order_by(old.c.run_id, old.c.test_id, old.c.id)
    op.execute(new.insert().from_select(list(new.c.keys()), copy))
    op.drop_table("sample", schema=suite.namespace)
    op.rename_table("sample_new", "sample", schema=suite.namespace)
    op.create_primary_key(
        "pk_sample", "sample", ["run_id", "test_id", "repetition"], schema=suite.namespace
    )
    op.create_index(
        "ix_sample_test_id_run_id", "sample", ["test_id", "run_id"], schema=suite.namespace
    )
    for column, referent, ondelete in (("run_id", "run", "CASCADE"), ("test_id", "test", None)):
        op.create_foreign_key(
            f"fk_sample_{column}_{referent}",
            "sample",
            referent,
            [column],
            ["id"],
            ondelete=ondelete,
            source_schema=suite.namespace,
            referent_schema=suite.namespace,
        )


def _generated_namespace(op: Operations, suite: StoredSuite) -> None:
    """Version 7: the suite's tables in a namespace the server chose, as a new suite's are (D5).

    Suites from before namespaces were recorded are in the one named after them, which a later
    rename of the suite would leave looking like its name. The namespace is renamed, which moves
    the tables without touching them, and labelled as a new suite's is.

    Unlike the other steps, this one takes its naming from `suites/tables.py` rather than spelling
    it out (see above): whatever names the namespaces of new suites should name these too.

    The registry caches each suite's namespace, so moving it bumps `schema_version`, as any change
    to a cached suite does (D2).

    A suite whose namespace was dropped out of band while its row stayed cannot be renamed, and
    stops the migrations, as any earlier step would on its tables.
    """
    connection = op.get_bind()
    namespace = suite_tables.new_namespace(connection)
    quote = connection.dialect.identifier_preparer.quote
    op.execute(sa.text(f"ALTER SCHEMA {quote(suite.namespace)} RENAME TO {quote(namespace)}"))
    suite_tables.label(connection, namespace, suite.full_name)
    schema = sa.table("schema", sa.column("id"), sa.column("namespace"))
    op.execute(schema.update().where(schema.c.id == suite.id).values(namespace=namespace))
    schema_version = sa.table("schema_version", sa.column("id"), sa.column("version"))
    op.execute(
        schema_version.update()
        .where(schema_version.c.id == 1)
        .values(version=schema_version.c.version + 1)
    )


def _full_name_label(op: Operations, suite: StoredSuite) -> None:
    """Version 8: the suite's namespace labelled with the suite's full name (D7), `project/suite`,
    as a new suite's is.

    The label is for whoever reads the database directly, and changes nothing a worker caches, so
    unlike version 7 this does not bump `schema_version`. Like version 7, it takes the label from
    `suites/tables.py`.
    """
    suite_tables.label(op.get_bind(), suite.namespace, suite.full_name)


STEPS: Sequence[Step] = (
    _run_uuid_collation,
    _regression_commit_set_null,
    _run_measured_at,
    _run_summary_columns,
    _inactivity_columns,
    _sample_repetition,
    _generated_namespace,
    _full_name_label,
)


def head() -> int:
    """The version of a suite that has had every step this build knows.

    Read through a function rather than a constant, so that the tests exercising the mechanism can
    substitute their own steps.
    """
    return len(STEPS)

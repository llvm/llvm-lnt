"""A suite's own tables (D5), built from its schema, and the DDL that puts them in the database.

Which dynamic columns a suite's tables have depends on the suite's schema, so no migration written
in advance could describe them (D6). The suite endpoints create and alter them at runtime, using
this module.

Everything else about these tables is decided by the code here, which describes the structure after
the latest step in `suites/migrations.py`. Any change to it needs a new step there too, so that
existing suites are migrated to match.

Each suite's tables live in a PostgreSQL namespace of their own, the one recorded in the suite's
`schema` row (D5), so a table is addressed as `{suite}.commit`: the `commit` table in that
namespace. That is what lets every suite carry *identical* constraint names: the naming convention
composes a name from a table and its columns, neither of which mentions the suite, so
`uq_commit_ordinal` is the name in every suite and the code that attributes a unique-constraint
violation (O8) can write it out rather than compose it per request.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any

from sqlalchemy import (
    BigInteger,
    Boolean,
    CheckConstraint,
    Column,
    Connection,
    DateTime,
    Double,
    ForeignKey,
    Identity,
    Index,
    Integer,
    LargeBinary,
    MetaData,
    String,
    Table,
    Text,
    UniqueConstraint,
    cast,
    column,
    delete,
    exists,
    false,
    func,
    insert,
    literal,
    or_,
    select,
    table,
    text,
    true,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.schema import CreateColumn
from sqlalchemy.types import TypeEngine

from lnt_v5.suites.aggregation import SampleAggregation
from lnt_v5.suites.schema import AttributeType, Entry, SuiteSchema
from lnt_v5.suites.states import RegressionState
from lnt_v5.tables import IDENTIFIER_MAX_LENGTH, NAMING_CONVENTION, namespace_sequence
from lnt_v5.tables import schema as schema_table

# D5's widths for the built-in string columns. A UUID is the 36-character hyphenated form (O1).
# Deliberately not shared with `api_key.name`'s identical width in tables.py: D5 states these per
# column, and the two would then have to change together for no reason.
NAME_LENGTH = 256
UUID_LENGTH = 36

# What NAMING_CONVENTION names the constraints the endpoints have to name: to attribute a violation
# after the fact, and so answer the specific 409 I4 gives it rather than a 500, or to point an
# `ON CONFLICT` at. Written out because they are fixed -- the convention composes a name from a
# table and its columns, neither of which mentions the suite -- and checked against what PostgreSQL
# reports by `test_suite_tables.py`, so a convention change fails a test rather than silently
# turning a 409 into a 500. The same arrangement as `store.SCHEMA_NAME_CONSTRAINT`.
MACHINE_NAME_CONSTRAINT = "uq_machine_name"
COMMIT_VALUE_CONSTRAINT = "uq_commit_commit"
COMMIT_ORDINAL_CONSTRAINT = "uq_commit_ordinal"
RUN_UUID_CONSTRAINT = "uq_run_uuid"
# A run's references to its machine and its commit. A violation means the machine or the commit was
# deleted after the submission resolved it -- by its DELETE route, or by O10's sweep -- which O8
# answers with I4's `retry`: resending the submission creates it again.
RUN_MACHINE_CONSTRAINT = "fk_run_machine_id_machine"
RUN_COMMIT_CONSTRAINT = "fk_run_commit_id_commit"
REGRESSION_UUID_CONSTRAINT = "uq_regression_uuid"
# Not a unique constraint but a foreign key. Storing a reference to a commit deleted after the
# request resolved it violates it, which is a 404: the commit is no longer there.
REGRESSION_COMMIT_CONSTRAINT = "fk_regression_commit_id_commit"
# The one named as an `ON CONFLICT` target rather than attributed after the fact: adding an
# indicator a regression already has is the silent no-op endpoints.md asks for. Named explicitly
# because the convention would compose it from all four columns, past PostgreSQL's 63-byte limit.
REGRESSION_INDICATOR_CONSTRAINT = "uq_regression_indicator_combination"
# An indicator's reference to its metric. A violation means the metric was removed while the request
# was running, which D2 answers with I4's `retry`.
REGRESSION_INDICATOR_METRIC_CONSTRAINT = "fk_regression_indicator_metric_id_metric"
# An indicator's reference to its machine. A violation means the machine was deleted after the
# request resolved it, which leaves the request naming a machine that is not there: a 404.
REGRESSION_INDICATOR_MACHINE_CONSTRAINT = "fk_regression_indicator_machine_id_machine"
# An indicator's reference to its regression. A violation means the regression was deleted after the
# request resolved it: a 404, for the same reason.
REGRESSION_INDICATOR_REGRESSION_CONSTRAINT = "fk_regression_indicator_regression_id_regression"


# D3's mapping from a declared type to the column that stores it. `Double` rather than `Float`
# because D3 names DOUBLE PRECISION specifically, and SQLAlchemy's `Float` is REAL on PostgreSQL --
# single precision, which would quietly round every sample. `BigInteger` because a 32-bit INTEGER
# overflows at about 2.1 billion, which counters such as retired instructions routinely exceed.
#
# The instances are shared across every column and every suite. That is safe because none of these
# four is a `SchemaType`: nothing binds them to a parent column, so no column can mutate them. It
# does not extend to `Identity()`, `ForeignKey(...)` or the constraints below, which do bind to
# their parent and must be constructed per call.
_COLUMN_TYPES: dict[AttributeType, TypeEngine[Any]] = {
    AttributeType.REAL: Double(),
    AttributeType.INTEGER: BigInteger(),
    AttributeType.TEXT: Text(),
    AttributeType.DATETIME: DateTime(timezone=True),
}

# The range PostgreSQL's BIGINT holds, and so the range of an `integer` value (D3). Beside the
# mapping above because it follows from it: a change to the column type must change these too.
INTEGER_MIN = -(2**63)
INTEGER_MAX = 2**63 - 1

# The range PostgreSQL's INTEGER holds -- the type of `{suite}.commit.ordinal`, which D5 makes an
# INTEGER rather than following D3's `integer`: it is a built-in column, not a declared one, so the
# BIGINT above does not apply to it. Also what `querying` checks an INTEGER cursor value against.
INT32_MIN = -(2**31)
INT32_MAX = 2**31 - 1

# The range of `delete_after_inactive_days` on `{suite}.machine` and `{suite}.commit` (D5). Bounded
# well inside the INTEGER column, because O10 subtracts that many days from the current time, and a
# number of days near INT32_MAX takes the result millions of years outside what a timestamp holds.
# A hundred years is already "never" for every practical purpose.
INACTIVE_DAYS_MIN = 1
INACTIVE_DAYS_MAX = 36500


def geomean_column(aggregation: SampleAggregation) -> str:
    """The `{suite}.run_summary` column holding a run's geomean under `aggregation` (D5)."""
    return f"geomean_{aggregation}"


def _flags(metrics: Sequence[Entry]) -> list[Column[Any]]:
    """One flag per metric on `{suite}.test_coverage`, whatever the metric's own type (D5).

    Not nullable, and false by default, so that adding a metric gives every existing row a flag
    that is already right: nothing has a value for a metric that did not exist.
    """
    return [
        Column(metric.name, Boolean, nullable=False, server_default=false()) for metric in metrics
    ]


def _dynamic(entries: Sequence[Entry]) -> list[Column[Any]]:
    """The columns a schema's `metrics`, `commit_fields` or `machine_fields` become.

    All nullable: a schema change may add an entry at any time, which leaves every existing row
    with no value for it (D2), and a submission need not carry every declared field (O2).
    """
    return [Column(entry.name, _COLUMN_TYPES[entry.type], nullable=True) for entry in entries]


def _inactivity_columns() -> list[Column[Any]]:
    """The two built-in columns O10 reads, which `{suite}.machine` and `{suite}.commit` share (D5).

    `first_seen_at` is the database's clock rather than the application's, like `run.submitted_at`,
    which it is compared with: an entity's last activity is its latest run's `submitted_at`, or
    this when it has no run.
    """
    return [
        Column("first_seen_at", DateTime(timezone=True), nullable=False, server_default=func.now()),
        Column("delete_after_inactive_days", Integer, nullable=True),
    ]


def _inactive_days_range() -> CheckConstraint:
    """D5's range for `delete_after_inactive_days`, which the API enforces too (see entities.py)."""
    return CheckConstraint(
        f"delete_after_inactive_days BETWEEN {INACTIVE_DAYS_MIN} AND {INACTIVE_DAYS_MAX}",
        name="delete_after_inactive_days",
    )


@dataclass(frozen=True)
class SuiteTables:
    """All of one suite's tables, and the metadata describing them together.

    Held as named attributes rather than looked up by string so that the query code reads as
    `tables.sample.c.run_id`, and so that a typo is a type error.
    """

    metadata: MetaData
    commit: Table
    machine: Table
    metric: Table
    run: Table
    test: Table
    sample: Table
    test_coverage: Table
    regression: Table
    regression_indicator: Table
    profile: Table
    profile_function: Table
    run_summary: Table

    @property
    def namespace(self) -> str:
        """The namespace the tables live in (D5).

        Derived rather than stored: `MetaData(schema=...)` is what actually places the tables, so a
        separate copy could only ever disagree with it.
        """
        return str(self.metadata.schema)


def build(schema: SuiteSchema, namespace: str) -> SuiteTables:
    """The tables D5 specifies for a suite with this schema, in this namespace.

    Pure: it describes the tables without touching a database. `create` is what puts them there.
    """
    # `schema=` on the MetaData is what places every table in the suite's namespace, and what makes
    # the unqualified foreign-key targets below resolve within it.
    metadata = MetaData(schema=namespace, naming_convention=NAMING_CONVENTION)

    commit = Table(
        "commit",
        metadata,
        Column("id", Integer, Identity(), primary_key=True),
        Column("commit", String(NAME_LENGTH), nullable=False, unique=True),
        # O6: a regular, non-deferred unique constraint. Ordinals are assigned once and rarely
        # reassigned, so a write that would give two commits the same one is simply rejected (409).
        Column("ordinal", Integer, nullable=True, unique=True),
        Column("tag", String(NAME_LENGTH), nullable=True),
        *_inactivity_columns(),
        *_dynamic(schema.commit_fields),
        _inactive_days_range(),
    )
    # Partial, because the column is null on almost every row: only a handful of commits (releases,
    # say) carry a tag, and an index over the nulls would be most of the table for no lookups.
    Index(None, commit.c.tag, postgresql_where=commit.c.tag.is_not(None))
    # Partial for the same reason: O10's sweep enumerates the commits that have the setting, which
    # are the few experiments among a table that can hold hundreds of thousands of commits, and it
    # must not scan the table to find them. Machines need no such index, since a suite has few.
    Index(
        None,
        commit.c.delete_after_inactive_days,
        postgresql_where=commit.c.delete_after_inactive_days.is_not(None),
    )

    machine = Table(
        "machine",
        metadata,
        Column("id", Integer, Identity(), primary_key=True),
        Column("name", String(NAME_LENGTH), nullable=False, unique=True),
        # D5: governs automatic machine selection only. Untracked machines stay fully addressable.
        Column("tracked", Boolean, nullable=False, server_default=true()),
        *_inactivity_columns(),
        *_dynamic(schema.machine_fields),
        _inactive_days_range(),
    )

    # D5: the metrics the schema declares, as rows, so that what refers to a metric can do so by
    # foreign key. Identity only: everything else about a metric stays in the stored schema.
    metric = Table(
        "metric",
        metadata,
        Column("id", Integer, Identity(), primary_key=True),
        Column("name", String(IDENTIFIER_MAX_LENGTH), nullable=False, unique=True),
    )

    run = Table(
        "run",
        metadata,
        Column("id", Integer, Identity(), primary_key=True),
        # "C", so that the unique index also serves O4's search by prefix (D5).
        Column("uuid", String(UUID_LENGTH, collation="C"), nullable=False, unique=True),
        Column("machine_id", ForeignKey("machine.id", ondelete="CASCADE"), nullable=False),
        Column(
            "commit_id",
            ForeignKey("commit.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        # The database's clock rather than the application's, so that concurrent workers agree on
        # ordering. A submission cannot supply this (O1).
        Column("submitted_at", DateTime(timezone=True), nullable=False, server_default=func.now()),
        # A submission that omits it gets its `submitted_at` (D5): PostgreSQL fixes `now()` for the
        # whole transaction, so the two defaults are the same instant.
        Column("measured_at", DateTime(timezone=True), nullable=False, server_default=func.now()),
        Column("run_parameters", JSONB, nullable=False, server_default=text("'{}'::jsonb")),
    )
    # D5: the leading column serves `GET /runs?machine=`, and the pair keeps both its
    # `sort=-measured_at` and the derived `last_run_at` to a bounded index scan rather than a scan
    # of this table.
    Index(None, run.c.machine_id, run.c.measured_at)
    # D5: O10's check of whether a machine has had a run submitted since a given time, which has to
    # be one probe however long the machine's history. The index above cannot answer it without
    # reading every run of the machine.
    Index(None, run.c.machine_id, run.c.submitted_at)
    # D5: the suite-wide run list's `?sort=-submitted_at` and `?sort=-measured_at`, with no machine
    # to narrow them. `id` joins each because the keyset's tiebreaker is `id`, and only an index
    # over both turns the cursor's row comparison into an index condition rather than a filter
    # applied after the scan -- which is the difference between resuming at the cursor and
    # re-reading every page already served.
    Index(None, run.c.submitted_at, run.c.id)
    Index(None, run.c.measured_at, run.c.id)

    test = Table(
        "test",
        metadata,
        Column("id", Integer, Identity(), primary_key=True),
        Column("name", String(NAME_LENGTH), nullable=False, unique=True),
    )

    sample = Table(
        "sample",
        metadata,
        # D5: a sample is identified by its run, its test, and its position among that test's
        # samples in the submission (O1). The key leads with the run, which is how E6, the cascade
        # from a deleted run, and E9's `GET /series` reach these rows.
        Column("run_id", ForeignKey("run.id", ondelete="CASCADE"), primary_key=True),
        # No cascade from `test`: nothing deletes a test. The Tests endpoint is read-only and tests
        # are created implicitly by submission, so there is no path that would need one, and
        # refusing is the safe answer if one ever appears. Same for the two below.
        Column("test_id", ForeignKey("test.id"), primary_key=True),
        Column("repetition", Integer, primary_key=True),
        *_dynamic(schema.metrics),
    )
    # D5: a test's samples across every machine's runs. No endpoint relies on it.
    Index(None, sample.c.test_id, sample.c.run_id)

    # D5: which tests have had samples on which machine, and for which metrics, so that
    # `GET /tests?machine=&metric=` is a lookup here rather than a scan of `sample`. Only submission
    # writes it, and only ever adds (see `suites/coverage.py`). The machine cascade is D5's; nothing
    # deletes a test, as for `sample`.
    test_coverage = Table(
        "test_coverage",
        metadata,
        Column("machine_id", ForeignKey("machine.id", ondelete="CASCADE"), primary_key=True),
        Column("test_id", ForeignKey("test.id"), primary_key=True),
        *_flags(schema.metrics),
    )

    regression = Table(
        "regression",
        metadata,
        Column("id", Integer, Identity(), primary_key=True),
        Column("uuid", String(UUID_LENGTH), nullable=False, unique=True),
        Column("title", String(NAME_LENGTH), nullable=True),
        Column("bug", String(NAME_LENGTH), nullable=True),
        Column("notes", Text, nullable=True),
        Column("state", Integer, nullable=False, index=True),
        # Cleared rather than cascaded: deleting a commit keeps the regressions attributed to it,
        # without a commit (D5).
        Column(
            "commit_id",
            ForeignKey("commit.id", ondelete="SET NULL"),
            nullable=True,
            index=True,
        ),
        # The database's clock, as for `run.submitted_at`. A request cannot supply this (D5).
        Column("created_at", DateTime(timezone=True), nullable=False, server_default=func.now()),
        # D5 has the database layer validate the state. Restating it as a constraint costs nothing
        # -- the five values are fixed for v5 -- and in exchange a bug that writes an unknown state
        # fails at the boundary rather than producing a regression no filter can find. Built from
        # the enum so the two cannot drift; the same trade-off as `api_key.scope`.
        CheckConstraint(
            "state IN ({})".format(", ".join(str(state.value) for state in RegressionState)),
            name="state",
        ),
    )
    # D5: the regression list's `?sort=created_at`, over the keyset's `(created_at, id)`, for the
    # same reason as `run`'s `(submitted_at, id)`.
    Index(None, regression.c.created_at, regression.c.id)

    regression_indicator = Table(
        "regression_indicator",
        metadata,
        Column("id", Integer, Identity(), primary_key=True),
        Column("uuid", String(UUID_LENGTH), nullable=False, unique=True),
        Column(
            "regression_id",
            ForeignKey("regression.id", ondelete="CASCADE"),
            nullable=False,
        ),
        # D5: deleting a machine takes its indicators with it. A regression left with no indicators
        # is not itself deleted -- an empty indicator set is a legal state.
        Column("machine_id", ForeignKey("machine.id", ondelete="CASCADE"), nullable=False),
        Column("test_id", ForeignKey("test.id"), nullable=False),
        # D5: removing a metric from the schema removes the indicators naming it, like deleting a
        # machine does.
        Column("metric_id", ForeignKey("metric.id", ondelete="CASCADE"), nullable=False),
        UniqueConstraint(
            "regression_id",
            "machine_id",
            "test_id",
            "metric_id",
            name=REGRESSION_INDICATOR_CONSTRAINT,
        ),
    )
    # D5: the indicator lookup across regressions, which narrows by machine and test rather than by
    # regression, and pages in this order with `id` as the cursor's tiebreaker. The unique
    # constraint above leads with `regression_id`, so it can serve neither. Leading with
    # `machine_id` also gives the cascade from a deleted machine an index to find its indicators
    # by; PostgreSQL does not index a referencing column on its own.
    Index(
        None,
        regression_indicator.c.machine_id,
        regression_indicator.c.test_id,
        regression_indicator.c.metric_id,
        regression_indicator.c.id,
    )

    profile = Table(
        "profile",
        metadata,
        Column("id", Integer, Identity(), primary_key=True),
        Column("uuid", String(UUID_LENGTH), nullable=False, unique=True),
        Column("run_id", ForeignKey("run.id", ondelete="CASCADE"), nullable=False),
        Column("test_id", ForeignKey("test.id"), nullable=False, index=True),
        Column("created_at", DateTime(timezone=True), nullable=False, server_default=func.now()),
        Column("disassembly_format", Text, nullable=False),
        # O7's top-level counters, by name. JSONB rather than a column per counter: which counters
        # a profile measured is up to its producer, not the suite's schema.
        Column("counters", JSONB, nullable=False),
        UniqueConstraint("run_id", "test_id"),
    )

    # One row per function of a profile (D5). The key leads with the profile, which is how every
    # query reaches these rows, and O7's cap on a function name
    # (`profile_document.MAX_FUNCTION_NAME_BYTES`) keeps it within a btree entry, about 2.7 kB.
    profile_function = Table(
        "profile_function",
        metadata,
        Column("profile_id", ForeignKey("profile.id", ondelete="CASCADE"), primary_key=True),
        Column("name", Text, primary_key=True),
        Column("counters", JSONB, nullable=False),
        Column("length", Integer, nullable=False),
        # D5: the instructions must stay out of the default result set and be loaded only when a
        # request actually needs them. Core selects the columns it is asked for, so that obligation
        # falls on each query -- `select(profile_function)` would pull every function's
        # instructions it matched. The encoding is `profile_document`'s.
        Column("instructions", LargeBinary, nullable=False),
    )

    # O9: statistics summarizing a run's samples, one row per numeric metric, which is what
    # `GET /trends` reads instead of the samples. One column per statistic and sample aggregation,
    # of which the geomean is the only statistic so far; null where the run has no geomean under
    # that aggregation. Written once, at submission, and deleted with the run or the metric it is
    # derived from. `run_id` leads the key because trends reaches these by run.
    run_summary = Table(
        "run_summary",
        metadata,
        Column("run_id", ForeignKey("run.id", ondelete="CASCADE"), primary_key=True),
        Column("metric_id", ForeignKey("metric.id", ondelete="CASCADE"), primary_key=True),
        # From the enum, so that adding an aggregation changes the structure a suite is created
        # with, and the snapshot tests ask for the migration step that adds its column.
        *(
            Column(geomean_column(aggregation), Double, nullable=True)
            for aggregation in SampleAggregation
        ),
    )

    return SuiteTables(
        metadata=metadata,
        commit=commit,
        machine=machine,
        metric=metric,
        run=run,
        test=test,
        sample=sample,
        test_coverage=test_coverage,
        regression=regression,
        regression_indicator=regression_indicator,
        profile=profile,
        profile_function=profile_function,
        run_summary=run_summary,
    )


# --------------------------------------------------------------------------------------------
# DDL
#
# Every identifier is quoted. The name rule (see schema.py) admits PostgreSQL's reserved words --
# `order` is a perfectly legal metric name -- so an unquoted identifier would be a syntax error on
# exactly the schemas that are hardest to notice in review.
# --------------------------------------------------------------------------------------------


def _quote(connection: Connection, identifier: str) -> str:
    return str(connection.dialect.identifier_preparer.quote(identifier))


def _qualified(connection: Connection, table: Table) -> str:
    return str(connection.dialect.identifier_preparer.format_table(table))


# What the server names the namespace of a suite, followed by a number from `namespace_sequence`.
# Any name would do, as long as no namespace has it and no suite records it (D5).
NAMESPACE_PREFIX = "suite_"

_candidate = select(
    (literal(NAMESPACE_PREFIX) + cast(namespace_sequence.next_value(), String)).label("name")
).subquery()
_pg_namespace = table("pg_namespace", column("nspname"))
_NEXT_NAMESPACE = select(
    _candidate.c.name,
    or_(
        exists().where(_pg_namespace.c.nspname == _candidate.c.name),
        exists().where(schema_table.c.namespace == _candidate.c.name),
    ),
)


def new_namespace(connection: Connection) -> str:
    """A name for a suite's namespace: one that no namespace has, and no suite records (D5).

    For a new suite, and for one a migration moves (see `migrations.py`). The sequence never hands
    out a number twice, so two suites given a namespace concurrently never get the same name. A
    name can still be taken by a namespace the sequence did not name: one created outside LNT, or
    the namespace of a suite not yet moved off the one named after it. A suite's namespace may also
    have been dropped out of band while its row stayed, and the name is taken all the same. Each
    candidate is checked against both in one statement.
    """
    while True:
        candidate, taken = connection.execute(_NEXT_NAMESPACE).one()
        if not taken:
            return str(candidate)


def label(connection: Connection, namespace: str, suite: str) -> None:
    """Label a suite's namespace with the suite's name, for whoever reads the database directly,
    since nothing else about it says which suite it holds (D5)."""
    # Rendered as a quoted literal rather than bound, since COMMENT takes no bind parameters.
    text_ = literal(f"LNT test suite {suite}").compile(
        dialect=connection.dialect, compile_kwargs={"literal_binds": True}
    )
    connection.execute(text(f"COMMENT ON SCHEMA {_quote(connection, namespace)} IS {text_}"))


def create(connection: Connection, schema: SuiteSchema, namespace: str) -> SuiteTables:
    """Create the suite's namespace and every table in it, and return the tables.

    Takes the schema rather than tables already built from it because `{suite}.metric` starts out
    holding a row per declared metric, which the tables alone do not describe.

    The caller owns the transaction. PostgreSQL has transactional DDL, so a failure partway leaves
    nothing behind, and the `schema` row and `schema_version` bump the caller writes alongside this
    commit or roll back with it (D2).
    """
    tables = build(schema, namespace)
    connection.execute(text(f"CREATE SCHEMA {_quote(connection, namespace)}"))
    label(connection, namespace, schema.name)
    # `checkfirst=False` because the CREATE SCHEMA above has just established that nothing in this
    # namespace exists. The default would reflect each table first, to skip the ones already there
    # -- a round trip per table that can only ever answer "no".
    tables.metadata.create_all(connection, checkfirst=False)
    add_metrics(connection, tables.metric, [metric.name for metric in schema.metrics])
    return tables


def add_metrics(connection: Connection, table: Table, names: Sequence[str]) -> None:
    """Give each newly declared metric its row in `{suite}.metric` (D5)."""
    if names:
        connection.execute(insert(table), [{"name": name} for name in names])


def remove_metrics(connection: Connection, table: Table, names: Sequence[str]) -> None:
    """Remove removed metrics' rows, and with them every regression indicator naming one (D5)."""
    if names:
        connection.execute(delete(table).where(table.c.name.in_(names)))


def drop(connection: Connection, namespace: str) -> None:
    """Drop the suite's namespace and everything in it.

    CASCADE because the tables reference each other. The namespace holds nothing but the suite's
    tables (D5), so there is nothing else to take with them.
    """
    connection.execute(text(f"DROP SCHEMA {_quote(connection, namespace)} CASCADE"))


def add_column(connection: Connection, column: Column[Any]) -> None:
    """Add one dynamic column to an existing suite table (D2).

    Takes a column already attached to a table from `build`, so that the type and the target are
    described in exactly one place. Existing rows get the column's default: no value for a
    declared entry, and false for a flag on `{suite}.test_coverage`.
    """
    specification = CreateColumn(column).compile(dialect=connection.dialect).string
    connection.execute(
        text(f"ALTER TABLE {_qualified(connection, column.table)} ADD COLUMN {specification}")
    )


def drop_column(connection: Connection, table: Table, name: str) -> None:
    """Remove one dynamic column, and every value stored in it (D2).

    Permanently destructive, which is why the endpoint that reaches this requires `?confirm=true`.
    """
    connection.execute(
        text(f"ALTER TABLE {_qualified(connection, table)} DROP COLUMN {_quote(connection, name)}")
    )

"""A suite's own tables (D5), built from its schema, and the DDL that puts them in the database.

Per-suite tables are the half of the model defined by *data* rather than by code: which columns
exist follows from a suite's schema, so no migration written in advance could describe them (D14).
They are created here, at runtime, by the suite endpoints.

Each suite's tables live in a PostgreSQL namespace of their own, named after the suite, so a table
is addressed as `{suite}.commit`. That is what lets every suite carry *identical* constraint names:
the naming convention composes a name from a table and its columns, neither of which mentions the
suite, so `uq_commit_ordinal` is the name in every suite and the code that attributes a
unique-constraint violation (D13) can write it out rather than compose it per request.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any

from sqlalchemy import (
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
    func,
    text,
    true,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.schema import CreateColumn
from sqlalchemy.types import TypeEngine

from lnt_v5.suites.schema import AttributeType, Entry, SuiteSchema
from lnt_v5.suites.states import RegressionState
from lnt_v5.tables import NAMING_CONVENTION

# D5's widths for the built-in string columns. A UUID is the 36-character hyphenated form (R1).
# Deliberately not shared with `api_key.name`'s identical width in tables.py: D5 states these per
# column, and the two would then have to change together for no reason.
NAME_LENGTH = 256
UUID_LENGTH = 36

# What NAMING_CONVENTION names the constraints the endpoints have to attribute a violation to, and
# so answer the specific 409 R4 gives each one rather than a 500. Written out because they are fixed
# -- the convention composes a name from a table and its columns, neither of which mentions the
# suite -- and checked against what PostgreSQL reports by `test_suite_tables.py`, so a convention
# change fails a test rather than silently turning a 409 into a 500. The same arrangement as
# `store.SCHEMA_NAME_CONSTRAINT`.
MACHINE_NAME_CONSTRAINT = "uq_machine_name"
COMMIT_VALUE_CONSTRAINT = "uq_commit_commit"
COMMIT_ORDINAL_CONSTRAINT = "uq_commit_ordinal"
RUN_UUID_CONSTRAINT = "uq_run_uuid"
# Not a unique constraint but a foreign key: D5 makes a commit a regression references undeletable,
# and this is the constraint whose violation says so (R4's `in_use`).
REGRESSION_COMMIT_CONSTRAINT = "fk_regression_commit_id_commit"


# D3's mapping from a declared type to the column that stores it. `Double` rather than `Float`
# because D3 names DOUBLE PRECISION specifically, and SQLAlchemy's `Float` is REAL on PostgreSQL --
# single precision, which would quietly round every sample.
#
# The instances are shared across every column and every suite. That is safe because none of these
# four is a `SchemaType`: nothing binds them to a parent column, so no column can mutate them. It
# does not extend to `Identity()`, `ForeignKey(...)` or the constraints below, which do bind to
# their parent and must be constructed per call.
_COLUMN_TYPES: dict[AttributeType, TypeEngine[Any]] = {
    AttributeType.REAL: Double(),
    AttributeType.INTEGER: Integer(),
    AttributeType.TEXT: Text(),
    AttributeType.DATETIME: DateTime(timezone=True),
}


def _dynamic(entries: Sequence[Entry]) -> list[Column[Any]]:
    """The columns a schema's `metrics`, `commit_fields` or `machine_fields` become.

    All nullable: a schema change may add an entry at any time, which leaves every existing row
    with no value for it (D2), and a submission need not carry every declared field (D7).
    """
    return [Column(entry.name, _COLUMN_TYPES[entry.type], nullable=True) for entry in entries]


@dataclass(frozen=True)
class SuiteTables:
    """One suite's eight tables, and the metadata describing them together.

    Held as named attributes rather than looked up by string so that the query code reads as
    `tables.sample.c.run_id`, and so that a typo is a type error.
    """

    metadata: MetaData
    commit: Table
    machine: Table
    run: Table
    test: Table
    sample: Table
    regression: Table
    regression_indicator: Table
    profile: Table

    @property
    def name(self) -> str:
        """The suite, which is also the namespace its tables live in.

        Derived rather than stored: `MetaData(schema=...)` is what actually places the tables, so a
        separate copy could only ever disagree with it.
        """
        return str(self.metadata.schema)


def build(schema: SuiteSchema) -> SuiteTables:
    """The tables D5 specifies for a suite with this schema.

    Pure: it describes the tables without touching a database. `create` is what puts them there.
    """
    # `schema=` on the MetaData is what places every table in the suite's namespace, and what makes
    # the unqualified foreign-key targets below resolve within it.
    metadata = MetaData(schema=schema.name, naming_convention=NAMING_CONVENTION)

    commit = Table(
        "commit",
        metadata,
        Column("id", Integer, Identity(), primary_key=True),
        Column("commit", String(NAME_LENGTH), nullable=False, unique=True),
        # D11: a regular, non-deferred unique constraint. Ordinals are assigned once and rarely
        # reassigned, so a write that would give two commits the same one is simply rejected (409).
        Column("ordinal", Integer, nullable=True, unique=True),
        Column("tag", String(NAME_LENGTH), nullable=True),
        *_dynamic(schema.commit_fields),
    )
    # Partial, because the column is null on almost every row: tags are applied by hand to a
    # handful of commits, and an index over the nulls would be most of the table for no lookups.
    Index(None, commit.c.tag, postgresql_where=commit.c.tag.is_not(None))

    machine = Table(
        "machine",
        metadata,
        Column("id", Integer, Identity(), primary_key=True),
        Column("name", String(NAME_LENGTH), nullable=False, unique=True),
        # D5: governs automatic machine selection only. Untracked machines stay fully addressable,
        # and are never cleaned up -- this is not a lifetime policy.
        Column("tracked", Boolean, nullable=False, server_default=true()),
        *_dynamic(schema.machine_fields),
    )

    run = Table(
        "run",
        metadata,
        Column("id", Integer, Identity(), primary_key=True),
        Column("uuid", String(UUID_LENGTH), nullable=False, unique=True),
        Column("machine_id", ForeignKey("machine.id", ondelete="CASCADE"), nullable=False),
        Column(
            "commit_id",
            ForeignKey("commit.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        # The database's clock rather than the application's, so that concurrent workers agree on
        # ordering. A submission cannot supply this (D6).
        Column("submitted_at", DateTime(timezone=True), nullable=False, server_default=func.now()),
        Column("run_parameters", JSONB, nullable=False, server_default=text("'{}'::jsonb")),
    )
    # D5: the leading column serves "every run for this machine", and the pair keeps both
    # `?sort=-submitted_at` and the derived `last_run_at` to a bounded index scan rather than a
    # scan of this table.
    Index(None, run.c.machine_id, run.c.submitted_at)
    # D5: the same ordering with no machine to narrow it -- the suite-wide run list's
    # `?sort=-submitted_at`, which the one above cannot serve because its leading column is absent
    # from that query. `id` joins it because the keyset's tiebreaker is `(submitted_at, id)`, and
    # only an index over both turns the cursor's row comparison into an index condition rather than
    # a filter applied after the scan -- which is the difference between resuming at the cursor and
    # re-reading every page already served.
    Index(None, run.c.submitted_at, run.c.id)

    test = Table(
        "test",
        metadata,
        Column("id", Integer, Identity(), primary_key=True),
        Column("name", String(NAME_LENGTH), nullable=False, unique=True),
    )

    sample = Table(
        "sample",
        metadata,
        Column("id", Integer, Identity(), primary_key=True),
        Column("run_id", ForeignKey("run.id", ondelete="CASCADE"), nullable=False),
        # No cascade from `test`: nothing deletes a test. The Tests endpoint is read-only and tests
        # are created implicitly by submission, so there is no path that would need one, and
        # refusing is the safe answer if one ever appears. Same for the two below.
        Column("test_id", ForeignKey("test.id"), nullable=False),
        *_dynamic(schema.metrics),
    )
    # D5 names both orders deliberately: (run_id, test_id) covers "all samples for a run", and
    # (test_id, run_id) covers the time-series query, which scans one test across many runs.
    Index(None, sample.c.run_id, sample.c.test_id)
    Index(None, sample.c.test_id, sample.c.run_id)

    regression = Table(
        "regression",
        metadata,
        Column("id", Integer, Identity(), primary_key=True),
        Column("uuid", String(UUID_LENGTH), nullable=False, unique=True),
        Column("title", String(NAME_LENGTH), nullable=True),
        Column("bug", String(NAME_LENGTH), nullable=True),
        Column("notes", Text, nullable=True),
        Column("state", Integer, nullable=False, index=True),
        # No cascade, and deliberately not nullable-on-delete either: D5 makes a commit referenced
        # by a regression undeletable, and this constraint is what produces that refusal -- which
        # the API reports as `in_use` (R4).
        Column("commit_id", ForeignKey("commit.id"), nullable=True, index=True),
        # D5 has the database layer validate the state. Restating it as a constraint costs nothing
        # -- the five values are fixed for v5 -- and in exchange a bug that writes an unknown state
        # fails at the boundary rather than producing a regression no filter can find. Built from
        # the enum so the two cannot drift; the same trade-off as `api_key.scope`.
        CheckConstraint(
            "state IN ({})".format(", ".join(str(state.value) for state in RegressionState)),
            name="state",
        ),
    )

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
        Column("metric", String(NAME_LENGTH), nullable=False),
        # Composes to exactly 63 bytes, PostgreSQL's identifier limit, so this constraint cannot
        # absorb another column or a longer table name without being silently truncated. See
        # NAMING_CONVENTION in tables.py, and the test that checks every name against the database.
        UniqueConstraint("regression_id", "machine_id", "test_id", "metric"),
    )

    profile = Table(
        "profile",
        metadata,
        Column("id", Integer, Identity(), primary_key=True),
        Column("uuid", String(UUID_LENGTH), nullable=False, unique=True),
        Column("run_id", ForeignKey("run.id", ondelete="CASCADE"), nullable=False),
        Column("test_id", ForeignKey("test.id"), nullable=False, index=True),
        Column("created_at", DateTime(timezone=True), nullable=False, server_default=func.now()),
        # D5 and D12: the blob must stay out of the default result set and be loaded only when a
        # request actually needs it. Core selects the columns it is asked for, so that obligation
        # falls on each query -- `select(profile)` would pull every blob it matched.
        Column("data", LargeBinary, nullable=False),
        UniqueConstraint("run_id", "test_id"),
    )

    return SuiteTables(
        metadata=metadata,
        commit=commit,
        machine=machine,
        run=run,
        test=test,
        sample=sample,
        regression=regression,
        regression_indicator=regression_indicator,
        profile=profile,
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


def create(connection: Connection, tables: SuiteTables) -> None:
    """Create the suite's namespace and every table in it.

    The caller owns the transaction. PostgreSQL has transactional DDL, so a failure partway leaves
    nothing behind, and the `schema` row and `schema_version` bump the caller writes alongside this
    commit or roll back with it (D2).
    """
    connection.execute(text(f"CREATE SCHEMA {_quote(connection, tables.name)}"))
    # `checkfirst=False` because the CREATE SCHEMA above has just established that nothing in this
    # namespace exists. The default would reflect each of the eight tables first, to skip the ones
    # already there -- eight round trips that can only ever answer "no".
    tables.metadata.create_all(connection, checkfirst=False)


def drop(connection: Connection, name: str) -> None:
    """Drop the suite's namespace and everything in it.

    CASCADE because the tables reference each other; there is nothing outside the namespace to
    take with them.
    """
    connection.execute(text(f"DROP SCHEMA {_quote(connection, name)} CASCADE"))


def add_column(connection: Connection, column: Column[Any]) -> None:
    """Add one dynamic column to an existing suite table (D2).

    Takes a column already attached to a table from `build`, so that the type and the target are
    described in exactly one place. Existing rows are left with no value for it, which is why
    every dynamic column is nullable.
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

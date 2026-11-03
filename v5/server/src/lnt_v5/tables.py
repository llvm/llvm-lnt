"""The global tables (D5), and the naming convention every table in an instance shares.

Global tables exist once per instance. They are defined here, in code, and brought into being by
a migration (D6). Per-suite tables are the other half of the model. They are described in
`suites/tables.py`, and the suite endpoints create and alter them at runtime, since which dynamic
columns they have depends on each suite's schema. They are not defined here, but they must use the
naming convention below.
"""

from __future__ import annotations

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    Column,
    DateTime,
    ForeignKey,
    Identity,
    Integer,
    MetaData,
    Sequence,
    String,
    Table,
    Text,
    UniqueConstraint,
    false,
    func,
    true,
)

from .scopes import UNRESTRICTABLE_SCOPES, Scope

# Deterministic names for every constraint and index, rather than whatever Postgres would invent.
# Two things rest on this. Alembic needs stable names to emit migrations that can be reversed.
# More importantly, O8 recovers from a unique-constraint violation by *attributing* it: a run
# submission that trips one has to answer `duplicate` for a repeated run UUID but `conflict` for a
# taken ordinal (I4), and at the point the error surfaces the constraint's name is the only thing
# that tells those apart.
#
# Because per-suite tables live in a schema of their own (D5), a name composed from a table and its
# columns never contains a suite name, so every name in the instance is fixed by this file and the
# table definitions -- which is why the code that attributes a violation can name a constraint
# outright. Two obligations come with that. A composed name must fit inside Postgres' 63-byte
# identifier limit, since Postgres truncates a longer one with a warning rather than an error and
# the stored name would then not be the one attribution compares (D4); anything that would
# overflow takes a shorter explicit `name=`. And a name written down elsewhere must match the one
# this convention produces.
#
# `test_tables.py` checks both against what Postgres actually stored, but only for the tables in
# this file: per-suite tables are built at runtime from a suite's schema and are not in this
# metadata, so whatever creates them owes the same check. They are also where the limit actually
# bites: D5's unique constraint on `{suite}.regression_indicator` spans four columns and would
# compose past it, so it carries an explicit name.
NAMING_CONVENTION = {
    "ix": "ix_%(table_name)s_%(column_0_N_name)s",
    "uq": "uq_%(table_name)s_%(column_0_N_name)s",
    "ck": "ck_%(table_name)s_%(constraint_name)s",
    "fk": "fk_%(table_name)s_%(column_0_N_name)s_%(referred_table_name)s",
    "pk": "pk_%(table_name)s",
}

metadata = MetaData(naming_convention=NAMING_CONVENTION)

# PostgreSQL's identifier limit, and so the bound on each metric and field name a schema supplies
# (D4), because it is the name of a column, and on the namespace holding a suite's tables (D5).
# Characters and bytes are interchangeable here because D4 restricts entry names to ASCII, and the
# server names namespaces in ASCII.
IDENTIFIER_MAX_LENGTH = 63

# D4's limit on a suite name, which D7 applies to a project's too. Unlike an entry name, neither
# names anything in the database, so neither is bound by the identifier limit above.
SUITE_NAME_MAX_LENGTH = 64

# D4's limit on a suite's display name, which D7 applies to a project's too.
DISPLAY_NAME_MAX_LENGTH = 256

# I5: a token is 64 lowercase hex characters, of which the first 8 are the published prefix, and
# the stored hash is a hex SHA-256. These widths are the authority; keys.py reads them from here.
TOKEN_PREFIX_LENGTH = 8
TOKEN_HASH_LENGTH = 64

# D5 caps an API key's label at this width, and endpoints.md turns exceeding it into a 400. The
# column owns the number so the validator and the spec cannot drift apart from it.
KEY_NAME_MAX_LENGTH = 256

# D5: `schema_version` holds exactly one row, at this id, so that it is addressable without a
# search. Callers may rely on the row existing -- the initial migration creates it.
SCHEMA_VERSION_ID = 1


project = Table(
    "project",
    metadata,
    # The project's identity, which no response shows (D5).
    Column("id", Integer, Identity(), primary_key=True),
    Column("name", String(SUITE_NAME_MAX_LENGTH), nullable=False, unique=True),
    Column("display_name", String(DISPLAY_NAME_MAX_LENGTH), nullable=True),
)
"""One row per project, which groups test suites (D5, D7)."""


schema = Table(
    "schema",
    metadata,
    # The suite's identity, which no response shows (D5): what an API key's restriction refers to,
    # so that it follows the suite rather than its name.
    Column("id", Integer, Identity(), primary_key=True),
    # No cascade: a project that still has suites cannot be deleted (D7), which is what makes its
    # deletion and the creation of a suite in it never both succeed (D2).
    Column("project_id", Integer, ForeignKey(project.c.id), nullable=False),
    Column("name", String(SUITE_NAME_MAX_LENGTH), nullable=False),
    # Chosen by the server when the suite is created, and never changed afterwards (D5). Unique
    # because a namespace holds the tables of one suite only.
    Column("namespace", String(IDENTIFIER_MAX_LENGTH), nullable=False, unique=True),
    Column("schema_json", Text, nullable=False),
    Column("created_at", DateTime(timezone=True), nullable=False, server_default=func.now()),
    # Deliberately no default: whatever creates a suite must give its version explicitly (see
    # `suites/migrations.py`). A suite recorded at too low a version would have steps applied again
    # to tables that already have them.
    Column("migration_version", Integer, nullable=False),
    # A suite's name is unique within its project only (D7).
    UniqueConstraint("project_id", "name"),
)
"""One row per test suite, holding that suite's normalized schema (D2, D5).

`schema_json` is TEXT rather than JSONB deliberately: the server never queries into it. It is
read whole, parsed into the in-memory model, and written whole.

`migration_version` is how many per-suite migration steps have been applied to the suite (D6).
"""

namespace_sequence = Sequence("schema_namespace_seq", metadata=metadata)
"""Numbers the namespaces the server gives new suites (see `suites/store.py`).

Owned by `schema.namespace`, which SQLAlchemy cannot express, so revision 0008 says it. Autogenerate
does not compare sequences, so `test_migrations.py` checks the ownership instead.
"""


schema_version = Table(
    "schema_version",
    metadata,
    Column("id", Integer, primary_key=True, autoincrement=False),
    Column("version", Integer, nullable=False),
    CheckConstraint(f"id = {SCHEMA_VERSION_ID}", name="single_row"),
)
"""The counter workers watch to notice that their cached suite schemas are stale (D2, D5).

The check constraint is what makes D5's "exactly one row, never deleted" an enforced property
rather than a convention, so that the read on every request path can address the row directly
instead of coping with its absence.
"""


api_key = Table(
    "api_key",
    metadata,
    Column("id", Integer, Identity(), primary_key=True),
    Column("prefix", String(TOKEN_PREFIX_LENGTH), nullable=False, unique=True),
    Column("key_hash", String(TOKEN_HASH_LENGTH), nullable=False, unique=True),
    Column("name", String(KEY_NAME_MAX_LENGTH), nullable=False),
    Column("scope", String(32), nullable=False),
    # Whether the key is restricted to the projects and suites its `api_key_restriction` rows list
    # (I5). It stays restricted once deleting what they list has removed every row.
    Column("restricted", Boolean, nullable=False, server_default=false()),
    Column("created_at", DateTime(timezone=True), nullable=False, server_default=func.now()),
    Column("last_used_at", DateTime(timezone=True), nullable=True),
    Column("is_active", Boolean, nullable=False, server_default=true()),
    # D5 has the database layer validate the scope on create. Restating it as a constraint costs
    # a migration if I5's five ever change -- they are fixed for v5 -- and in exchange a bug that
    # writes an unknown scope fails at the boundary instead of minting a key that authenticates
    # as something nobody intended. Built from the enum so the two cannot drift.
    CheckConstraint(
        "scope IN ({})".format(", ".join(f"'{scope.value}'" for scope in Scope)),
        name="scope",
    ),
    # D5: the scopes that cannot be restricted (I5) are never stored as restricted.
    CheckConstraint(
        "NOT restricted OR scope NOT IN ({})".format(
            ", ".join(f"'{scope.value}'" for scope in UNRESTRICTABLE_SCOPES)
        ),
        name="restricted",
    ),
)
"""One row per API key (D5). The token itself is never stored; see I5 and keys.py."""


api_key_restriction = Table(
    "api_key_restriction",
    metadata,
    Column("api_key_id", Integer, ForeignKey(api_key.c.id), nullable=False),
    # Exactly one of the two is set: a whole project, or a single suite. Deleting either removes it
    # from the keys that list it (I5).
    Column("project_id", Integer, ForeignKey(project.c.id, ondelete="CASCADE"), nullable=True),
    Column("suite_id", Integer, ForeignKey(schema.c.id, ondelete="CASCADE"), nullable=True),
    CheckConstraint("(project_id IS NULL) <> (suite_id IS NULL)", name="one_target"),
    # Each a key lists at most once. Null `project_id`s and `suite_id`s are distinct from each other
    # here, so each constraint only applies to the rows of its own kind.
    UniqueConstraint("api_key_id", "project_id"),
    UniqueConstraint("api_key_id", "suite_id"),
)
"""One row per entry of a restricted key's list, a whole project or a single suite (D5, I5).

A row refers to its project or suite by identity rather than by name, so that it follows renames and
moves, and so that a project or a suite created later under the name of a deleted one is not
covered. Rows are written with their key and never changed.
"""

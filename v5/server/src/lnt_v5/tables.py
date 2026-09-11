"""The global tables (D5), and the naming convention every table in an instance shares.

Global tables exist once per instance. They are defined here, in code, and brought into being by
a migration (D14). Per-suite tables are the other half of the model: defined by data rather than
by code -- a suite's schema -- and created and altered at runtime by the suite endpoints. They
are not defined here, but they must adopt the naming convention below.
"""

from __future__ import annotations

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    Column,
    DateTime,
    Identity,
    Integer,
    MetaData,
    String,
    Table,
    Text,
    func,
    true,
)

from .scopes import Scope

# Deterministic names for every constraint and index, rather than whatever Postgres would invent.
# Two things rest on this. Alembic needs stable names to emit migrations that can be reversed.
# More importantly, D13 recovers from a unique-constraint violation by *attributing* it: a run
# submission that trips one has to answer `duplicate` for a repeated run UUID but
# `ordinal_conflict` for a taken ordinal (R4), and at the point the error surfaces the
# constraint's name is the only thing that tells those apart.
#
# Because per-suite tables live in a schema of their own (D5), a name composed from a table and its
# columns never contains a suite name, so every name in the instance is fixed by this file and the
# table definitions -- which is why the code that attributes a violation can name a constraint
# outright. Two obligations come with that. A composed name must fit inside Postgres' 63-byte
# identifier limit, since Postgres truncates a longer one with a warning rather than an error and
# the stored name would then not be the one attribution compares (D14); anything that would
# overflow takes a shorter explicit `name=`. And a name written down elsewhere must match the one
# this convention produces.
#
# `test_tables.py` checks both against what Postgres actually stored, but only for the tables in
# this file: per-suite tables are built at runtime from a suite's schema and are not in this
# metadata, so whatever creates them owes the same check. They are also where the limit actually
# bites -- D5's unique constraint on `{suite}.regression_indicator` composes to
# `uq_regression_indicator_regression_id_machine_id_test_id_metric`, which is exactly 63 bytes and
# cannot absorb one more character.
NAMING_CONVENTION = {
    "ix": "ix_%(table_name)s_%(column_0_N_name)s",
    "uq": "uq_%(table_name)s_%(column_0_N_name)s",
    "ck": "ck_%(table_name)s_%(constraint_name)s",
    "fk": "fk_%(table_name)s_%(column_0_N_name)s_%(referred_table_name)s",
    "pk": "pk_%(table_name)s",
}

metadata = MetaData(naming_convention=NAMING_CONVENTION)

# D4 caps a suite name at 63 characters, which is Postgres' identifier limit rather than a policy
# number: the name is the suite's schema name, and a longer one would be truncated into a collision
# with any other suite sharing its first 63 characters. Characters and bytes are interchangeable
# here because D4 also restricts the name to ASCII.
SUITE_NAME_MAX_LENGTH = 63

# R5: a token is 64 lowercase hex characters, of which the first 8 are the published prefix, and
# the stored hash is a hex SHA-256. These widths are the authority; keys.py reads them from here.
TOKEN_PREFIX_LENGTH = 8
TOKEN_HASH_LENGTH = 64

# D5 caps an API key's label at this width, and endpoints.md turns exceeding it into a 400. The
# column owns the number so the validator and the spec cannot drift apart from it.
KEY_NAME_MAX_LENGTH = 256

# D5: `schema_version` holds exactly one row, at this id, so that it is addressable without a
# search. Callers may rely on the row existing -- the initial migration creates it.
SCHEMA_VERSION_ID = 1


schema = Table(
    "schema",
    metadata,
    Column("name", String(SUITE_NAME_MAX_LENGTH), primary_key=True),
    Column("schema_json", Text, nullable=False),
    Column("created_at", DateTime(timezone=True), nullable=False, server_default=func.now()),
)
"""One row per test suite, holding that suite's normalized schema (D2, D5).

`schema_json` is TEXT rather than JSONB deliberately: the server never queries into it. It is
read whole, parsed into the in-memory model, and written whole.
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
    Column("created_at", DateTime(timezone=True), nullable=False, server_default=func.now()),
    Column("last_used_at", DateTime(timezone=True), nullable=True),
    Column("is_active", Boolean, nullable=False, server_default=true()),
    # D5 has the database layer validate the scope on create. Restating it as a constraint costs
    # a migration if R5's five ever change -- they are fixed for v5 -- and in exchange a bug that
    # writes an unknown scope fails at the boundary instead of minting a key that authenticates
    # as something nobody intended. Built from the enum so the two cannot drift.
    CheckConstraint(
        "scope IN ({})".format(", ".join(f"'{scope.value}'" for scope in Scope)),
        name="scope",
    ),
)
"""One row per API key (D5). The token itself is never stored; see R5 and keys.py."""

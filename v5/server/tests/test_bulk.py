"""`bulk.unnest_insert`: what the rows a submission stores cannot show (see `test_runs.py`)."""

from __future__ import annotations

import pytest
from psycopg.adapt import PyFormat
from psycopg.errors import StringDataRightTruncation, UndefinedColumn
from psycopg.types.array import ListBinaryDumper
from sqlalchemy import (
    Column,
    Double,
    Engine,
    Integer,
    MetaData,
    String,
    Table,
    text,
)
from sqlalchemy.exc import DBAPIError
from sqlalchemy.schema import CreateSchema

from lnt_v5.config import Settings
from lnt_v5.db import make_engine
from lnt_v5.suites.bulk import BinaryList, unnest_insert


@pytest.fixture
def table(db_engine: Engine) -> Table:
    """A table in a namespace of its own, which `db_engine` drops after the test."""
    table = Table(
        "rows",
        MetaData(schema="bulk"),
        Column("id", Integer, primary_key=True, autoincrement=True),
        Column("short", String(4)),
        Column("value", Double),
    )
    with db_engine.begin() as connection:
        connection.execute(CreateSchema("bulk"))
        table.metadata.create_all(connection)
    return table


def test_refuses_a_string_too_long_for_its_column_rather_than_truncating_it(
    db_engine: Engine, table: Table
) -> None:
    with db_engine.begin() as connection, pytest.raises(DBAPIError) as raised:
        connection.execute(unnest_insert(table, ["short"]), {"short": ["abcdefgh"]})

    assert isinstance(raised.value.orig, StringDataRightTruncation)


def test_a_statement_the_server_prepared_still_fails_on_a_dropped_column(
    db_engine: Engine, table: Table
) -> None:
    # Whether psycopg prepares one depends on pooling (a ROLLBACK discards what it prepared), so
    # D2's retryable 409 must not depend on it: the column a removed metric leaves must still be an
    # undefined column, rather than a plan that runs anyway.
    statement = unnest_insert(table, ["short", "value"])
    with db_engine.connect() as connection:
        for _ in range(6):
            connection.execute(statement, {"short": ["a", None], "value": [1.0, None]})
        connection.commit()
        prepared = connection.execute(text("SELECT statement FROM pg_prepared_statements"))
        assert any("INSERT INTO bulk.rows" in row for row in prepared.scalars())
        connection.commit()
        with db_engine.begin() as other:
            other.execute(text("ALTER TABLE bulk.rows DROP COLUMN value"))

        with pytest.raises(DBAPIError) as raised:
            connection.execute(statement, {"short": ["a"], "value": [1.0]})

    assert isinstance(raised.value.orig, UndefinedColumn)


def test_the_application_sends_a_bytea_array_in_binary(api_settings: Settings) -> None:
    # Only observable here: as text, the instructions would be stored just the same, only slower.
    engine = make_engine(api_settings)
    try:
        with engine.connect() as connection:
            adapters = connection.connection.driver_connection.adapters  # type: ignore[union-attr]
            assert adapters.get_dumper(BinaryList, PyFormat.AUTO) is ListBinaryDumper
    finally:
        engine.dispose()

"""Writing a set of rows in one statement: `INSERT ... SELECT FROM unnest(<one array per column>)`.

Run submission writes hundreds to tens of thousands of rows at once. An executemany sends one
INSERT per row, each with its own parameter processing on both sides, and `insert().values(rows)`
compiles a new statement for every row count. With one array parameter per column, the SQL is the
same whatever the number of rows, so SQLAlchemy compiles it once. Building the statement is then the
largest cost left in the client, so callers keep it (see `Suite.derived`).
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any

import psycopg
from psycopg.types.array import ListBinaryDumper
from sqlalchemy import (
    Dialect,
    Insert,
    LargeBinary,
    String,
    Table,
    bindparam,
    func,
    insert,
    select,
)
from sqlalchemy.dialects.postgresql import ARRAY
from sqlalchemy.types import TypeDecorator, TypeEngine


def unnest_insert(table: Table, rows: Sequence[str], *, constants: Sequence[str] = ()) -> Insert:
    """An INSERT of one row per element of the arrays bound to the `rows` columns, each also
    holding the value bound to every `constants` column. Every parameter is named after its column.

    Each array is cast to its column's type, since an array of nulls gives PostgreSQL nothing to
    infer one from. A `bytea[]` is sent in binary only on a connection `adapt` has set up.
    """
    arrays = [bindparam(name, type_=_array_of(table.c[name].type)) for name in rows]
    unnested = func.unnest(*arrays).table_valued(*rows).render_derived()
    scalars = [bindparam(name, type_=table.c[name].type) for name in constants]
    return insert(table).from_select([*constants, *rows], select(*scalars, *unnested.c))


def _array_of(element: TypeEngine[Any]) -> TypeEngine[Any]:
    if isinstance(element, LargeBinary):
        return _ByteaArray()
    if isinstance(element, String) and element.length is not None:
        # A cast to VARCHAR(n) truncates silently, where storing into the column refuses the value.
        element = String()
    return ARRAY(element, dimensions=1)


def adapt(connection: psycopg.Connection[Any]) -> None:
    """Have a new psycopg connection send a `bytea[]` parameter in binary.

    Per connection rather than on psycopg's global map, which an engine copies when it is created.
    """
    connection.adapters.register_dumper(BinaryList, ListBinaryDumper)


class BinaryList(list[bytes]):
    """A `bytea[]` parameter, which psycopg sends in binary.

    psycopg sends lists as text, which hex-encodes every byte; for a profile's instructions, that
    costs many times the CPU of the per-row INSERTs this replaces. Only this type is sent in binary:
    psycopg cannot send an empty or all-null list of unknown type that way, which a text list has no
    trouble with.
    """


class _ByteaArray(TypeDecorator[list[bytes]]):
    """`bytea[]`, bound as a `BinaryList`.

    Overrides `bind_processor` rather than `process_bind_param`, because the latter's result goes
    through `ARRAY`'s own processor, which would rebuild a plain list.
    """

    impl = ARRAY(LargeBinary, dimensions=1)
    cache_ok = True

    def bind_processor(self, dialect: Dialect) -> Any:
        def process(value: Sequence[bytes] | None) -> BinaryList | None:
            return None if value is None else BinaryList(value)

        return process

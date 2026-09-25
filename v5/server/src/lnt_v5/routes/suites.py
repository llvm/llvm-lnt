"""Test suite creation, inspection, evolution and deletion (endpoints.md, Test Suites).

A suite's schema is the whole document here: the body `POST /api/suites` accepts, the body a `GET`
returns, and what the `schema` table stores (D4). So one suite fetched from an instance can be
posted verbatim to another, and there are no standalone schema or metric-metadata endpoints.

The schema document lives in `suites/schema.py`, the patch document and what applying it means in
`suites/evolve.py`, and the transaction every write shares in `suites/store.py`.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Query, Response
from sqlalchemy.exc import DBAPIError, IntegrityError

from lnt_v5.auth import require_scope
from lnt_v5.db import EngineDep, is_duplicate_schema, unique_violation_constraint
from lnt_v5.errors import ApiError, ErrorCode, ErrorEnvelope
from lnt_v5.responses import Items
from lnt_v5.scopes import Scope
from lnt_v5.suites import evolve
from lnt_v5.suites import tables as suite_tables
from lnt_v5.suites.evolve import SchemaPatch
from lnt_v5.suites.registry import RegistryDep
from lnt_v5.suites.schema import SuiteSchema
from lnt_v5.suites.scope import SUITE_NOT_FOUND
from lnt_v5.suites.store import (
    SCHEMA_NAME_CONSTRAINT,
    bump,
    locked_suite,
    normalized_json,
    suite_write,
)
from lnt_v5.tables import schema as schema_table

SUITES_PATH = "/api/suites"

router = APIRouter(prefix=SUITES_PATH, tags=["Test Suites"])

# endpoints.md requires this on any operation that destroys data. A `bool` rather than a literal
# "true", so R8 documents it as one and a value that is not a boolean is a 400; that also accepts
# `1`, `yes` and `on`, which is a deliberate widening.
Confirm = Annotated[
    bool,
    Query(description="Must be true. Required because this operation destroys data permanently."),
]

_NOT_FOUND = {"model": ErrorEnvelope, "description": SUITE_NOT_FOUND}
# Every write can answer this: the suite was busy and the change could not take its locks (D2).
_BUSY = "The suite is busy and the change should be retried."


def _confirmed(confirm: bool, what: str) -> None:
    if not confirm:
        raise ApiError(ErrorCode.INVALID_REQUEST, f"{what} Pass ?confirm=true to proceed.")


@router.get("", dependencies=[require_scope(Scope.READ)], summary="List test suites")
def list_suites(engine: EngineDep, registry: RegistryDep) -> Items[SuiteSchema]:
    """Every suite on this instance, with its full schema, ordered by name.

    Schemas rather than names alone: suites are limited in number, and parts of the client need
    every suite's metric list up front (endpoints.md).
    """
    with engine.connect() as connection:
        suites = registry.fresh(connection)
    return Items(items=[suites[name].schema for name in sorted(suites)])


@router.post(
    "",
    status_code=201,
    dependencies=[require_scope(Scope.MANAGE)],
    summary="Create a test suite",
    responses={
        409: {"model": ErrorEnvelope, "description": f"A suite with that name exists. {_BUSY}"}
    },
)
def create_suite(body: SuiteSchema, engine: EngineDep, response: Response) -> SuiteSchema:
    """Create a suite from a schema definition, and the tables that schema describes (D2, D5)."""
    try:
        with suite_write(engine, body.name) as connection:
            # The row first: it is the lock every writer of this suite contends on, so two callers
            # racing to create one name serialize here and the loser gets a clean 409 rather than a
            # half-built namespace. It is also the order the other two writes take their locks in.
            connection.execute(
                schema_table.insert().values(name=body.name, schema_json=normalized_json(body))
            )
            suite_tables.create(connection, suite_tables.build(body))
            bump(connection)
    except IntegrityError as error:
        if unique_violation_constraint(error) != SCHEMA_NAME_CONSTRAINT:
            raise
        raise ApiError(
            ErrorCode.DUPLICATE, f"A test suite named '{body.name}' already exists"
        ) from error
    except DBAPIError as error:
        if not is_duplicate_schema(error):
            raise
        raise ApiError(
            ErrorCode.CONFLICT,
            f"A database namespace named '{body.name}' already exists, but no test suite does",
        ) from error

    response.headers["Location"] = f"{SUITES_PATH}/{body.name}"
    return body


@router.get(
    "/{name}",
    dependencies=[require_scope(Scope.READ)],
    summary="Get a test suite",
    responses={404: _NOT_FOUND},
)
def get_suite(name: str, engine: EngineDep, registry: RegistryDep) -> SuiteSchema:
    """A suite's normalized schema -- the same document `POST /api/suites` accepts."""
    with engine.connect() as connection:
        return registry.resolve(connection, name).schema


@router.patch(
    "/{name}/schema",
    dependencies=[require_scope(Scope.MANAGE)],
    summary="Evolve a test suite's schema",
    responses={
        404: {
            "model": ErrorEnvelope,
            "description": "No suite has that name, or an entry to update or remove is not there.",
        },
        409: {
            "model": ErrorEnvelope,
            "description": f"An entry to add is already there. {_BUSY}",
        },
    },
)
def patch_schema(
    name: str, body: SchemaPatch, engine: EngineDep, confirm: Confirm = False
) -> SuiteSchema:
    """Add, update and/or remove entries in a suite's three lists (D2).

    A request that asks for no change is a successful no-op.
    """
    with suite_write(engine, name) as connection:
        current = locked_suite(connection, name)
        if evolve.removes_anything(body):
            _confirmed(confirm, "Removing a schema entry destroys every value stored for it.")
        resulting = evolve.resulting_schema(current, body)
        evolve.apply(connection, name, current, resulting)
    return resulting


@router.delete(
    "/{name}",
    status_code=204,
    dependencies=[require_scope(Scope.MANAGE)],
    summary="Delete a test suite",
    responses={
        404: _NOT_FOUND,
        409: {"model": ErrorEnvelope, "description": _BUSY},
    },
)
def delete_suite(name: str, engine: EngineDep, confirm: Confirm = False) -> None:
    """Delete a suite and every machine, run, commit, sample and regression in it."""
    with suite_write(engine, name) as connection:
        locked_suite(connection, name)
        _confirmed(confirm, f"Deleting '{name}' permanently destroys all of its data.")
        connection.execute(schema_table.delete().where(schema_table.c.name == name))
        suite_tables.drop(connection, name)
        bump(connection)

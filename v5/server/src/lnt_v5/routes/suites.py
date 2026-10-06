"""Test suite creation, inspection, evolution and deletion (E10).

A suite's schema is the whole document here: the body `POST /api/suites` accepts, the body a `GET`
returns, and what the `schema` table stores (D4). So one suite fetched from an instance can be
posted verbatim to another, and there are no standalone schema or metric-metadata endpoints.

The schema document lives in `suites/schema.py`, the patch document and what applying it means in
`suites/evolve.py`, and the transaction every write shares in `suites/store.py`.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Body, Query, Response
from sqlalchemy.exc import DBAPIError, IntegrityError

from lnt_v5 import examples
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
from lnt_v5.suites.scope import SUITE_NOT_FOUND, SuiteName
from lnt_v5.suites.store import (
    SCHEMA_NAME_CONSTRAINT,
    add_suite,
    bump,
    locked_suite,
    suite_write,
)
from lnt_v5.tables import schema as schema_table

SUITES_PATH = "/api/suites"

router = APIRouter(prefix=SUITES_PATH, tags=["Test Suites"])

# endpoints.md requires this on any operation that destroys data. A `bool` rather than a literal
# "true", so I8 documents it as one and a value that is not a boolean is a 400; that also accepts
# `1`, `yes` and `on`, which is a deliberate widening.
Confirm = Annotated[
    bool,
    Query(description="Set to `true` to confirm. Required, because this permanently deletes data."),
]

# The same, on a schema change, which destroys data only when it removes an entry.
ConfirmRemoval = Annotated[
    bool,
    Query(
        description=(
            "Set to `true` to confirm, if the request removes a metric or field: that permanently "
            "deletes its data. Not needed otherwise."
        )
    ),
]

_NOT_FOUND = {"model": ErrorEnvelope, "description": SUITE_NOT_FOUND}
# Every write can answer this: the suite was busy and the change could not take its locks (D2).
_BUSY = (
    "`retry`: the suite was busy, for example because another request was reading it, so the "
    "change couldn't start. Nothing was saved: send the request again."
)

_CREATE_EXAMPLES = {
    "libcxx": {"summary": "The suite for libc++'s benchmarks", "value": examples.SUITE_SCHEMA},
}

_PATCH_EXAMPLES = {
    "add_and_update": {
        "summary": "Add a commit field and change a metric's display name",
        "value": {
            "commit_fields": {"add": [{"name": "author", "type": "text", "searchable": True}]},
            "metrics": {"update": [{"name": "max_rss", "display_name": "Max RSS"}]},
        },
    },
    "remove": {
        "summary": "Remove a machine field (requires confirm=true)",
        "value": {"machine_fields": {"remove": ["test_suite_commit"]}},
    },
}


def _confirmed(confirm: bool, what: str) -> None:
    if not confirm:
        raise ApiError(ErrorCode.INVALID_REQUEST, f"{what} Pass ?confirm=true to proceed.")


# The docstrings of the endpoints below are published, as the descriptions I8's document gives them,
# so they are written for API users.


# Schemas rather than names alone: suites are limited in number, and parts of the client need every
# suite's metric list up front (E10).
@router.get("", dependencies=[require_scope(Scope.READ)], summary="List test suites")
def list_suites(engine: EngineDep, registry: RegistryDep) -> Items[SuiteSchema]:
    """All test suites on this instance, with their schemas, sorted by name."""
    with engine.connect() as connection:
        suites = registry.fresh(connection)
    return Items(items=[suites[name].schema for name in sorted(suites)])


@router.post(
    "",
    status_code=201,
    dependencies=[require_scope(Scope.MANAGE)],
    summary="Create a test suite",
    responses={
        409: {
            "model": ErrorEnvelope,
            "description": "`duplicate`: a suite with this name already exists. `conflict`: the "
            f"name is already used in the database by something other than a test suite. {_BUSY}",
        }
    },
)
def create_suite(
    body: Annotated[SuiteSchema, Body(openapi_examples=_CREATE_EXAMPLES)],
    engine: EngineDep,
    response: Response,
) -> SuiteSchema:
    """Create a test suite from a schema.

    The response is the schema with all optional keys filled in. Its `Location` header points to
    the new suite.
    """
    try:
        with suite_write(engine, body.name) as connection:
            add_suite(connection, body)
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
def get_suite(name: SuiteName, engine: EngineDep, registry: RegistryDep) -> SuiteSchema:
    """A test suite's schema, with all optional keys filled in. It can be used as-is to create the
    same suite on another instance."""
    with engine.connect() as connection:
        return registry.resolve(connection, name).schema


@router.patch(
    "/{name}/schema",
    dependencies=[require_scope(Scope.MANAGE)],
    summary="Change a test suite's schema",
    responses={
        404: {
            "model": ErrorEnvelope,
            "description": (
                "The test suite, or a metric or field you are updating or removing, doesn't exist."
            ),
        },
        409: {
            "model": ErrorEnvelope,
            "description": f"`duplicate`: a metric or field you are adding already exists. {_BUSY}",
        },
    },
)
def patch_schema(
    name: SuiteName,
    body: Annotated[SchemaPatch, Body(openapi_examples=_PATCH_EXAMPLES)],
    engine: EngineDep,
    confirm: ConfirmRemoval = False,
) -> SuiteSchema:
    """Add, update or remove metrics, commit fields and machine fields. Returns the updated schema.

    Only display settings can be updated. To change the type of a metric or field, remove it and
    add it again. Removing a metric or field permanently deletes its data, so the request must
    include `confirm=true`.
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
def delete_suite(name: SuiteName, engine: EngineDep, confirm: Confirm = False) -> None:
    """Delete a test suite and all its data: machines, commits, runs, samples, profiles and
    regressions. This can't be undone, so the request must include `confirm=true`."""
    with suite_write(engine, name) as connection:
        locked_suite(connection, name)
        _confirmed(confirm, f"Deleting '{name}' permanently destroys all of its data.")
        connection.execute(schema_table.delete().where(schema_table.c.name == name))
        suite_tables.drop(connection, name)
        bump(connection)

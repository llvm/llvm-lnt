"""Test suite creation, inspection, evolution and deletion (E10), in a project (D7).

A suite's schema is the whole document here: the body `POST /api/projects/{project}/suites`
accepts, the body a `GET` returns, and what the `schema` table stores (D4). So one suite fetched
from an instance or a project can be posted verbatim to another, and there are no standalone schema
or metric-metadata endpoints.

The schema document lives in `suites/schema.py`, the patch document and what applying it means in
`suites/evolve.py`, and the transaction every write shares in `suites/store.py`.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Annotated

from fastapi import APIRouter, Body, Query, Response

from lnt_v5 import examples
from lnt_v5.auth import Coverage, require_scope
from lnt_v5.db import EngineDep, reporting_violation
from lnt_v5.errors import ApiError, ErrorCode, ErrorEnvelope
from lnt_v5.responses import Items
from lnt_v5.scopes import Scope
from lnt_v5.suites import evolve
from lnt_v5.suites import tables as suite_tables
from lnt_v5.suites.evolve import SchemaPatch
from lnt_v5.suites.registry import RegistryDep, Suite
from lnt_v5.suites.schema import SuiteSchema
from lnt_v5.suites.scope import SUITE_NOT_FOUND, ProjectName, SuiteName
from lnt_v5.suites.store import (
    SCHEMA_NAME_CONSTRAINT,
    add_suite,
    bump,
    full_name,
    locked_suite,
    suite_write,
)
from lnt_v5.tables import schema as schema_table

PROJECTS_PATH = "/api/projects"
SUITES_PATH = f"{PROJECTS_PATH}/{{project}}/suites"

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
    "display_name": {
        "summary": "Change the suite's display name",
        "value": {"display_name": "libc++ microbenchmarks"},
    },
    "repository": {
        "summary": "Change the repository's commit URL and remove its label",
        "value": {"repository": {"commit_url": examples.REPOSITORY["commit_url"], "label": None}},
    },
}


def _confirmed(confirm: bool, what: str) -> None:
    if not confirm:
        raise ApiError(ErrorCode.INVALID_REQUEST, f"{what} Pass ?confirm=true to proceed.")


# The docstrings of the endpoints below are published, as the descriptions I8's document gives them,
# so they are written for API users.


def sorted_schemas(suites: Mapping[str, Suite]) -> list[SuiteSchema]:
    """The schemas of `suites`, by name (E10, E13)."""
    return [suites[name].schema for name in sorted(suites)]


# Schemas rather than names alone: suites are limited in number, and parts of the client need every
# suite's metric list up front (E10).
@router.get(
    "",
    dependencies=[require_scope(Scope.READ)],
    summary="List a project's test suites",
    responses={404: {"model": ErrorEnvelope, "description": "The project doesn't exist."}},
)
def list_suites(
    project: ProjectName, engine: EngineDep, registry: RegistryDep
) -> Items[SuiteSchema]:
    """The project's test suites, with their schemas, sorted by name."""
    with engine.connect() as connection:
        found = registry.resolve_project(connection, project)
    return Items(items=sorted_schemas(found.suites))


@router.post(
    "",
    status_code=201,
    dependencies=[require_scope(Scope.MANAGE, Coverage.PROJECT)],
    summary="Create a test suite",
    responses={
        404: {"model": ErrorEnvelope, "description": "The project doesn't exist."},
        409: {
            "model": ErrorEnvelope,
            "description": (
                f"`duplicate`: the project already has a suite with this name. {_BUSY}"
            ),
        },
    },
)
def create_suite(
    project: ProjectName,
    body: Annotated[SuiteSchema, Body(openapi_examples=_CREATE_EXAMPLES)],
    engine: EngineDep,
    response: Response,
) -> SuiteSchema:
    """Create a test suite in the project, from a schema.

    The response is the schema with all optional keys filled in. Its `Location` header points to
    the new suite.
    """
    taken = f"A test suite named '{full_name(project, body.name)}' already exists"
    with (
        reporting_violation(SCHEMA_NAME_CONSTRAINT, ErrorCode.DUPLICATE, taken),
        suite_write(engine, project, body.name) as connection,
    ):
        add_suite(connection, project, body)
    # Both names are slugs (D4, D7), which need no quoting.
    response.headers["Location"] = f"{SUITES_PATH.format(project=project)}/{body.name}"
    return body


@router.get(
    "/{suite}",
    dependencies=[require_scope(Scope.READ)],
    summary="Get a test suite",
    responses={404: _NOT_FOUND},
)
def get_suite(
    project: ProjectName, name: SuiteName, engine: EngineDep, registry: RegistryDep
) -> SuiteSchema:
    """A test suite's schema, with all optional keys filled in. It can be used as-is to create the
    same suite in another project or on another instance."""
    with engine.connect() as connection:
        return registry.resolve(connection, project, name).schema


@router.patch(
    "/{suite}/schema",
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
    project: ProjectName,
    name: SuiteName,
    body: Annotated[SchemaPatch, Body(openapi_examples=_PATCH_EXAMPLES)],
    engine: EngineDep,
    confirm: ConfirmRemoval = False,
) -> SuiteSchema:
    """Add, update or remove metrics, commit fields and machine fields, or change the display name
    or the repository. Returns the updated schema.

    Only display settings can be updated. To change the type of a metric or field, remove it and
    add it again. Removing a metric or field permanently deletes its data, so the request must
    include `confirm=true`.
    """
    with suite_write(engine, project, name) as connection:
        stored = locked_suite(connection, project, name)
        if evolve.removes_anything(body):
            _confirmed(confirm, "Removing a schema entry destroys every value stored for it.")
        resulting = evolve.resulting_schema(stored.schema, body)
        evolve.apply(connection, stored, resulting)
    return resulting


@router.delete(
    "/{suite}",
    status_code=204,
    dependencies=[require_scope(Scope.MANAGE)],
    summary="Delete a test suite",
    responses={
        404: _NOT_FOUND,
        409: {"model": ErrorEnvelope, "description": _BUSY},
    },
)
def delete_suite(
    project: ProjectName, name: SuiteName, engine: EngineDep, confirm: Confirm = False
) -> None:
    """Delete a test suite and all its data: machines, commits, runs, samples, profiles and
    regressions. This can't be undone, so the request must include `confirm=true`.

    The suite is also removed from the API keys that list it. A test suite created later with the
    same name is a different suite, which those keys don't cover."""
    with suite_write(engine, project, name) as connection:
        stored = locked_suite(connection, project, name)
        _confirmed(confirm, f"Deleting '{stored.full_name}' permanently destroys all of its data.")
        # Takes the suite's API key restriction rows with it (I5).
        connection.execute(schema_table.delete().where(schema_table.c.id == stored.id))
        suite_tables.drop(connection, stored.namespace)
        bump(connection)

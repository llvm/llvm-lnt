"""Projects, which group test suites (E13, D7).

A project's suites are managed through E10, under the project's path. Here are the projects
themselves: listing them with their suites, creating them, changing their display names and deleting
them. Renaming a project is not supported yet.
"""

from __future__ import annotations

from typing import Annotated, Any

from fastapi import APIRouter, Body, Response
from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    ModelWrapValidatorHandler,
    PrivateAttr,
    model_validator,
)
from sqlalchemy import insert, select, update

from lnt_v5 import examples
from lnt_v5.auth import Coverage, require_scope
from lnt_v5.db import EngineDep, reporting_violation
from lnt_v5.errors import ApiError, ErrorCode, ErrorEnvelope
from lnt_v5.patching import omit_defaults
from lnt_v5.responses import Items
from lnt_v5.routes.suites import PROJECTS_PATH, sorted_schemas
from lnt_v5.scopes import Scope
from lnt_v5.suites.registry import Project as CachedProject
from lnt_v5.suites.registry import RegistryDep
from lnt_v5.suites.schema import SuiteLabel, SuiteNameStr, SuiteSchema
from lnt_v5.suites.scope import ProjectName
from lnt_v5.suites.store import (
    PROJECT_NAME_CONSTRAINT,
    SCHEMA_PROJECT_CONSTRAINT,
    bump,
    project_not_found,
    project_write,
)
from lnt_v5.tables import SUITE_NAME_MAX_LENGTH
from lnt_v5.tables import project as project_table

router = APIRouter(prefix=PROJECTS_PATH, tags=["Projects"])

_NOT_FOUND = {"model": ErrorEnvelope, "description": "The project doesn't exist."}
# A display-name change and a deletion can answer this: the project was busy (D2).
_BUSY = (
    "`retry`: the project was busy, for example because a test suite was being created in it, so "
    "the change couldn't start. Nothing was saved: send the request again."
)

# The docstrings of the models and endpoints below are published, as the descriptions I8's document
# gives them, so they are written for API users.

_PROJECT_NAME = (
    "The project's name. Lowercase letters, digits, hyphens and underscores, starting with a "
    f"letter or a digit, and at most {SUITE_NAME_MAX_LENGTH} characters."
)
_DISPLAY_NAME = (
    "How the web UI names the project, instead of its `name`. At most 256 characters. Only the "
    "name addresses the project in the API."
)


class Project(BaseModel):
    """A project, which groups test suites, with its suites."""

    model_config = ConfigDict(json_schema_extra={"examples": [examples.PROJECT]})

    name: str = Field(description=_PROJECT_NAME)
    display_name: str | None = Field(description=f"{_DISPLAY_NAME} Null if there is none.")
    suites: list[SuiteSchema] = Field(description="The project's test suites, sorted by name.")

    @classmethod
    def of(cls, cached: CachedProject) -> Project:
        return cls(
            name=cached.name,
            display_name=cached.display_name,
            suites=sorted_schemas(cached.suites),
        )


class ProjectCreate(BaseModel):
    """The name and display name of a new project."""

    model_config = ConfigDict(extra="forbid")

    name: SuiteNameStr = Field(description=_PROJECT_NAME)
    display_name: SuiteLabel | None = Field(
        default=None, description=f"{_DISPLAY_NAME} Null, or left out, if there is none."
    )


# What `ProjectUpdate` holds as its name when the request gives none.
_NO_NAME = object()


class ProjectUpdate(BaseModel):
    """Changes to a project. Only include the keys you want to change."""

    # Read with `exclude_unset`, so the default is never read, and kept out of the document.
    model_config = ConfigDict(extra="forbid", json_schema_extra=omit_defaults)

    display_name: SuiteLabel | None = Field(
        default=None, description=f"{_DISPLAY_NAME} Null removes it."
    )

    # A `name`, which only the project's current name may be for now (see `patch_project`). Not a
    # field, so that the document leaves it out until a project can be renamed.
    _name: Any = PrivateAttr(default=_NO_NAME)

    @model_validator(mode="wrap")
    @classmethod
    def _take_name(cls, data: Any, handler: ModelWrapValidatorHandler[ProjectUpdate]) -> Any:
        # Taken out before validation, so that `extra="forbid"` does not refuse it.
        name = _NO_NAME
        if isinstance(data, dict) and "name" in data:
            data = dict(data)
            name = data.pop("name")
        model = handler(data)
        model._name = name
        return model


_CREATE_EXAMPLES = {
    "libcxx": {
        "summary": "The project of libc++",
        "value": {"name": examples.PROJECT["name"], "display_name": "libc++"},
    },
}

_PATCH_EXAMPLES = {
    "display_name": {
        "summary": "Change the project's display name",
        "value": {"display_name": examples.PROJECT["display_name"]},
    },
    "no_display_name": {
        "summary": "Remove the project's display name",
        "value": {"display_name": None},
    },
}


@router.get("", dependencies=[require_scope(Scope.READ)], summary="List projects")
def list_projects(engine: EngineDep, registry: RegistryDep) -> Items[Project]:
    """Every project, with its test suites and their schemas, sorted by name. Projects without test
    suites are included."""
    with engine.connect() as connection:
        projects = registry.fresh(connection)
    return Items(items=[Project.of(projects[name]) for name in sorted(projects)])


@router.post(
    "",
    status_code=201,
    dependencies=[require_scope(Scope.MANAGE)],
    summary="Create a project",
    responses={
        409: {"model": ErrorEnvelope, "description": "`duplicate`: a project has this name."}
    },
)
def create_project(
    body: Annotated[ProjectCreate, Body(openapi_examples=_CREATE_EXAMPLES)],
    engine: EngineDep,
    response: Response,
) -> Project:
    """Create a project, without test suites. Its `Location` header points to the new project.

    Requires an unrestricted API key, since a project shapes the instance."""
    taken = f"A project named '{body.name}' already exists"
    with (
        reporting_violation(PROJECT_NAME_CONSTRAINT, ErrorCode.DUPLICATE, taken),
        engine.begin() as connection,
    ):
        connection.execute(
            insert(project_table).values(name=body.name, display_name=body.display_name)
        )
        bump(connection)
    response.headers["Location"] = f"{PROJECTS_PATH}/{body.name}"
    return Project(name=body.name, display_name=body.display_name, suites=[])


@router.get(
    "/{project}",
    dependencies=[require_scope(Scope.READ)],
    summary="Get a project",
    responses={404: _NOT_FOUND},
)
def get_project(project: ProjectName, engine: EngineDep, registry: RegistryDep) -> Project:
    """A project, with its test suites and their schemas."""
    with engine.connect() as connection:
        return Project.of(registry.resolve_project(connection, project))


@router.patch(
    "/{project}",
    dependencies=[require_scope(Scope.MANAGE, Coverage.PROJECT)],
    summary="Change a project",
    responses={404: _NOT_FOUND, 409: {"model": ErrorEnvelope, "description": _BUSY}},
)
def patch_project(
    project: ProjectName,
    body: Annotated[ProjectUpdate, Body(openapi_examples=_PATCH_EXAMPLES)],
    engine: EngineDep,
    registry: RegistryDep,
) -> Project:
    """Change a project's display name, or remove it with null. A body that changes nothing, an
    empty one included, changes nothing."""
    changes = body.model_dump(exclude_unset=True)
    with project_write(engine, project) as connection:
        # FOR NO KEY UPDATE, which does not wait for a suite being created in the project.
        stored = connection.execute(
            select(project_table.c.display_name)
            .where(project_table.c.name == project)
            .with_for_update(key_share=True)
        ).one_or_none()
        if stored is None:
            raise project_not_found(project)
        if body._name is not _NO_NAME and body._name != project:
            raise ApiError(ErrorCode.INVALID_REQUEST, "Renaming a project is not supported yet.")
        if "display_name" in changes and changes["display_name"] != stored.display_name:
            connection.execute(
                update(project_table)
                .where(project_table.c.name == project)
                .values(display_name=changes["display_name"])
            )
            bump(connection)
    with engine.connect() as connection:
        return Project.of(registry.resolve_project(connection, project))


@router.delete(
    "/{project}",
    status_code=204,
    dependencies=[require_scope(Scope.MANAGE)],
    summary="Delete a project",
    responses={
        404: _NOT_FOUND,
        409: {
            "model": ErrorEnvelope,
            "description": f"`conflict`: the project still has test suites. {_BUSY}",
        },
    },
)
def delete_project(project: ProjectName, engine: EngineDep) -> None:
    """Delete a project that has no test suites. It destroys no data, so it doesn't need
    `confirm=true`. The project is also removed from the API keys that list it.

    Requires an unrestricted API key, since a project shapes the instance."""
    has_suites = (
        f"Project '{project}' still has test suites: delete them, or move them to another "
        "project, first."
    )
    # A suite that the project still has refuses the deletion through its foreign key, even one
    # whose creation commits while the deletion waits for the project's row (D2).
    with (
        reporting_violation(SCHEMA_PROJECT_CONSTRAINT, ErrorCode.CONFLICT, has_suites),
        project_write(engine, project) as connection,
    ):
        deleted = connection.execute(
            project_table.delete()
            .where(project_table.c.name == project)
            .returning(project_table.c.id)
        ).first()
        if deleted is None:
            raise project_not_found(project)
        bump(connection)

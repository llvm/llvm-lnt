"""The API index (I1).

The paths the index points at are defined here, and `app.py` reads the documentation ones back
when it configures FastAPI, so there is one place that decides where they live.
"""

from __future__ import annotations

from fastapi import APIRouter, Request
from pydantic import BaseModel, Field

from lnt_v5.auth import require_scope
from lnt_v5.routes.suites import PROJECTS_PATH
from lnt_v5.scopes import Scope

INDEX_PATH = "/api"
OPENAPI_PATH = "/api/openapi.json"
DOCS_PATH = "/api/docs"


# The docstrings of the models and the endpoint below are published, as the descriptions I8's
# document gives them, so they are written for API users.
class ApiLinks(BaseModel):
    """Links to the main parts of the API."""

    projects: str = Field(
        description="The list of projects, with their test suites. All other data is under it.",
        examples=[PROJECTS_PATH],
    )
    openapi: str = Field(description="The API's OpenAPI specification.", examples=[OPENAPI_PATH])
    docs: str = Field(
        description="This page: interactive documentation for the API.", examples=[DOCS_PATH]
    )


class ApiIndex(BaseModel):
    """Links to the project list and to the API documentation, and the server's revision."""

    links: ApiLinks
    revision: str | None = Field(
        description="The commit of LNT this server was built from, as a lowercase hexadecimal "
        "commit hash, possibly abbreviated. Null when the server does not know it.",
        examples=["0dd267f1"],
    )


router = APIRouter(tags=["Discovery"])


@router.get(INDEX_PATH, dependencies=[require_scope(Scope.READ)], summary="API index")
def index(request: Request) -> ApiIndex:
    """The starting point of the API, with links to the projects and to this page, and the
    commit of LNT the server was built from.
    """
    return ApiIndex(
        links=ApiLinks(projects=PROJECTS_PATH, openapi=OPENAPI_PATH, docs=DOCS_PATH),
        revision=request.app.state.revision,
    )

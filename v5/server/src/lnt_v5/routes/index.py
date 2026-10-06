"""The API index (I1).

The paths the index points at are defined here, and `app.py` reads the documentation ones back
when it configures FastAPI, so there is one place that decides where they live.
"""

from __future__ import annotations

from fastapi import APIRouter
from pydantic import BaseModel, Field

from lnt_v5.auth import require_scope
from lnt_v5.routes.suites import SUITES_PATH
from lnt_v5.scopes import Scope

INDEX_PATH = "/api"
OPENAPI_PATH = "/api/openapi.json"
DOCS_PATH = "/api/docs"


# The docstrings of the models and the endpoint below are published, as the descriptions I8's
# document gives them, so they are written for API users.
class ApiLinks(BaseModel):
    """Links to the main parts of the API."""

    suites: str = Field(
        description="The list of test suites. All other data is under it.",
        examples=[SUITES_PATH],
    )
    openapi: str = Field(description="The API's OpenAPI specification.", examples=[OPENAPI_PATH])
    docs: str = Field(
        description="This page: interactive documentation for the API.", examples=[DOCS_PATH]
    )


class ApiIndex(BaseModel):
    """Links to the test suite list and to the API documentation."""

    links: ApiLinks


router = APIRouter(tags=["Discovery"])


@router.get(INDEX_PATH, dependencies=[require_scope(Scope.READ)], summary="API index")
def index() -> ApiIndex:
    """The starting point of the API, with links to the test suites and to this page."""
    return ApiIndex(links=ApiLinks(suites=SUITES_PATH, openapi=OPENAPI_PATH, docs=DOCS_PATH))

"""The API index (R1).

The paths the index points at are defined here, and `app.py` reads the documentation ones back
when it configures FastAPI, so there is one place that decides where they live.
"""

from __future__ import annotations

from fastapi import APIRouter
from pydantic import BaseModel

from lnt_v5.auth import require_scope
from lnt_v5.scopes import Scope

INDEX_PATH = "/api/"
OPENAPI_PATH = "/api/openapi.json"
DOCS_PATH = "/api/docs"
SUITES_PATH = "/api/suites"


class ApiLinks(BaseModel):
    suites: str
    openapi: str
    docs: str


class ApiIndex(BaseModel):
    """Links to the test suite list and to the API documentation."""

    links: ApiLinks


router = APIRouter(tags=["Discovery"])


@router.get(INDEX_PATH, dependencies=[require_scope(Scope.READ)], summary="API index")
# `GET /api` would otherwise reach the SPA mount, which matches every path and answers 404 for
# anything under /api/. Starlette's slash redirect never gets a chance to run, so the obvious URL
# is registered outright. Excluded from the document, which describes /api/.
@router.get(
    INDEX_PATH.rstrip("/"), dependencies=[require_scope(Scope.READ)], include_in_schema=False
)
def index() -> ApiIndex:
    return ApiIndex(links=ApiLinks(suites=SUITES_PATH, openapi=OPENAPI_PATH, docs=DOCS_PATH))

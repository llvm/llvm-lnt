"""Keeping R8's document inside the surface R4 permits.

Two corrections to what FastAPI generates on its own.

It documents a `422` on every operation that takes a body or any parameter. R4 does not permit
422, and `errors.py` already turns the validation failure behind it into a `400`, so the document
has to say 400.

And it knows nothing about R5, so nothing would say that a scoped operation can answer 401 or 403.
Those are derived from each route's declared scope rather than restated on every endpoint: there
will eventually be dozens of them, all with identical auth failures, and a derived answer cannot
drift from the scope the route actually enforces.
"""

from __future__ import annotations

import json
from typing import Any

from fastapi import FastAPI

from .auth import iter_routes, required_scope
from .errors import ErrorEnvelope
from .scopes import Scope

ERROR_SCHEMA_REF = "#/components/schemas/ErrorEnvelope"


def _error(description: str) -> dict[str, Any]:
    return {
        "description": description,
        "content": {"application/json": {"schema": {"$ref": ERROR_SCHEMA_REF}}},
    }


# Worded from R5. The 400 covers both of the ways an operation reaches it: an unreadable
# Authorization header, and a body or parameter that fails validation.
_BAD_REQUEST = _error("The request, or its Authorization header, is malformed.")
_UNAUTHORIZED = _error("No API key was presented, or the one presented is unknown or revoked.")
_FORBIDDEN = _error("The API key is valid but does not grant the scope this endpoint requires.")


def _error_schemas() -> dict[str, Any]:
    """`ErrorEnvelope` and what it references, as component schemas.

    Injected rather than left to FastAPI, which only emits a model some route declares. The
    responses added below reference it on operations that may declare nothing of their own.
    """
    schema = ErrorEnvelope.model_json_schema(ref_template="#/components/schemas/{model}")
    nested = schema.pop("$defs", {})
    return {"ErrorEnvelope": schema, **nested}


def _scopes_by_operation(app: FastAPI) -> dict[tuple[str, str], Scope]:
    """The scope each documented operation requires, keyed the way `paths` is."""
    scopes: dict[tuple[str, str], Scope] = {}
    for route in iter_routes(app.routes):
        scope = required_scope(route)
        if scope is None or not route.include_in_schema or route.path_format is None:
            continue
        for method in route.methods or ():
            scopes[(route.path_format, method.lower())] = scope
    return scopes


# What FastAPI emits alongside the 422 responses removed above, and nothing else references once
# they are gone. Ordered so that dropping the first leaves the second unreferenced.
_VALIDATION_SCHEMAS = ("HTTPValidationError", "ValidationError")


def _drop_unreferenced_validation_schemas(document: dict[str, Any]) -> None:
    """Remove the schemas left behind by the 422 responses, unless something still points at one."""
    schemas = document.get("components", {}).get("schemas", {})
    for name in _VALIDATION_SCHEMAS:
        if name not in schemas:
            continue
        remaining = {key: value for key, value in schemas.items() if key != name}
        elsewhere = json.dumps({"paths": document.get("paths", {}), "schemas": remaining})
        if f"#/components/schemas/{name}" not in elsewhere:
            del schemas[name]


def _correct(app: FastAPI, document: dict[str, Any]) -> None:
    scopes = _scopes_by_operation(app)
    schemas = document.setdefault("components", {}).setdefault("schemas", {})
    for name, schema in _error_schemas().items():
        schemas.setdefault(name, schema)

    for path, operations in document.get("paths", {}).items():
        for method, operation in operations.items():
            responses = operation.setdefault("responses", {})
            validation_failure = responses.pop("422", None)

            scope = scopes.get((path, method))
            if scope is not None:
                responses.setdefault("400", _BAD_REQUEST)
                responses.setdefault("401", _UNAUTHORIZED)
                # A read-scoped operation can never answer 403: every valid key grants `read`.
                if scope is not Scope.READ:
                    responses.setdefault("403", _FORBIDDEN)
            elif validation_failure is not None:
                responses.setdefault("400", _BAD_REQUEST)

    _drop_unreferenced_validation_schemas(document)


def use_r4_error_responses(app: FastAPI) -> None:
    """Make `app.openapi()` describe the errors the API actually produces."""
    generate = app.openapi

    def openapi() -> dict[str, Any]:
        # `generate` caches into `app.openapi_schema` and returns that same dict, so correcting it
        # in place is what makes this run once rather than on every request for the document.
        if app.openapi_schema is not None:
            return app.openapi_schema
        document = generate()
        _correct(app, document)
        return document

    app.openapi = openapi  # type: ignore[method-assign]

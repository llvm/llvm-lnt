"""Turning what FastAPI generates into I8's document.

FastAPI builds the document from the routes and models, but some of what I8 asks of it is beyond
what FastAPI knows, and some of what it emits on its own is wrong. Both are fixed here, once, rather
than restated on every endpoint, where dozens of copies could drift from what the code enforces.

What it gets wrong: it documents a `422` on every operation that takes a body or any parameter. I4
does not permit 422, and `errors.py` already turns the validation failure behind it into a `400`, so
the document has to say 400. It also drops every null from the document, examples included, which
empties the request examples that clear a value and leaves sample responses without keys the API
always sends. And it describes a nullable field declared through an annotated alias inside the
field's non-null branch rather than on the field.

Every example in the document comes from `examples.py`, so that they describe one plausible suite
rather than whatever a viewer would make up.

What it does not know: I5. It cannot tell which scope an operation requires, that a `read`-scoped
one needs no key at all, or that a scoped operation can answer 401 and 403 -- nor I3, under which
every scoped operation refuses a query parameter it does not take, a 400. All of that is derived
from each route's declared scope, so it cannot disagree with the scope the route enforces.

And it names the components of generic models after their type parameters (`CursorPage_Run_`),
which is noise in a document meant for people; they are renamed after what they hold.

Everything prose in the document is written for API users rather than for maintainers of this code:
route docstrings, model docstrings and field descriptions are all published (I8). The overview that
opens the document is `openapi.md`, beside this module, so that it stays diffable as prose.
"""

from __future__ import annotations

import copy
import json
import re
from pathlib import Path
from typing import Any

from fastapi import FastAPI
from fastapi.routing import APIRoute
from pydantic import BaseModel
from pydantic.json_schema import models_json_schema

from .auth import SECURITY_SCHEME, iter_routes, required_scope
from .errors import ErrorEnvelope
from .scopes import Scope

ERROR_SCHEMA_REF = "#/components/schemas/ErrorEnvelope"

# Read once, at import, like `llms.txt`: a packaging mistake that lost it should fail the process.
OVERVIEW = Path(__file__).with_name("openapi.md").read_text(encoding="utf-8")

# Every tag a router declares, in the order the viewer lists them: from the entry point, through a
# suite and what it holds, to triage, and administration last. A tag missing here would still be
# listed, but after all of these, and without a description; a test keeps the two in step.
TAGS: list[dict[str, str]] = [
    {
        "name": "Discovery",
        "description": "The starting point, with links to the test suites and to this page.",
    },
    {
        "name": "Authentication",
        "description": "Check the API key a request is made with.",
    },
    {
        "name": "Test Suites",
        "description": (
            "Create, view, change and delete test suites. A suite's schema lists the metrics its "
            "tests report and the fields its machines and commits have. Almost all other data "
            "belongs to a suite."
        ),
    },
    {
        "name": "Machines",
        "description": (
            "The machines that benchmarks run on. A machine is created when a run is first "
            "submitted for it, or explicitly."
        ),
    },
    {
        "name": "Commits",
        "description": (
            "The versions that were benchmarked: a Git SHA, a version number or any other label. "
            "A commit's ordinal sets its position in the suite's history, which is how time "
            "series are ordered. A commit is created when a run is first submitted for it, or "
            "explicitly."
        ),
    },
    {
        "name": "Runs",
        "description": (
            "Submit results, and list, view and delete runs. A run is one set of results, for one "
            "machine at one commit."
        ),
    },
    {"name": "Samples", "description": "The individual measurements recorded by a run."},
    {
        "name": "Tests",
        "description": "The benchmarks a suite has results for. Tests are created as runs are "
        "submitted.",
    },
    {
        "name": "Profiles",
        "description": (
            "Hardware performance counters measured per instruction, for one test in one run. "
            "Profiles are submitted along with their run."
        ),
    },
    {
        "name": "Time Series",
        "description": "A metric's values over time, and trends across machines.",
    },
    {
        "name": "Regressions",
        "description": (
            "Track performance regressions as they are investigated. A regression's indicators "
            "list the machines, tests and metrics where it was seen. LNT doesn't detect "
            "regressions itself: people or external tools record them here."
        ),
    },
    {"name": "Admin", "description": "Manage API keys."},
]

# The viewer's settings. A token entered through Authorize survives reloading the page, which is
# what makes trying out a sequence of authenticated operations bearable.
SWAGGER_UI_PARAMETERS = {"persistAuthorization": True}


def operation_id(route: APIRoute) -> str:
    """Name an operation after its endpoint function: `list_runs` rather than FastAPI's default,
    which appends the path and the method (`list_runs_api_suites__testsuite__runs_get`).

    Unique because the function names are; a test holds them to it.
    """
    return route.name


def _error(description: str) -> dict[str, Any]:
    return {
        "description": description,
        "content": {"application/json": {"schema": {"$ref": ERROR_SCHEMA_REF}}},
    }


_BAD_REQUEST = _error(
    "The request is invalid. This includes query parameters the operation doesn't accept, and "
    "single-valued parameters given more than once."
)
# Worded from I5.
_UNAUTHORIZED = _error(
    "This operation needs an API key and none was sent, or the key is malformed, unknown or "
    "revoked."
)
_FORBIDDEN = _error("The API key doesn't have the scope this operation requires.")


def _authorization(scope: Scope) -> str:
    """The sentence that tells a reader of one operation what it takes to call it."""
    if scope is Scope.READ:
        return "**Authorization:** no API key needed."
    return f"**Authorization:** requires an API key with the `{scope.value}` scope."


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


def _document_scope(operation: dict[str, Any], scope: Scope) -> None:
    """State the scope an operation requires, for people and for tools.

    For people, a sentence closing the description. For tools, the security requirement: OpenAPI
    3.1 lets a requirement on a scheme other than OAuth2 list the roles it needs, and the scope is
    exactly that. A `read`-scoped operation also lists the empty requirement, which is how OpenAPI
    says that a caller may send no credentials at all -- I5's anonymous read access.
    """
    requirement = {SECURITY_SCHEME: [scope.value]}
    operation["security"] = [{}, requirement] if scope is Scope.READ else [requirement]

    sentence = _authorization(scope)
    description = operation.get("description")
    operation["description"] = f"{description}\n\n{sentence}" if description else sentence


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


# The envelopes in `responses.py`, as FastAPI names a parametrization of each, what they are called
# instead (`CursorPage_Run_` becomes `RunCursorPage`), and how they are described, which pydantic
# does not carry over from the generic class.
_ENVELOPE = re.compile(r"(CursorPage|OffsetPage|Items)_([A-Za-z0-9]+)_")
_ENVELOPES = {
    "CursorPage": (
        "{}CursorPage",
        "One page of results. To get the next page, repeat the request with `cursor` set to "
        "`cursor.next`.",
    ),
    "OffsetPage": (
        "{}OffsetPage",
        "One page of results, with the total number of results across all pages.",
    ),
    "Items": ("{}List", "All the results."),
}


def _rename_envelopes(document: dict[str, Any]) -> None:
    """Rename and describe every envelope component, and rewrite every reference to one.

    Done here rather than in pydantic, which derives a generic model's component name from the
    generic class and its arguments whatever the parametrized class calls itself.
    """
    schemas = document.get("components", {}).get("schemas", {})
    renames: dict[str, tuple[str, str]] = {}
    for name in schemas:
        match = _ENVELOPE.fullmatch(name)
        if match is not None:
            pattern, description = _ENVELOPES[match[1]]
            renames[name] = (pattern.format(match[2]), description)
    clashes = {new for new, _ in renames.values()} & set(schemas)
    if clashes:
        raise RuntimeError(f"Renamed envelopes would replace existing schemas: {sorted(clashes)}")

    for old, (new, description) in renames.items():
        schema = schemas.pop(old)
        # The title is what the viewer shows as the schema's name.
        schema["title"] = new
        schema["description"] = description
        schemas[new] = schema
    document["components"]["schemas"] = dict(sorted(schemas.items()))

    references = {
        f"#/components/schemas/{old}": f"#/components/schemas/{new}"
        for old, (new, _) in renames.items()
    }

    def rewrite(node: Any) -> None:
        if isinstance(node, dict):
            reference = node.get("$ref")
            if isinstance(reference, str) and reference in references:
                node["$ref"] = references[reference]
            for value in node.values():
                rewrite(value)
        elif isinstance(node, list):
            for value in node:
                rewrite(value)

    rewrite(document)


def _restore_examples(app: FastAPI, document: dict[str, Any]) -> None:
    """Put back the examples FastAPI emptied: each request body's, and every schema's.

    FastAPI drops every null while it serializes the document, examples included, so an example
    whose point is to clear a value with an explicit null would be published as one that does
    nothing at all, and a sample response would lack keys the API always sends. Pydantic's own
    schemas of the same models still carry the nulls, under the same component names.
    """
    models: set[type[BaseModel]] = set()
    for route in iter_routes(app.routes):
        body = getattr(route, "body_field", None)
        for model in (getattr(route, "response_model", None), getattr(body, "type_", None)):
            if isinstance(model, type) and issubclass(model, BaseModel):
                models.add(model)

        examples = getattr(getattr(body, "field_info", None), "openapi_examples", None)
        if not examples or route.path_format is None:
            continue
        for method in route.methods or ():
            operation = document["paths"][route.path_format][method.lower()]
            content = operation["requestBody"]["content"]["application/json"]
            content["examples"] = copy.deepcopy(examples)

    _, generated = models_json_schema(
        [(model, mode) for model in models for mode in ("validation", "serialization")],
        ref_template="#/components/schemas/{model}",
    )
    schemas = document["components"]["schemas"]
    for name, schema in generated.get("$defs", {}).items():
        if name in schemas:
            _copy_examples(schema, schemas[name])


def _copy_examples(source: Any, target: Any) -> None:
    """Copy every `examples` in `source` to the same place in `target`, which has the same shape."""
    if not isinstance(source, dict) or not isinstance(target, dict):
        return
    if "examples" in source:
        target["examples"] = copy.deepcopy(source["examples"])
    for key in ("properties", "$defs"):
        for name, child in source.get(key, {}).items():
            _copy_examples(child, target.get(key, {}).get(name))
    for key in ("anyOf", "oneOf", "allOf"):
        for child, other in zip(source.get(key, []), target.get(key, []), strict=False):
            _copy_examples(child, other)
    for key in ("items", "additionalProperties"):
        _copy_examples(source.get(key), target.get(key))


def _hoist_descriptions(node: Any) -> None:
    """Describe a nullable property on the property itself rather than inside its non-null branch.

    Pydantic places the description of a nullable field declared through an annotated alias --
    `title: Title | None` -- inside the `anyOf` branch the alias produced, where a viewer showing
    the property does not look for it.
    """
    if isinstance(node, dict):
        branches = node.get("anyOf")
        if isinstance(branches, list) and "description" not in node:
            described = [b for b in branches if isinstance(b, dict) and "description" in b]
            if len(described) == 1:
                node["description"] = described[0].pop("description")
                if "examples" in described[0] and "examples" not in node:
                    node["examples"] = described[0].pop("examples")
        for value in node.values():
            _hoist_descriptions(value)
    elif isinstance(node, list):
        for value in node:
            _hoist_descriptions(value)


def _correct(app: FastAPI, document: dict[str, Any]) -> None:
    scopes = _scopes_by_operation(app)
    schemas = document.setdefault("components", {}).setdefault("schemas", {})
    for name, schema in _error_schemas().items():
        schemas.setdefault(name, schema)

    for path, operations in document.get("paths", {}).items():
        for method, operation in operations.items():
            responses = operation.setdefault("responses", {})
            if responses.pop("422", None) is not None:
                responses.setdefault("400", _BAD_REQUEST)

            scope = scopes.get((path, method))
            if scope is not None:
                _document_scope(operation, scope)
                responses.setdefault("400", _BAD_REQUEST)
                responses.setdefault("401", _UNAUTHORIZED)
                # A read-scoped operation can never answer 403: every valid key grants `read`.
                if scope is not Scope.READ:
                    responses.setdefault("403", _FORBIDDEN)

    _drop_unreferenced_validation_schemas(document)
    # Before the envelopes are renamed, while the components still have pydantic's names.
    _restore_examples(app, document)
    _rename_envelopes(document)
    _hoist_descriptions(document["components"]["schemas"])


def refine_document(app: FastAPI) -> None:
    """Make `app.openapi()` produce I8's document rather than FastAPI's."""
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

"""The API documentation routes (I8): the OpenAPI document and the viewer over it."""

from __future__ import annotations

import re
from collections.abc import Callable, Iterator
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from lnt_v5 import examples
from lnt_v5.auth import iter_routes, required_scope
from lnt_v5.errors import ErrorCode
from lnt_v5.openapi import OVERVIEW, TAGS, _rename_components
from lnt_v5.querying import DEFAULT_LIMIT, MAX_LIMIT
from lnt_v5.routes.commits import COMMITS_PATH
from lnt_v5.routes.machines import MACHINES_PATH
from lnt_v5.routes.profiles import PROFILES_PATH, RUN_PROFILES_PATH
from lnt_v5.routes.regressions import (
    INDICATOR_LOOKUP_PATH,
    INDICATORS_PATH,
    REGRESSIONS_PATH,
)
from lnt_v5.routes.runs import RUNS_PATH
from lnt_v5.routes.samples import SAMPLES_PATH
from lnt_v5.routes.suites import SUITES_PATH
from lnt_v5.routes.tests import TESTS_PATH
from lnt_v5.routes.timeseries import DEFAULT_LAST_N, QUERY_PATH, TRENDS_PATH
from lnt_v5.scopes import Scope
from lnt_v5.suites.schema import RESERVED_TEST_ENTRY_KEYS, CommitField, MachineField, Metric


class TestOpenApiDocument:
    def test_is_served_under_api(self, client: TestClient) -> None:
        response = client.get("/api/openapi.json")

        assert response.status_code == 200
        assert response.headers["content-type"].startswith("application/json")
        assert response.json()["openapi"].startswith("3.")

    def test_identifies_the_api_rather_than_the_build(self, client: TestClient) -> None:
        # I8 fixes info.version at the API's major version.
        info = client.get("/api/openapi.json").json()["info"]

        assert info["title"] == "LNT v5"
        assert info["version"] == "5"

    def test_opens_with_the_overview(self, client: TestClient) -> None:
        info = client.get("/api/openapi.json").json()["info"]

        assert info["description"] == OVERVIEW
        # Linked as I8 asks of the API's documentation, and written for people rather than tools.
        assert "/llms.txt" in OVERVIEW
        assert "## Authentication" in OVERVIEW

    def test_describes_only_permitted_statuses(self, client: TestClient) -> None:
        # I8: the document must not advertise a response the API cannot produce. FastAPI adds a
        # 422 to every operation taking a body or parameters, which I4 does not permit and which
        # the error handlers turn into a 400. I4 also permits 405, but I8 lists it on no operation:
        # it answers a method for which no operation exists.
        i4_statuses = {"200", "201", "204", "400", "401", "403", "404", "409", "500"}

        for path, operations in client.get("/api/openapi.json").json()["paths"].items():
            for method, operation in operations.items():
                extra = set(operation.get("responses", {})) - i4_statuses
                assert not extra, f"{method.upper()} {path} documents {sorted(extra)}"

    def test_every_409_names_the_codes_it_carries(self, client: TestClient) -> None:
        """Each operation's 409 names, in backticks, exactly the I4 codes endpoints.md gives it.

        OpenAPI keys responses by status alone, so an operation's 409 cases share one description,
        and the code is the only thing a client can branch on. Every suite-scoped operation can
        answer `retry` (D2); the writes listed here add cases of their own.
        """
        beyond_retry = {
            ("/api/suites", "post"): {"duplicate", "conflict"},
            ("/api/suites/{name}/schema", "patch"): {"duplicate"},
            (MACHINES_PATH, "post"): {"duplicate"},
            (f"{MACHINES_PATH}/{{machine_name}}", "patch"): {"duplicate"},
            (COMMITS_PATH, "post"): {"duplicate", "conflict"},
            (f"{COMMITS_PATH}/{{value}}", "patch"): {"conflict"},
            (RUNS_PATH, "post"): {"duplicate", "conflict"},
            (REGRESSIONS_PATH, "post"): {"duplicate"},
        }

        for path, operations in client.get("/api/openapi.json").json()["paths"].items():
            for method, operation in operations.items():
                response = operation["responses"].get("409")
                if response is None:
                    continue
                named = set(re.findall(r"`([a-z_]+)`", response["description"]))
                expected = {"retry"} | beyond_retry.get((path, method), set())
                assert named == expected, f"{method.upper()} {path}"

    @pytest.mark.parametrize("path", ["/healthz", "/llms.txt"])
    def test_excludes_the_routes_outside_the_rest_api(self, client: TestClient, path: str) -> None:
        # I5 places both of these outside the REST API surface, so neither is part of what I8
        # describes. The other two exempt routes are the document and its viewer.
        assert path not in client.get("/api/openapi.json").json()["paths"]

    def test_documents_no_validation_failure_the_api_cannot_produce(
        self, client: TestClient
    ) -> None:
        """FastAPI's native 422 is corrected to the 400 the error handlers actually answer.

        Stated separately from the status-set check above because this is the specific regression:
        a 422 reappears by default on every new operation that takes a body or a parameter, and
        the schemas behind it linger in `components` describing a body nothing returns.
        """
        document = client.get("/api/openapi.json").json()

        assert "HTTPValidationError" not in document["components"]["schemas"]
        assert "ValidationError" not in document["components"]["schemas"]

    def test_no_patch_body_publishes_a_default(self, client: TestClient) -> None:
        """On `PATCH`, an omitted key leaves the stored value unchanged.

        A published default says otherwise -- that omitting the key sends the default -- and a
        generated client may act on it. That holds for the `update` entries of a schema change
        too, but not for its `add` entries: an added entry's omitted keys do take their defaults
        (D4), so those are left out here.
        """
        document = client.get("/api/openapi.json").json()
        schemas = document["components"]["schemas"]

        def component(reference: dict[str, str]) -> str:
            return reference["$ref"].removeprefix("#/components/schemas/")

        bodies = [
            component(operations["patch"]["requestBody"]["content"]["application/json"]["schema"])
            for operations in document["paths"].values()
            if "patch" in operations
        ]
        bodies += [
            component(schemas[component(changes)]["properties"]["update"]["items"])
            for changes in schemas["SchemaPatch"]["properties"].values()
        ]

        assert len(bodies) == 7
        for name in bodies:
            for key, property in schemas[name]["properties"].items():
                assert "default" not in property, f"{name}.{key} publishes a default"

    def test_a_response_always_has_every_key_it_documents(self, client: TestClient) -> None:
        # I4: every key an endpoint documents is always present in its responses. So no property
        # of a schema a response can reach may be optional, or generated clients would have to
        # handle a missing key that never is. Request schemas are unaffected: a key with a default
        # stays optional there, which is why a model may be described twice.
        document = client.get("/api/openapi.json").json()
        schemas = document["components"]["schemas"]
        reachable: set[str] = set()

        def visit(node: Any) -> None:
            if isinstance(node, dict):
                reference = node.get("$ref")
                if isinstance(reference, str):
                    name = reference.rsplit("/", 1)[-1]
                    if name not in reachable:
                        reachable.add(name)
                        visit(schemas[name])
                for value in node.values():
                    visit(value)
            elif isinstance(node, list):
                for value in node:
                    visit(value)

        for _, schema in _responses(document):
            visit(schema)

        assert reachable, "no response references a component"
        for name in sorted(reachable):
            optional = set(schemas[name].get("properties", {})) - set(
                schemas[name].get("required", [])
            )
            assert not optional, f"{name} leaves {sorted(optional)} optional"

    def test_every_component_has_a_plain_name(self, client: TestClient) -> None:
        # Not one of pydantic's: `CursorPage_Run_`, or `Metric-Input` for a model described twice.
        schemas = client.get("/api/openapi.json").json()["components"]["schemas"]

        assert [name for name in schemas if not re.fullmatch(r"[A-Za-z0-9]+", name)] == []

    def test_describes_the_error_envelope(self, client: TestClient) -> None:
        document = client.get("/api/openapi.json").json()

        envelope = document["components"]["schemas"]["ErrorEnvelope"]
        assert set(document["components"]["schemas"]["ErrorBody"]["properties"]) == {
            "code",
            "message",
        }
        assert "error" in envelope["properties"]


class TestComponentRenaming:
    """How pydantic's component names are replaced, including for models the API has none of yet."""

    @staticmethod
    def renamed(*names: str) -> dict[str, Any]:
        """`names` as `_rename_components` renames them, each referenced by a response."""
        document: dict[str, Any] = {
            "paths": {
                f"/{i}": {"get": {"responses": {"200": {"$ref": f"#/components/schemas/{name}"}}}}
                for i, name in enumerate(names)
            },
            "components": {"schemas": {name: {"type": "object"} for name in names}},
        }
        _rename_components(document)
        return document

    def test_names_both_forms_of_a_model_described_twice(self) -> None:
        document = self.renamed("Metric-Input", "Metric-Output")

        assert set(document["components"]["schemas"]) == {"Metric", "MetricInput"}

    def test_names_both_forms_of_an_envelope_described_twice(self) -> None:
        document = self.renamed("CursorPage_Run_-Input", "CursorPage_Run_-Output")
        schemas = document["components"]["schemas"]

        assert set(schemas) == {"RunCursorPage", "RunCursorPageInput"}
        assert schemas["RunCursorPage"]["title"] == "RunCursorPage"
        assert schemas["RunCursorPage"]["description"].startswith("One page of results.")
        references = [
            path["get"]["responses"]["200"]["$ref"] for path in document["paths"].values()
        ]
        assert references == [
            "#/components/schemas/RunCursorPageInput",
            "#/components/schemas/RunCursorPage",
        ]

    @pytest.mark.parametrize(
        "name",
        ["Page_Run_", "Page_Run_-Output", "Items_dict_str__Run__", "Items_dict_str__Run__-Input"],
    )
    def test_refuses_a_name_it_cannot_make_plain(self, name: str) -> None:
        with pytest.raises(RuntimeError, match="No plain name"):
            self.renamed(name)

    def test_refuses_two_components_of_the_same_name(self) -> None:
        with pytest.raises(RuntimeError, match="RunList"):
            self.renamed("Items_Run_", "Items_Run_-Output")


class TestDocumentedAuthentication:
    """I5's failures, as I8's document reports them.

    They are derived from each route's declared scope rather than restated per endpoint, so what
    matters is that the derivation lands on the right operations.
    """

    def test_declares_the_bearer_scheme(self, client: TestClient) -> None:
        schemes = client.get("/api/openapi.json").json()["components"]["securitySchemes"]

        assert schemes["ApiKey"]["type"] == "http"
        assert schemes["ApiKey"]["scheme"] == "bearer"

    def test_every_operation_requires_its_scope_through_that_scheme(self, app: FastAPI) -> None:
        """Each operation names its scope as the role its requirement on the scheme needs.

        A `read` one also allows the empty requirement, which is how OpenAPI says a caller may send
        no credentials at all -- I5's anonymous read access. Checked against the scope each route
        actually enforces, so the document cannot drift from it.
        """
        enforced = {
            (route.path_format, method.lower()): required_scope(route)
            for route in iter_routes(app.routes)
            for method in route.methods or ()
        }

        for path, operations in app.openapi()["paths"].items():
            for method, operation in operations.items():
                scope = enforced[(path, method)]
                assert scope is not None, f"{method.upper()} {path}"
                requirement = {"ApiKey": [scope.value]}
                expected = [{}, requirement] if scope is Scope.READ else [requirement]
                assert operation["security"] == expected, f"{method.upper()} {path}"

    def test_every_operation_states_its_scope_in_words(self, client: TestClient) -> None:
        for path, operations in client.get("/api/openapi.json").json()["paths"].items():
            for method, operation in operations.items():
                roles = operation["security"][-1]["ApiKey"]
                sentence = (
                    "**Authorization:** no API key needed."
                    if roles == ["read"]
                    else f"**Authorization:** requires an API key with the `{roles[0]}` scope."
                )
                assert operation["description"].endswith(sentence), f"{method.upper()} {path}"

    def test_a_read_operation_can_be_refused_but_never_forbidden(self, client: TestClient) -> None:
        # Every valid key grants `read`, so a read-scoped operation has no way to answer 403.
        index = client.get("/api/openapi.json").json()["paths"]["/api"]["get"]

        assert "401" in index["responses"]
        assert "403" not in index["responses"]

    def test_an_operation_above_read_can_be_forbidden(self, client: TestClient) -> None:
        keys = client.get("/api/openapi.json").json()["paths"]["/api/admin/api-keys"]

        assert {"401", "403"} <= set(keys["get"]["responses"])

    def test_every_operation_can_answer_400(self, client: TestClient) -> None:
        # I3: any of them refuses a query parameter it does not take, so even one with nothing
        # else to validate -- such as the index -- can answer 400.
        for path, operations in client.get("/api/openapi.json").json()["paths"].items():
            for method, operation in operations.items():
                assert "400" in operation["responses"], f"{method.upper()} {path}"


class TestSuiteOperations:
    """I8: the document describes what the API can actually do, including these five."""

    @pytest.mark.parametrize(
        ("path", "method"),
        [
            ("/api/suites", "get"),
            ("/api/suites", "post"),
            ("/api/suites/{name}", "get"),
            ("/api/suites/{name}/schema", "patch"),
            ("/api/suites/{name}", "delete"),
        ],
    )
    def test_is_documented(self, client: TestClient, path: str, method: str) -> None:
        paths = client.get("/api/openapi.json").json()["paths"]

        assert method in paths[path], f"{method.upper()} {path} is not in the document"

    @pytest.mark.parametrize(
        ("path", "method", "status"),
        [
            ("/api/suites", "post", "409"),
            ("/api/suites/{name}", "get", "404"),
            ("/api/suites/{name}", "delete", "404"),
            ("/api/suites/{name}/schema", "patch", "404"),
            ("/api/suites/{name}/schema", "patch", "409"),
        ],
    )
    def test_documents_the_failures_endpoints_md_specifies(
        self, client: TestClient, path: str, method: str, status: str
    ) -> None:
        # `openapi.py` derives only 400/401/403 from the declared scope, so everything else has
        # to be declared on the route -- and a status the spec promises but the document omits is a
        # lie to every generated client.
        operation = client.get("/api/openapi.json").json()["paths"][path][method]

        assert status in operation["responses"]

    def test_the_destructive_operations_document_their_confirmation(
        self, client: TestClient
    ) -> None:
        paths = client.get("/api/openapi.json").json()["paths"]

        for path, method in (
            ("/api/suites/{name}", "delete"),
            ("/api/suites/{name}/schema", "patch"),
        ):
            names = {p["name"] for p in paths[path][method].get("parameters", [])}
            assert "confirm" in names, f"{method.upper()} {path} does not document ?confirm="

    def test_creating_and_reading_a_suite_describe_one_document(self, client: TestClient) -> None:
        """The machine-checkable form of "postable verbatim to another instance" (E10).

        The response is described apart from the request only because it always has the keys a
        request may leave out (D4's normalization, I4). Otherwise the two must describe the same
        document, so that a generated client can feed one to the other: the same keys with the
        same values all the way down, and nothing the request requires that the response may lack.
        """
        document = client.get("/api/openapi.json").json()
        schemas = document["components"]["schemas"]
        posted = document["paths"][SUITES_PATH]["post"]["requestBody"]["content"][
            "application/json"
        ]["schema"]
        returned = document["paths"][f"{SUITES_PATH}/{{name}}"]["get"]["responses"]["200"][
            "content"
        ]["application/json"]["schema"]

        def resolve(schema: dict[str, Any]) -> dict[str, Any]:
            reference = schema.get("$ref")
            return schemas[reference.rsplit("/", 1)[-1]] if reference else schema

        def same_document(request: dict[str, Any], response: dict[str, Any]) -> None:
            request, response = resolve(request), resolve(response)
            assert set(request.get("required", [])) <= set(response.get("required", []))
            assert set(request.get("properties", {})) == set(response.get("properties", {}))
            for key, property in request.get("properties", {}).items():
                same_document(property, response["properties"][key])
            if "items" in request:
                same_document(request["items"], response["items"])
            ignored = {"properties", "items", "required", "title", "examples"}
            assert {k: v for k, v in request.items() if k not in ignored} == {
                k: v for k, v in response.items() if k not in ignored
            }

        same_document(posted, returned)

    def test_no_update_entry_accepts_a_type(self, client: TestClient) -> None:
        # D2 forbids changing a type in place, so the document must not advertise the key. Declaring
        # one only to reject it would describe an input the API refuses every time.
        schemas = client.get("/api/openapi.json").json()["components"]["schemas"]
        updates = [name for name in schemas if name.endswith("Update")]

        assert updates, "the update models are missing from the document"
        for name in updates:
            assert "type" not in schemas[name].get("properties", {}), name


MACHINES = MACHINES_PATH
MACHINE = f"{MACHINES_PATH}/{{machine_name}}"


class TestMachineOperations:
    """I8: the document describes what the API can actually do, including these five."""

    @pytest.mark.parametrize(
        ("path", "method"),
        [
            (MACHINES, "get"),
            (MACHINES, "post"),
            (MACHINE, "get"),
            (MACHINE, "patch"),
            (MACHINE, "delete"),
        ],
    )
    def test_is_documented(self, client: TestClient, path: str, method: str) -> None:
        paths = client.get("/api/openapi.json").json()["paths"]

        assert method in paths[path], f"{method.upper()} {path} is not in the document"

    @pytest.mark.parametrize(
        ("path", "method", "status"),
        [
            # An unknown suite on every one of them (I1), an unknown machine on the three that
            # address one, a duplicate name on the two that can write one, and D2's stale reader
            # everywhere the suite's own columns are queried.
            (MACHINES, "get", "404"),
            (MACHINES, "get", "409"),
            (MACHINES, "post", "404"),
            (MACHINES, "post", "409"),
            (MACHINE, "get", "404"),
            (MACHINE, "get", "409"),
            (MACHINE, "patch", "404"),
            (MACHINE, "patch", "409"),
            (MACHINE, "delete", "404"),
            (MACHINE, "delete", "409"),
        ],
    )
    def test_documents_the_failures_endpoints_md_specifies(
        self, client: TestClient, path: str, method: str, status: str
    ) -> None:
        operation = client.get("/api/openapi.json").json()["paths"][path][method]

        assert status in operation["responses"]

    @pytest.mark.parametrize("name", ["search", "tracked", "sort"])
    def test_the_list_documents_every_parameter_endpoints_md_gives_it(
        self, client: TestClient, name: str
    ) -> None:
        operation = client.get("/api/openapi.json").json()["paths"][MACHINES]["get"]

        assert name in {parameter["name"] for parameter in operation["parameters"]}

    def test_the_list_enumerates_the_sort_fields_rather_than_taking_any_string(
        self, client: TestClient
    ) -> None:
        # endpoints.md names four and no others, so a generated client should not be able to ask
        # for a fifth.
        operation = client.get("/api/openapi.json").json()["paths"][MACHINES]["get"]
        sort = next(p for p in operation["parameters"] if p["name"] == "sort")

        assert set(sort["schema"]["enum"]) == {"name", "-name", "last_run_at", "-last_run_at"}

    def test_the_list_is_not_paginated(self, client: TestClient) -> None:
        # E2: every matching machine, in I2's unpaginated envelope, with no page to ask for.
        document = client.get("/api/openapi.json").json()
        operation = document["paths"][MACHINES]["get"]
        body = operation["responses"]["200"]["content"]["application/json"]["schema"]
        envelope = document["components"]["schemas"][body["$ref"].rsplit("/", 1)[-1]]
        names = {parameter["name"] for parameter in operation["parameters"]}

        assert set(envelope["properties"]) == {"items"}
        assert not names & {"limit", "offset", "cursor"}

    def test_creating_and_reading_a_machine_share_the_entity_object(
        self, client: TestClient
    ) -> None:
        # O2: `POST` takes the same object a run submission nests, and the response is that object
        # plus the derived `last_run_at`. A generated client must be able to feed one to the other.
        schemas = client.get("/api/openapi.json").json()["components"]["schemas"]

        assert set(schemas["Machine"]["properties"]) == {
            *schemas["MachineObject"]["properties"],
            "last_run_at",
        }

    def test_the_response_promises_every_key_it_documents(self, client: TestClient) -> None:
        # I4: a key an endpoint documents is always present, and null when it has no value. The
        # response model shares the request model's properties, so it must not also inherit the
        # request model's optional-with-a-default treatment of them.
        schemas = client.get("/api/openapi.json").json()["components"]["schemas"]

        assert set(schemas["Machine"]["required"]) == set(schemas["Machine"]["properties"])

    def test_no_request_body_publishes_a_default_it_would_reject(self, client: TestClient) -> None:
        """`PATCH` distinguishes an omitted key from a null one with a sentinel default.

        That sentinel is never read, and some of them -- an empty `name` against a `minLength` of
        1 -- are values the endpoint answers 400 for. Published, the document would be telling a
        generated client to send one.
        """
        schemas = client.get("/api/openapi.json").json()["components"]["schemas"]

        for name, schema in schemas.items():
            for key, property in schema.get("properties", {}).items():
                minimum = property.get("minLength")
                default = property.get("default")
                assert not (isinstance(default, str) and minimum and len(default) < minimum), (
                    f"{name}.{key} defaults to a value its own schema rejects"
                )


COMMITS = COMMITS_PATH
COMMIT = f"{COMMITS_PATH}/{{value}}"
RESOLVE = f"{COMMITS_PATH}/resolve"


class TestCommitOperations:
    """I8: the document describes what the API can actually do, including these six."""

    @pytest.mark.parametrize(
        ("path", "method"),
        [
            (COMMITS, "get"),
            (COMMITS, "post"),
            (COMMIT, "get"),
            (COMMIT, "patch"),
            (COMMIT, "delete"),
            (RESOLVE, "post"),
        ],
    )
    def test_is_documented(self, client: TestClient, path: str, method: str) -> None:
        paths = client.get("/api/openapi.json").json()["paths"]

        assert method in paths[path], f"{method.upper()} {path} is not in the document"

    @pytest.mark.parametrize(
        ("path", "method", "status"),
        [
            # An unknown suite on every one of them (I1), an unknown commit on the three that
            # address one, and D2's stale reader everywhere the suite's own columns are queried.
            # The list's 404 covers an unknown `machine=` or range bound too (I3), and the writes'
            # 409 covers a duplicate value, a taken ordinal and a commit a regression still
            # references.
            (COMMITS, "get", "404"),
            (COMMITS, "get", "409"),
            (COMMITS, "post", "404"),
            (COMMITS, "post", "409"),
            (COMMIT, "get", "404"),
            (COMMIT, "get", "409"),
            (COMMIT, "patch", "404"),
            (COMMIT, "patch", "409"),
            (COMMIT, "delete", "404"),
            (COMMIT, "delete", "409"),
            (RESOLVE, "post", "404"),
            (RESOLVE, "post", "409"),
        ],
    )
    def test_documents_the_failures_endpoints_md_specifies(
        self, client: TestClient, path: str, method: str, status: str
    ) -> None:
        operation = client.get("/api/openapi.json").json()["paths"][path][method]

        assert status in operation["responses"]

    @pytest.mark.parametrize(
        "name",
        [
            "search",
            "machine",
            "has_profiles",
            "after_commit",
            "before_commit",
            "sort",
            "limit",
            "cursor",
        ],
    )
    def test_the_list_documents_every_parameter_endpoints_md_gives_it(
        self, client: TestClient, name: str
    ) -> None:
        operation = client.get("/api/openapi.json").json()["paths"][COMMITS]["get"]

        assert name in {parameter["name"] for parameter in operation["parameters"]}

    def test_the_list_documents_the_page_size(self, client: TestClient) -> None:
        operation = client.get("/api/openapi.json").json()["paths"][COMMITS]["get"]
        limit = next(p for p in operation["parameters"] if p["name"] == "limit")

        assert limit["schema"]["default"] == DEFAULT_LIMIT == 25
        assert limit["schema"]["maximum"] == MAX_LIMIT == 10000

    def test_the_list_enumerates_the_sort_fields_rather_than_taking_any_string(
        self, client: TestClient
    ) -> None:
        # endpoints.md names four and no others, and makes the first of them the default.
        operation = client.get("/api/openapi.json").json()["paths"][COMMITS]["get"]
        sort = next(p for p in operation["parameters"] if p["name"] == "sort")

        assert set(sort["schema"]["enum"]) == {"first_seen", "-first_seen", "ordinal", "-ordinal"}
        assert sort["schema"]["default"] == "first_seen"

    def test_the_list_returns_the_cursor_envelope(self, client: TestClient) -> None:
        document = client.get("/api/openapi.json").json()
        body = document["paths"][COMMITS]["get"]["responses"]["200"]["content"]["application/json"][
            "schema"
        ]
        envelope = document["components"]["schemas"][body["$ref"].rsplit("/", 1)[-1]]

        assert set(envelope["properties"]) == {"items", "cursor"}

    def test_the_cursor_promises_a_null_previous(self, client: TestClient) -> None:
        # I2: pagination is forward-only, so the document must not advertise a backward cursor the
        # API can never produce (I8).
        cursor = client.get("/api/openapi.json").json()["components"]["schemas"]["PageCursor"]

        assert cursor["properties"]["previous"]["type"] == "null"
        assert set(cursor["required"]) == {"next", "previous"}

    def test_creating_and_reading_a_commit_share_the_entity_object(
        self, client: TestClient
    ) -> None:
        # O2: `POST` takes the same object a run submission nests, and the response is that same
        # object, with the detail adding what only a stored commit has.
        schemas = client.get("/api/openapi.json").json()["components"]["schemas"]

        assert set(schemas["Commit"]["properties"]) == set(schemas["CommitObject"]["properties"])
        assert set(schemas["CommitDetail"]["properties"]) == {
            *schemas["Commit"]["properties"],
            "previous",
            "next",
        }

    def test_no_request_body_accepts_a_rename(self, client: TestClient) -> None:
        # endpoints.md: `value` is immutable.
        schemas = client.get("/api/openapi.json").json()["components"]["schemas"]

        assert "value" not in schemas["CommitUpdate"]["properties"]

    @pytest.mark.parametrize("model", ["Commit", "CommitDetail"])
    def test_the_response_promises_every_key_it_documents(
        self, client: TestClient, model: str
    ) -> None:
        # I4: a key an endpoint documents is always present, and null when it has no value.
        schemas = client.get("/api/openapi.json").json()["components"]["schemas"]

        assert set(schemas[model]["required"]) == set(schemas[model]["properties"])


RUNS = RUNS_PATH
RUN = f"{RUNS_PATH}/{{uuid}}"


class TestRunOperations:
    """I8: the document describes what the API can actually do, including these three."""

    @pytest.mark.parametrize(("path", "method"), [(RUNS, "post"), (RUN, "get"), (RUN, "delete")])
    def test_is_documented(self, client: TestClient, path: str, method: str) -> None:
        paths = client.get("/api/openapi.json").json()["paths"]

        assert method in paths[path], f"{method.upper()} {path} is not in the document"

    @pytest.mark.parametrize(
        ("path", "method", "status"),
        [
            # An unknown suite on every one of them (I1), an unknown run on the two that address
            # one, and D2's stale reader everywhere the suite's own tables are written or read. The
            # submission's 409 covers a repeated UUID, contradicted metadata and a taken ordinal.
            (RUNS, "post", "404"),
            (RUNS, "post", "409"),
            (RUN, "get", "404"),
            (RUN, "get", "409"),
            (RUN, "delete", "404"),
            (RUN, "delete", "409"),
        ],
    )
    def test_documents_the_failures_endpoints_md_specifies(
        self, client: TestClient, path: str, method: str, status: str
    ) -> None:
        operation = client.get("/api/openapi.json").json()["paths"][path][method]

        assert status in operation["responses"]

    def test_the_response_promises_every_key_it_documents(self, client: TestClient) -> None:
        # I4: a key an endpoint documents is always present, and null when it has no value.
        schemas = client.get("/api/openapi.json").json()["components"]["schemas"]
        run = schemas["Run"]

        assert set(run["required"]) == set(run["properties"])
        assert set(run["properties"]) == {"uuid", "machine", "commit", "submitted_at"}

    def test_only_the_detail_carries_the_unbounded_blob(self, client: TestClient) -> None:
        # endpoints.md: `run_parameters` appears in the detail response only, because no list view
        # renders it. The detail is otherwise a list item exactly.
        schemas = client.get("/api/openapi.json").json()["components"]["schemas"]
        detail = schemas["RunDetail"]

        assert set(detail["required"]) == set(detail["properties"])
        assert set(detail["properties"]) == {*schemas["Run"]["properties"], "run_parameters"}

    def test_a_run_names_the_entities_it_references_rather_than_nesting_them(
        self, client: TestClient
    ) -> None:
        # I4: a reference carries the other entity's identifier under a key named after it.
        run = client.get("/api/openapi.json").json()["components"]["schemas"]["Run"]

        assert run["properties"]["machine"]["type"] == "string"
        assert run["properties"]["commit"]["type"] == "string"

    def test_the_submission_body_is_the_specified_one(self, client: TestClient) -> None:
        schemas = client.get("/api/openapi.json").json()["components"]["schemas"]

        assert set(schemas["RunSubmission"]["properties"]) == {
            "format_version",
            "uuid",
            "machine",
            "commit",
            "run_parameters",
            "tests",
        }

    def test_the_submission_nests_the_entity_objects_the_creation_endpoints_take(
        self, client: TestClient
    ) -> None:
        # O1 and O2: one object per entity, shared with `POST /machines` and `POST /commits`, so a
        # generated client can feed one to the other.
        submission = client.get("/api/openapi.json").json()["components"]["schemas"][
            "RunSubmission"
        ]["properties"]

        assert submission["machine"]["$ref"].endswith("/MachineObject")
        assert submission["commit"]["$ref"].endswith("/CommitObject")


class TestReadOperations:
    """I8: the lists that read runs, tests and samples back."""

    @pytest.mark.parametrize("path", [RUNS, TESTS_PATH, SAMPLES_PATH])
    def test_is_documented(self, client: TestClient, path: str) -> None:
        paths = client.get("/api/openapi.json").json()["paths"]

        assert "get" in paths[path], f"GET {path} is not in the document"

    @pytest.mark.parametrize("path", [RUNS, TESTS_PATH, SAMPLES_PATH])
    @pytest.mark.parametrize("status", ["404", "409"])
    def test_documents_the_failures_endpoints_md_specifies(
        self, client: TestClient, path: str, status: str
    ) -> None:
        # An unknown suite on every one of them (I1), and an unknown entity named by the path or by
        # a filter as well. D2's stale reader accounts for the 409.
        operation = client.get("/api/openapi.json").json()["paths"][path]["get"]

        assert status in operation["responses"]

    @pytest.mark.parametrize(
        ("path", "expected"),
        [
            (RUNS, {"search", "machine", "commit", "after", "before", "has_profiles", "sort"}),
            (TESTS_PATH, {"search", "machine", "metric"}),
            (SAMPLES_PATH, {"test"}),
        ],
    )
    def test_documents_exactly_the_filters_endpoints_md_gives_it(
        self, client: TestClient, path: str, expected: set[str]
    ) -> None:
        """Exactly, not merely at least: a filter the spec does not give a list is as wrong as a
        missing one.

        E5 is explicit that `GET /tests` supports no time range, for instance, and a subset
        assertion would let one appear unnoticed. The path's own templated segments and I2's two
        paging parameters are the rest of what every one of these declares.
        """
        templated = {segment[1:-1] for segment in path.split("/") if segment.startswith("{")}
        operation = client.get("/api/openapi.json").json()["paths"][path]["get"]
        names = {parameter["name"] for parameter in operation["parameters"]}

        assert names == expected | templated | {"limit", "cursor"}

    @pytest.mark.parametrize("path", [RUNS, TESTS_PATH, SAMPLES_PATH])
    def test_pages_with_a_cursor(self, client: TestClient, path: str) -> None:
        # I2: an endpoint with unbounded results is cursor-paginated, which is what a client
        # generated from this document has to be told.
        document = client.get("/api/openapi.json").json()
        operation = document["paths"][path]["get"]
        body = operation["responses"]["200"]["content"]["application/json"]["schema"]
        envelope = document["components"]["schemas"][body["$ref"].rsplit("/", 1)[-1]]
        names = {parameter["name"] for parameter in operation["parameters"]}

        assert {"limit", "cursor"} <= names
        assert set(envelope["properties"]) == {"items", "cursor"}

    def test_the_run_list_enumerates_its_sort_fields(self, client: TestClient) -> None:
        # endpoints.md names one field and both directions, so a generated client should not be
        # able to ask for a third spelling.
        operation = client.get("/api/openapi.json").json()["paths"][RUNS]["get"]
        sort = next(p for p in operation["parameters"] if p["name"] == "sort")

        assert set(sort["schema"]["anyOf"][0]["enum"]) == {"submitted_at", "-submitted_at"}

    @pytest.mark.parametrize("path", [TESTS_PATH, SAMPLES_PATH])
    def test_the_lists_with_no_order_of_their_own_offer_no_sort(
        self, client: TestClient, path: str
    ) -> None:
        operation = client.get("/api/openapi.json").json()["paths"][path]["get"]

        assert "sort" not in {parameter["name"] for parameter in operation["parameters"]}

    def test_no_path_carries_a_test_name(self, client: TestClient) -> None:
        """I1: a test name legitimately contains `/`, so no path segment can hold one.

        The machine-checkable form of the rule. A route templated on a test name would be
        unreachable for the names the design docs use as examples, so the document must not have
        one -- every endpoint that names a test does so with a `test=` parameter.
        """
        paths = client.get("/api/openapi.json").json()["paths"]
        named_after_a_test = {
            segment
            for path in paths
            for segment in path.split("/")
            if segment.startswith("{") and "test" in segment and segment != "{testsuite}"
        }

        assert not named_after_a_test, sorted(paths)

    def test_a_sample_carries_only_the_metrics_that_have_a_value(self, client: TestClient) -> None:
        # I4's stated exception: `metrics` is not a `fields` dict, so nothing in it is ever null.
        sample = client.get("/api/openapi.json").json()["components"]["schemas"]["Sample"]
        values = sample["properties"]["metrics"]["additionalProperties"]

        assert set(sample["required"]) == set(sample["properties"]) == {"test", "metrics"}
        assert {"type": "null"} not in values["anyOf"]


RUN_PROFILES = RUN_PROFILES_PATH
PROFILE = f"{PROFILES_PATH}/{{uuid}}"
FUNCTIONS = f"{PROFILE}/functions"
DISASSEMBLY = f"{PROFILE}/disassembly"
DOCUMENT = f"{PROFILE}/document"

# The four that serve what is inside a blob, as opposed to the listing, which never opens one.
PROFILE_DATA = [PROFILE, FUNCTIONS, DISASSEMBLY, DOCUMENT]


class TestProfileOperations:
    """I8: the five reads E7 specifies."""

    @pytest.mark.parametrize("path", [RUN_PROFILES, *PROFILE_DATA])
    def test_is_documented(self, client: TestClient, path: str) -> None:
        paths = client.get("/api/openapi.json").json()["paths"]

        assert "get" in paths[path], f"GET {path} is not in the document"

    @pytest.mark.parametrize("path", [RUN_PROFILES, *PROFILE_DATA])
    @pytest.mark.parametrize("status", ["404", "409"])
    def test_documents_the_failures_endpoints_md_specifies(
        self, client: TestClient, path: str, status: str
    ) -> None:
        # An unknown suite on every one of them (I1), plus the run, the profile or the function the
        # path names. D2's stale reader accounts for the 409.
        operation = client.get("/api/openapi.json").json()["paths"][path]["get"]

        assert status in operation["responses"]

    @pytest.mark.parametrize("path", [RUN_PROFILES, FUNCTIONS])
    def test_the_lists_are_unpaginated(self, client: TestClient, path: str) -> None:
        # I2: both are bounded -- by the tests of one run, and by the functions of one binary -- so
        # they carry `items` alone, with no cursor to page by.
        document = client.get("/api/openapi.json").json()
        operation = document["paths"][path]["get"]
        body = operation["responses"]["200"]["content"]["application/json"]["schema"]
        envelope = document["components"]["schemas"][body["$ref"].rsplit("/", 1)[-1]]
        names = {parameter["name"] for parameter in operation["parameters"]}

        assert set(envelope["properties"]) == {"items"}
        assert not names & {"limit", "cursor"}

    @pytest.mark.parametrize(
        ("schema", "keys"),
        [
            ("RunProfile", {"test", "uuid"}),
            ("ProfileMetadata", {"uuid", "test", "run_uuid", "counters", "disassembly_format"}),
            ("ProfileFunction", {"name", "counters", "length"}),
            ("Instruction", {"address", "counters", "text"}),
            (
                "FunctionDisassembly",
                {"name", "counters", "disassembly_format", "instructions"},
            ),
            ("ProfileDocument", {"disassembly_format", "counters", "functions"}),
            ("DocumentFunction", {"name", "instructions"}),
        ],
    )
    def test_a_response_carries_exactly_the_keys_endpoints_md_gives_it(
        self, client: TestClient, schema: str, keys: set[str]
    ) -> None:
        # I4: a documented key is always present, so `properties` and `required` agree.
        described = client.get("/api/openapi.json").json()["components"]["schemas"][schema]

        assert set(described["properties"]) == keys
        assert set(described["required"]) == keys

    def test_a_top_level_counter_is_an_integer_and_every_other_counter_a_number(
        self, client: TestClient
    ) -> None:
        # endpoints.md draws that line: the top-level counters are integers, and the function and
        # instruction counters are floats. Both are raw values rather than percentages.
        schemas = client.get("/api/openapi.json").json()["components"]["schemas"]

        for schema in ("ProfileMetadata", "ProfileDocument"):
            counters = schemas[schema]["properties"]["counters"]
            assert counters["additionalProperties"] == {"type": "integer"}, schema
        for schema in ("ProfileFunction", "Instruction", "FunctionDisassembly"):
            counters = schemas[schema]["properties"]["counters"]
            assert counters["additionalProperties"] == {"type": "number"}, schema

    def test_the_function_is_a_required_query_parameter(self, client: TestClient) -> None:
        # I1: a function name can contain `/`, so it travels in the query string, never the path.
        operation = client.get("/api/openapi.json").json()["paths"][DISASSEMBLY]["get"]
        parameters = {parameter["name"]: parameter for parameter in operation["parameters"]}

        assert set(parameters) == {"testsuite", "uuid", "function"}
        assert parameters["function"]["in"] == "query"
        assert parameters["function"]["required"] is True

    def test_the_document_is_described_although_the_endpoint_encodes_it_itself(
        self, client: TestClient
    ) -> None:
        # The route returns its body ready-made, so the model the document describes is declared
        # beside it rather than read from the return annotation.
        operation = client.get("/api/openapi.json").json()["paths"][DOCUMENT]["get"]
        body = operation["responses"]["200"]["content"]["application/json"]["schema"]

        assert body == {"$ref": "#/components/schemas/ProfileDocument"}

    @pytest.mark.parametrize("path", [RUN_PROFILES, *PROFILE_DATA])
    def test_can_be_refused_but_never_forbidden(self, client: TestClient, path: str) -> None:
        # I5: all five are `read`-scoped, and every valid key grants `read`.
        operation = client.get("/api/openapi.json").json()["paths"][path]["get"]

        assert "403" not in operation["responses"]


REGRESSIONS = REGRESSIONS_PATH
REGRESSION = f"{REGRESSIONS_PATH}/{{uuid}}"
INDICATORS = INDICATORS_PATH
LOOKUP = INDICATOR_LOOKUP_PATH


class TestRegressionOperations:
    """I8: the document describes what the API can actually do, including these eight."""

    @pytest.mark.parametrize(
        ("path", "method"),
        [
            (REGRESSIONS, "get"),
            (REGRESSIONS, "post"),
            (REGRESSION, "get"),
            (REGRESSION, "patch"),
            (REGRESSION, "delete"),
            (INDICATORS, "post"),
            (INDICATORS, "delete"),
            (LOOKUP, "post"),
        ],
    )
    def test_is_documented(self, client: TestClient, path: str, method: str) -> None:
        paths = client.get("/api/openapi.json").json()["paths"]

        assert method in paths[path], f"{method.upper()} {path} is not in the document"

    @pytest.mark.parametrize(
        ("path", "method"),
        [
            # An unknown suite on every one of them (I1); on the list, an unknown `machine=` or
            # `test=`; on the writes, an unknown regression, commit, machine or test named by the
            # path or the body. D2's stale reader accounts for the 409 everywhere.
            (REGRESSIONS, "get"),
            (REGRESSIONS, "post"),
            (REGRESSION, "get"),
            (REGRESSION, "patch"),
            (REGRESSION, "delete"),
            (INDICATORS, "post"),
            (INDICATORS, "delete"),
            (LOOKUP, "post"),
        ],
    )
    @pytest.mark.parametrize("status", ["404", "409"])
    def test_documents_the_failures_endpoints_md_specifies(
        self, client: TestClient, path: str, method: str, status: str
    ) -> None:
        operation = client.get("/api/openapi.json").json()["paths"][path][method]

        assert status in operation["responses"]

    def test_the_list_documents_exactly_the_filters_endpoints_md_gives_it(
        self, client: TestClient
    ) -> None:
        # Exactly, not merely at least: E8 gives this list no time range, and a subset assertion
        # would let one appear unnoticed.
        operation = client.get("/api/openapi.json").json()["paths"][REGRESSIONS]["get"]
        names = {parameter["name"] for parameter in operation["parameters"]}

        assert names == {
            "testsuite",
            "search",
            "state",
            "machine",
            "test",
            "metric",
            "commit",
            "has_commit",
            "sort",
            "limit",
            "cursor",
        }

    def test_the_list_enumerates_its_sort_fields(self, client: TestClient) -> None:
        # E8 names one field and both directions, so a generated client should not be able to ask
        # for a third spelling.
        operation = client.get("/api/openapi.json").json()["paths"][REGRESSIONS]["get"]
        sort = next(p for p in operation["parameters"] if p["name"] == "sort")

        assert set(sort["schema"]["anyOf"][0]["enum"]) == {"created_at", "-created_at"}

    def test_the_list_pages_with_a_cursor(self, client: TestClient) -> None:
        document = client.get("/api/openapi.json").json()
        body = document["paths"][REGRESSIONS]["get"]["responses"]["200"]["content"][
            "application/json"
        ]["schema"]
        envelope = document["components"]["schemas"][body["$ref"].rsplit("/", 1)[-1]]

        assert set(envelope["properties"]) == {"items", "cursor"}

    def test_the_two_bodies_carry_exactly_what_endpoints_md_gives_each(
        self, client: TestClient
    ) -> None:
        """The list item and the detail are not one plus a key, unlike a run's two bodies.

        The list has the counts and no `notes`; the detail has `notes` and the indicators and no
        counts. Asserted exactly, because a `notes` leaking into a page of twenty-five is the
        specific thing the split exists to prevent.
        """
        schemas = client.get("/api/openapi.json").json()["components"]["schemas"]

        assert set(schemas["Regression"]["properties"]) == {
            "uuid",
            "title",
            "bug",
            "state",
            "commit",
            "created_at",
            "machine_count",
            "test_count",
        }
        assert set(schemas["RegressionDetail"]["properties"]) == {
            "uuid",
            "title",
            "bug",
            "notes",
            "state",
            "commit",
            "created_at",
            "indicators",
        }

    @pytest.mark.parametrize(
        "model", ["Regression", "RegressionDetail", "Indicator", "RegressionIndicator"]
    )
    def test_the_response_promises_every_key_it_documents(
        self, client: TestClient, model: str
    ) -> None:
        # I4: a key an endpoint documents is always present, and null when it has no value.
        schemas = client.get("/api/openapi.json").json()["components"]["schemas"]

        assert set(schemas[model]["required"]) == set(schemas[model]["properties"])

    def test_a_state_is_one_named_enum_of_five_strings(self, client: TestClient) -> None:
        # D5 stores an integer; endpoints.md makes the API surface the five strings. One component
        # rather than an inline enum per body, so a generated client has one type for all of them.
        schemas = client.get("/api/openapi.json").json()["components"]["schemas"]

        assert set(schemas["RegressionStateName"]["enum"]) == {
            "detected",
            "active",
            "not_to_be_fixed",
            "fixed",
            "false_positive",
        }
        for model in ("Regression", "RegressionDetail", "RegressionCreate", "RegressionUpdate"):
            state = schemas[model]["properties"]["state"]
            assert state.get("$ref", "").endswith("/RegressionStateName"), model

    def test_the_list_takes_several_states_as_a_repeated_parameter(
        self, client: TestClient
    ) -> None:
        # I3: several values are given by repeating the parameter, which the document says by
        # making it an array -- of the same component the bodies use.
        operation = client.get("/api/openapi.json").json()["paths"][REGRESSIONS]["get"]
        state = next(p for p in operation["parameters"] if p["name"] == "state")["schema"]
        array = next(option for option in state["anyOf"] if option.get("type") == "array")

        assert array["items"]["$ref"].endswith("/RegressionStateName")

    def test_no_update_body_accepts_indicators(self, client: TestClient) -> None:
        # endpoints.md: `PATCH` does not touch them, so the document must not advertise a key the
        # endpoint refuses every time.
        schemas = client.get("/api/openapi.json").json()["components"]["schemas"]

        assert "indicators" in schemas["RegressionCreate"]["properties"]
        assert "indicators" not in schemas["RegressionUpdate"]["properties"]

    def test_an_indicator_names_the_entities_it_references_rather_than_nesting_them(
        self, client: TestClient
    ) -> None:
        # I4: a reference carries the other entity's identifier under a key named after it.
        indicator = client.get("/api/openapi.json").json()["components"]["schemas"]["Indicator"]

        for key in ("machine", "test", "metric"):
            assert indicator["properties"][key]["type"] == "string"

    def test_the_lookup_takes_its_filters_in_the_body_rather_than_the_query_string(
        self, client: TestClient
    ) -> None:
        # The reason it is a POST, as for `POST /query`: a list of test names does not fit a query
        # string. The suite is the only thing left in the path.
        operation = client.get("/api/openapi.json").json()["paths"][LOOKUP]["post"]

        assert "requestBody" in operation
        assert {p["name"] for p in operation.get("parameters", [])} == {"testsuite"}

    def test_the_lookup_body_carries_exactly_the_keys_endpoints_md_gives_it(
        self, client: TestClient
    ) -> None:
        # Exactly, not merely at least, and none of them required: every filter is optional.
        schemas = client.get("/api/openapi.json").json()["components"]["schemas"]

        assert set(schemas["IndicatorQuery"]["properties"]) == {
            "machine",
            "test",
            "metric",
            "state",
            "commit",
            "limit",
            "cursor",
        }
        assert "required" not in schemas["IndicatorQuery"]

    def test_the_lookup_pages_with_a_cursor_over_indicators_naming_their_regression(
        self, client: TestClient
    ) -> None:
        # E8: the indicator plus its regression's UUID, and no other regression field -- a client
        # reads those from the regression list.
        document = client.get("/api/openapi.json").json()
        body = document["paths"][LOOKUP]["post"]["responses"]["200"]["content"]["application/json"][
            "schema"
        ]
        schemas = document["components"]["schemas"]
        envelope = schemas[body["$ref"].rsplit("/", 1)[-1]]

        assert set(envelope["properties"]) == {"items", "cursor"}
        assert envelope["properties"]["items"]["items"]["$ref"].endswith("/RegressionIndicator")
        assert set(schemas["RegressionIndicator"]["properties"]) == {
            "uuid",
            "regression_uuid",
            "machine",
            "test",
            "metric",
        }

    def test_the_lookup_takes_states_from_the_same_enum_as_the_bodies(
        self, client: TestClient
    ) -> None:
        state = client.get("/api/openapi.json").json()["components"]["schemas"]["IndicatorQuery"][
            "properties"
        ]["state"]
        array = next(option for option in state["anyOf"] if option.get("type") == "array")

        assert array["items"]["$ref"].endswith("/RegressionStateName")

    @pytest.mark.parametrize(
        ("method", "model", "count"),
        [("post", "IndicatorsAdded", "added"), ("delete", "IndicatorsRemoved", "removed")],
    )
    def test_the_indicator_routes_answer_200_with_a_count_and_the_whole_list(
        self, client: TestClient, method: str, model: str, count: str
    ) -> None:
        # Neither is 201 or 204: a batch that changes nothing is a success, and the answer is the
        # regression's whole indicator list rather than the part this request touched.
        document = client.get("/api/openapi.json").json()
        responses = document["paths"][INDICATORS][method]["responses"]
        body = responses["200"]["content"]["application/json"]["schema"]

        assert "201" not in responses and "204" not in responses
        assert body["$ref"].endswith(f"/{model}")
        assert set(document["components"]["schemas"][model]["properties"]) == {
            count,
            "indicators",
        }


class TestTimeSeriesOperations:
    """I8: the two operations E9 specifies."""

    @pytest.mark.parametrize(("path", "method"), [(QUERY_PATH, "post"), (TRENDS_PATH, "get")])
    def test_is_documented(self, client: TestClient, path: str, method: str) -> None:
        paths = client.get("/api/openapi.json").json()["paths"]

        assert set(paths[path]) == {method}

    @pytest.mark.parametrize(("path", "method"), [(QUERY_PATH, "post"), (TRENDS_PATH, "get")])
    @pytest.mark.parametrize("status", ["404", "409"])
    def test_documents_the_failures_endpoints_md_specifies(
        self, client: TestClient, path: str, method: str, status: str
    ) -> None:
        # An unknown suite on both (I1), plus an unknown machine, test or bounding commit the
        # request names; D2's stale reader accounts for the 409.
        operation = client.get("/api/openapi.json").json()["paths"][path][method]

        assert status in operation["responses"]

    def test_the_query_takes_its_filters_in_the_body_rather_than_the_query_string(
        self, client: TestClient
    ) -> None:
        # The whole reason it is a POST: a list of test names and four bounds do not fit a query
        # string. The suite is the only thing left in the path.
        operation = client.get("/api/openapi.json").json()["paths"][QUERY_PATH]["post"]

        assert "requestBody" in operation
        assert {p["name"] for p in operation.get("parameters", [])} == {"testsuite"}

    def test_the_query_body_carries_exactly_the_keys_endpoints_md_gives_it(
        self, client: TestClient
    ) -> None:
        # Exactly, not merely at least: I2's `limit` and `cursor` are keys here rather than query
        # parameters, and a filter the spec does not give this endpoint is as wrong as a missing
        # one.
        schemas = client.get("/api/openapi.json").json()["components"]["schemas"]

        assert set(schemas["QueryRequest"]["properties"]) == {
            "metric",
            "machine",
            "test",
            "commit",
            "after_commit",
            "before_commit",
            "after_time",
            "before_time",
            "sort",
            "limit",
            "cursor",
        }
        assert schemas["QueryRequest"]["required"] == ["metric"]

    def test_the_query_body_documents_the_page_size(self, client: TestClient) -> None:
        limit = client.get("/api/openapi.json").json()["components"]["schemas"]["QueryRequest"][
            "properties"
        ]["limit"]

        assert limit["default"] == DEFAULT_LIMIT == 25
        assert limit["maximum"] == MAX_LIMIT == 10000

    def test_the_query_enumerates_its_sort_fields_rather_than_taking_any_string(
        self, client: TestClient
    ) -> None:
        # endpoints.md names three fields, and I3's `-` prefix spells each of them backwards; a
        # generated client should not be able to ask for a fourth.
        sort = client.get("/api/openapi.json").json()["components"]["schemas"]["QueryRequest"][
            "properties"
        ]["sort"]
        allowed = [option for option in sort["anyOf"] if "enum" in option]

        assert [set(option["enum"]) for option in allowed] == [
            {"test", "-test", "commit", "-commit", "submitted_at", "-submitted_at"}
        ]

    def trends_parameters(self, client: TestClient) -> dict[str, Any]:
        operation = client.get("/api/openapi.json").json()["paths"][TRENDS_PATH]["get"]
        return {p["name"]: p for p in operation["parameters"] if p["in"] == "query"}

    def test_trends_takes_exactly_the_four_query_parameters_endpoints_md_gives_it(
        self, client: TestClient
    ) -> None:
        parameters = self.trends_parameters(client)

        assert set(parameters) == {"metric", "machine", "sample_agg", "last_n"}
        assert {name for name, p in parameters.items() if p["required"]} == {"metric", "machine"}

    def test_the_trends_window_defaults_to_a_bounded_one(self, client: TestClient) -> None:
        # endpoints.md: this response is unpaginated and `read`-scoped, so an omitted `last_n` must
        # not mean "aggregate the whole suite". The default is part of the wire contract.
        last_n = self.trends_parameters(client)["last_n"]["schema"]

        assert last_n["default"] == DEFAULT_LAST_N == 500
        assert (last_n["minimum"], last_n["maximum"]) == (1, MAX_LIMIT)

    def test_the_trends_sample_aggregation_enumerates_every_aggregation_and_defaults_to_the_median(
        self, client: TestClient
    ) -> None:
        document = client.get("/api/openapi.json").json()
        schema = self.trends_parameters(client)["sample_agg"]["schema"]
        enum = document["components"]["schemas"][schema["$ref"].rsplit("/", 1)[-1]]["enum"]

        assert enum == ["median", "mean", "min", "max"]
        assert schema["default"] == "median"

    def test_the_trends_machine_is_a_list_where_the_querys_is_one_name(
        self, client: TestClient
    ) -> None:
        # endpoints.md draws the difference deliberately: the Dashboard needs several machines in
        # one call, and the Graph page plots one at a time.
        schemas = client.get("/api/openapi.json").json()["components"]["schemas"]
        query = schemas["QueryRequest"]["properties"]["machine"]["anyOf"]
        trends = self.trends_parameters(client)["machine"]["schema"]

        assert {"type": "string"} in query
        assert trends["type"] == "array"

    def test_the_query_pages_with_a_cursor_and_trends_does_not_page_at_all(
        self, client: TestClient
    ) -> None:
        # I2: one is unbounded and carries a cursor, the other is bounded by (machines x last_n)
        # and carries `items` alone.
        document = client.get("/api/openapi.json").json()
        envelopes = {
            path: document["components"]["schemas"][
                document["paths"][path][method]["responses"]["200"]["content"]["application/json"][
                    "schema"
                ]["$ref"].rsplit("/", 1)[-1]
            ]
            for path, method in ((QUERY_PATH, "post"), (TRENDS_PATH, "get"))
        }

        assert set(envelopes[QUERY_PATH]["properties"]) == {"items", "cursor"}
        assert set(envelopes[TRENDS_PATH]["properties"]) == {"items"}

    def test_a_data_point_carries_exactly_what_endpoints_md_gives_it(
        self, client: TestClient
    ) -> None:
        # I4: a documented key is always present, and null when it has no value.
        point = client.get("/api/openapi.json").json()["components"]["schemas"]["DataPoint"]

        assert set(point["properties"]) == {
            "test",
            "machine",
            "metric",
            "value",
            "commit",
            "ordinal",
            "run_uuid",
            "submitted_at",
            "tag",
        }
        assert set(point["required"]) == set(point["properties"])

    def test_a_trend_item_carries_exactly_what_endpoints_md_gives_it(
        self, client: TestClient
    ) -> None:
        # No `metric`, unlike a data point: endpoints.md states that difference explicitly.
        item = client.get("/api/openapi.json").json()["components"]["schemas"]["TrendPoint"]

        assert set(item["properties"]) == {
            "machine",
            "commit",
            "ordinal",
            "submitted_at",
            "tag",
            "value",
        }
        assert set(item["required"]) == set(item["properties"])
        assert item["properties"]["ordinal"]["type"] == "integer"
        assert item["properties"]["value"]["type"] == "number"


class TestDocumentationViewer:
    def test_is_served_under_api(self, client: TestClient) -> None:
        response = client.get("/api/docs")

        assert response.status_code == 200
        assert response.headers["content-type"].startswith("text/html")

    def test_renders_this_instances_document(self, client: TestClient) -> None:
        # The viewer is only useful if it points at our spec rather than at FastAPI's default URL.
        assert "/api/openapi.json" in client.get("/api/docs").text

    def test_is_not_shadowed_by_the_spa_catch_all(self, client: TestClient) -> None:
        # The mount at "/" matches everything, so both routes have to be registered before it.
        # Falling through would serve the client shell under an /api path instead.
        assert "<title>LNT</title>" not in client.get("/api/docs").text

    def test_keeps_the_token_across_reloads(self, client: TestClient) -> None:
        # So that trying out a sequence of authenticated operations does not mean pasting the token
        # again after every reload.
        assert '"persistAuthorization": true' in client.get("/api/docs").text


def _prose(document: dict[str, Any]) -> Iterator[tuple[str, str]]:
    """Every piece of prose the document publishes, with where it sits."""

    def walk(node: Any, where: str) -> Iterator[tuple[str, str]]:
        if isinstance(node, dict):
            for key, value in node.items():
                if key in ("description", "summary") and isinstance(value, str):
                    yield f"{where}/{key}", value
                else:
                    yield from walk(value, f"{where}/{key}")
        elif isinstance(node, list):
            for index, value in enumerate(node):
                yield from walk(value, f"{where}/{index}")

    return walk(document, "")


class TestWrittenForUsers:
    """I8: the document is written for the API's users, not for the maintainers of its server."""

    # A section of the design documentation (`D5`, `O7`, `I2`, `E10`, `AR4`, `GR14`), one of its
    # files or a source file, or a suite's table as the database spells it (`{suite}.run`). None of
    # them means anything to a user, and each is a sign of maintainer documentation published by
    # mistake -- most often a docstring that FastAPI or pydantic turned into a description.
    INTERNAL = re.compile(
        r"\b(?:[DOIE]|AR|DA|TS|DT|GR|CP|PF|AD)[0-9]+\b|\b[\w-]+\.(?:md|py)\b|\{suite\}\."
    )

    def test_refers_to_nothing_internal(self, client: TestClient) -> None:
        document = client.get("/api/openapi.json").json()

        leaks = [
            f"{where}: {match.group()}"
            for where, text in _prose(document)
            for match in self.INTERNAL.finditer(text)
        ]
        assert not leaks

    def test_describes_every_operation_and_schema(self, client: TestClient) -> None:
        # Beyond the sentence stating the scope, which every operation gets regardless.
        document = client.get("/api/openapi.json").json()

        for path, operations in document["paths"].items():
            for method, operation in operations.items():
                description = operation["description"].rsplit("**Authorization:**", 1)[0]
                assert description.strip(), f"{method.upper()} {path}"
        for name, schema in document["components"]["schemas"].items():
            assert schema.get("description"), name

    def test_describes_nullable_properties_on_the_property(self, client: TestClient) -> None:
        # Pydantic puts the description of `title: Title | None` inside the non-null branch, where
        # a viewer showing the property does not look for it.
        for name, schema in client.get("/api/openapi.json").json()["components"]["schemas"].items():
            for key, property in schema.get("properties", {}).items():
                for branch in property.get("anyOf", []):
                    assert "description" not in branch, f"{name}.{key}"

    def test_describes_every_parameter(self, client: TestClient) -> None:
        for path, operations in client.get("/api/openapi.json").json()["paths"].items():
            for method, operation in operations.items():
                for parameter in operation.get("parameters", []):
                    where = f"{method.upper()} {path}: {parameter['name']}"
                    assert parameter.get("description"), where

    def test_names_every_operation_after_its_endpoint(self, app: FastAPI) -> None:
        # Rather than after its endpoint, path and method, which is FastAPI's default and what a
        # generated client would otherwise name its methods after.
        names = {
            (route.path_format, method.lower()): route.name
            for route in iter_routes(app.routes)
            for method in route.methods or ()
        }

        operation_ids = []
        for path, operations in app.openapi()["paths"].items():
            for method, operation in operations.items():
                assert operation["operationId"] == names[(path, method)]
                operation_ids.append(operation["operationId"])
        assert len(operation_ids) == len(set(operation_ids))

    def test_describes_and_orders_every_tag(self, client: TestClient) -> None:
        document = client.get("/api/openapi.json").json()

        assert document["tags"] == TAGS
        declared = {tag["name"] for tag in TAGS}
        used: set[str] = set()
        for path, operations in document["paths"].items():
            for method, operation in operations.items():
                assert set(operation["tags"]) <= declared, f"{method.upper()} {path}"
                used |= set(operation["tags"])
        assert used == declared

    def test_names_every_envelope_after_what_it_holds(self, client: TestClient) -> None:
        # `RunCursorPage` rather than pydantic's `CursorPage_Run_`, and every reference follows.
        response = client.get("/api/openapi.json")
        schemas = response.json()["components"]["schemas"]

        assert {"RunCursorPage", "MachineList", "ApiKeyList"} <= set(schemas)
        for name, schema in schemas.items():
            assert re.fullmatch(r"[A-Za-z0-9]+", name), name
            assert schema.get("title", name) == name, name
        assert set(re.findall(r'"#/components/schemas/([^"]+)"', response.text)) <= set(schemas)


class TestStatedFacts:
    """Facts the prose states that are defined elsewhere in the code.

    Field descriptions are built from the constants they state, so they cannot drift. Docstrings and
    the overview are plain text, so these check them against the code instead -- in backticks,
    where the text writes them, so that a name is not found inside a longer word.
    """

    def test_the_overview_lists_every_error_code(self) -> None:
        assert {code for code in ErrorCode if f"`{code.value}`" in OVERVIEW} == set(ErrorCode)

    def test_the_overview_states_the_page_sizes(self) -> None:
        assert f"defaults to {DEFAULT_LIMIT}" in OVERVIEW
        assert f"at most {MAX_LIMIT}" in OVERVIEW

    @pytest.mark.parametrize("entry", [Metric, CommitField, MachineField])
    def test_an_entry_lists_the_names_it_cannot_take(self, client: TestClient, entry: Any) -> None:
        reserved = set().union(*entry.RESERVED_COLUMNS.values())
        if entry is Metric:
            reserved |= RESERVED_TEST_ENTRY_KEYS
        schema = client.get("/api/openapi.json").json()["components"]["schemas"][entry.__name__]

        assert {name for name in reserved if f"`{name}`" in schema["description"]} == reserved


def _responses(document: dict[str, Any]) -> Iterator[tuple[str, dict[str, Any]]]:
    """The schema of every successful response the document describes, with where it sits."""
    for path, operations in document["paths"].items():
        for method, operation in operations.items():
            for status, response in operation["responses"].items():
                if not status.startswith("2"):
                    continue
                for media in response.get("content", {}).values():
                    if "schema" in media:
                        yield f"{method.upper()} {path} {status}", media["schema"]


class TestResponseSamples:
    """Swagger UI shows a sample of each response, made from the schemas' examples.

    For text it has no example for, it makes something up: `"string"`, or a random match of a
    pattern, which for a metric name looks like `"ovjr1s_ivktow62klyyu4v"`. So every text value a
    response can carry has an example, either of its own or from an enclosing object's.
    """

    def test_no_text_is_made_up(self, client: TestClient) -> None:
        document = client.get("/api/openapi.json").json()
        schemas = document["components"]["schemas"]
        missing: set[str] = set()

        def visit(schema: dict[str, Any], where: str, seen: frozenset[str]) -> None:
            if "examples" in schema or "example" in schema or "const" in schema:
                return
            reference = schema.get("$ref")
            if reference is not None:
                name = reference.rsplit("/", 1)[-1]
                if name not in seen:
                    visit(schemas[name], name, seen | {name})
                return
            for branch in schema.get("anyOf", []):
                visit(branch, where, seen)
            for key, property in schema.get("properties", {}).items():
                visit(property, f"{where}.{key}", seen)
            if isinstance(schema.get("items"), dict):
                visit(schema["items"], f"{where}[]", seen)
            if isinstance(schema.get("additionalProperties"), dict):
                missing.add(f"{where}{{}}")
            if schema.get("type") == "string" and "enum" not in schema and "format" not in schema:
                missing.add(where)

        for where, schema in _responses(document):
            visit(schema, where, frozenset())
        assert not sorted(missing), "\n".join(sorted(missing))

    def test_keep_their_nulls(self, client: TestClient) -> None:
        # FastAPI drops nulls from the document, which would leave a sample response without keys
        # the API always sends -- here, the machine fields and display names that have no value.
        schemas = client.get("/api/openapi.json").json()["components"]["schemas"]

        assert schemas["SuiteSchema"]["examples"] == [examples.SUITE_SCHEMA]
        assert schemas["Machine"]["properties"]["fields"]["examples"] == [examples.MACHINE_VALUES]
        assert None in examples.MACHINE_VALUES.values()


# Every operation that takes a request body, in an order in which the examples it publishes can be
# sent one after another: each builds on what the ones before it created. Path parameters are filled
# in from the examples' own names, and `{uuid}` names the regression the first regression example
# creates.
EXAMPLE_SEQUENCE = [
    (SUITES_PATH, "post"),
    (RUNS_PATH, "post"),
    (MACHINES_PATH, "post"),
    (f"{MACHINES_PATH}/{{machine_name}}", "patch"),
    (COMMITS_PATH, "post"),
    (f"{COMMITS_PATH}/{{value}}", "patch"),
    (f"{COMMITS_PATH}/resolve", "post"),
    (QUERY_PATH, "post"),
    (REGRESSIONS_PATH, "post"),
    (f"{REGRESSIONS_PATH}/{{uuid}}", "patch"),
    (INDICATORS_PATH, "post"),
    (INDICATORS_PATH, "delete"),
    (INDICATOR_LOOKUP_PATH, "post"),
    # Last among the suite's operations, since one of its examples removes a field.
    (f"{SUITES_PATH}/{{name}}/schema", "patch"),
    ("/api/admin/api-keys", "post"),
]


class TestRequestExamples:
    """The request examples the document publishes are ones the API accepts.

    Swagger UI fills a request in with its example, so a broken one is the first thing a user trying
    the API out would send. They are all written against one suite, so they are sent here, in order,
    to a real server.
    """

    def test_every_request_body_has_some(self, client: TestClient) -> None:
        document = client.get("/api/openapi.json").json()
        bodies = [
            (path, method)
            for path, operations in document["paths"].items()
            for method, operation in operations.items()
            if "requestBody" in operation
        ]

        assert sorted(bodies) == sorted(EXAMPLE_SEQUENCE)
        for path, method in bodies:
            content = document["paths"][path][method]["requestBody"]["content"]
            assert content["application/json"].get("examples"), f"{method.upper()} {path}"

    def test_are_published_as_written(self, app: FastAPI) -> None:
        # Nulls included: FastAPI drops them from the document, which would turn an example that
        # clears a value into one that does nothing.
        document = app.openapi()

        for route in iter_routes(app.routes):
            body = getattr(route, "body_field", None)
            if body is None:
                continue
            for method in route.methods or ():
                operation = document["paths"][route.path_format][method.lower()]
                published = operation["requestBody"]["content"]["application/json"]["examples"]
                assert published == body.field_info.openapi_examples, route.name

    def test_are_accepted(
        self,
        api_client: TestClient,
        make_key: Callable[..., str],
        bearer: Callable[[str], dict[str, str]],
    ) -> None:
        headers = bearer(make_key(Scope.ADMIN))
        document = api_client.get("/api/openapi.json").json()
        names = {
            "testsuite": examples.SUITE,
            "name": examples.SUITE,
            "machine_name": examples.OTHER_MACHINE,
            "value": examples.NEXT_COMMIT,
        }

        for path, method in EXAMPLE_SEQUENCE:
            content = document["paths"][path][method]["requestBody"]["content"]
            for name, example in content["application/json"]["examples"].items():
                response = api_client.request(
                    method.upper(),
                    path.format(**names),
                    # Harmless where nothing is removed, and needed where something is.
                    params={"confirm": "true"} if path.endswith("/schema") else None,
                    json=example["value"],
                    headers=headers,
                )
                assert response.is_success, (
                    f"{method.upper()} {path} example '{name}': {response.status_code} "
                    f"{response.text}"
                )
                if path == REGRESSIONS_PATH and "uuid" not in names:
                    names["uuid"] = response.json()["uuid"]

        # The examples that clear a value with an explicit null did clear it.
        suite = f"{SUITES_PATH}/{names['testsuite']}"
        machine = api_client.get(f"{suite}/machines/{names['machine_name']}").json()
        assert machine["fields"]["sdk"] is None
        assert api_client.get(f"{suite}/commits/{names['value']}").json()["tag"] is None
        assert api_client.get(f"{suite}/regressions/{names['uuid']}").json()["commit"] is None

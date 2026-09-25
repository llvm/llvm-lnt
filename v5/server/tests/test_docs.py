"""The API documentation routes (R8): the OpenAPI document and the viewer over it."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from lnt_v5.querying import DEFAULT_LIMIT, MAX_LIMIT
from lnt_v5.routes.commits import COMMITS_PATH
from lnt_v5.routes.machines import MACHINES_PATH
from lnt_v5.routes.runs import RUNS_PATH


class TestOpenApiDocument:
    def test_is_served_under_api(self, client: TestClient) -> None:
        response = client.get("/api/openapi.json")

        assert response.status_code == 200
        assert response.headers["content-type"].startswith("application/json")
        assert response.json()["openapi"].startswith("3.")

    def test_identifies_the_api_rather_than_the_build(self, client: TestClient) -> None:
        # R8 fixes info.version at the API's major version.
        info = client.get("/api/openapi.json").json()["info"]

        assert info == {"title": "LNT v5", "version": "5"}

    def test_describes_only_statuses_r4_permits(self, client: TestClient) -> None:
        # R8: the document must not advertise a response the API cannot produce. FastAPI adds a
        # 422 to every operation taking a body or parameters, which R4 does not permit and which
        # the error handlers turn into a 400.
        r4_statuses = {"200", "201", "204", "400", "401", "403", "404", "409", "500"}

        for path, operations in client.get("/api/openapi.json").json()["paths"].items():
            for method, operation in operations.items():
                extra = set(operation.get("responses", {})) - r4_statuses
                assert not extra, f"{method.upper()} {path} documents {sorted(extra)}"

    def test_excludes_the_health_probe(self, client: TestClient) -> None:
        # R5 places /healthz outside the REST API surface, so it is not part of what R8 describes.
        assert "/healthz" not in client.get("/api/openapi.json").json()["paths"]

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

    def test_describes_the_error_envelope(self, client: TestClient) -> None:
        document = client.get("/api/openapi.json").json()

        envelope = document["components"]["schemas"]["ErrorEnvelope"]
        assert set(document["components"]["schemas"]["ErrorBody"]["properties"]) == {
            "code",
            "message",
        }
        assert "error" in envelope["properties"]


class TestDocumentedAuthentication:
    """R5's failures, as R8's document reports them.

    They are derived from each route's declared scope rather than restated per endpoint, so what
    matters is that the derivation lands on the right operations.
    """

    def test_declares_the_bearer_scheme(self, client: TestClient) -> None:
        schemes = client.get("/api/openapi.json").json()["components"]["securitySchemes"]

        assert schemes["ApiKey"]["type"] == "http"
        assert schemes["ApiKey"]["scheme"] == "bearer"

    def test_every_operation_requires_that_scheme(self, client: TestClient) -> None:
        for path, operations in client.get("/api/openapi.json").json()["paths"].items():
            for method, operation in operations.items():
                assert operation.get("security") == [{"ApiKey": []}], f"{method.upper()} {path}"

    def test_a_read_operation_can_be_refused_but_never_forbidden(self, client: TestClient) -> None:
        # Every valid key grants `read`, so a read-scoped operation has no way to answer 403.
        index = client.get("/api/openapi.json").json()["paths"]["/api"]["get"]

        assert {"400", "401"} <= set(index["responses"])
        assert "403" not in index["responses"]

    def test_an_operation_above_read_can_be_forbidden(self, client: TestClient) -> None:
        keys = client.get("/api/openapi.json").json()["paths"]["/api/admin/api-keys"]["get"]

        assert {"400", "401", "403"} <= set(keys["responses"])


class TestSuiteOperations:
    """R8: the document describes what the API can actually do, including these five."""

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

    def test_creating_and_reading_a_suite_share_one_schema(self, client: TestClient) -> None:
        """The machine-checkable form of "postable verbatim to another instance".

        If the request body and the detail response ever referenced different components, a
        generated client could not feed one to the other -- which is the whole property endpoints.md
        rests on.
        """
        paths = client.get("/api/openapi.json").json()["paths"]
        posted = paths["/api/suites"]["post"]["requestBody"]["content"]["application/json"]
        returned = paths["/api/suites/{name}"]["get"]["responses"]["200"]["content"][
            "application/json"
        ]

        assert posted["schema"] == returned["schema"]

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
    """R8: the document describes what the API can actually do, including these five."""

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
            # An unknown suite on every one of them (R1), an unknown machine on the three that
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

    @pytest.mark.parametrize("name", ["search", "tracked", "sort", "limit", "offset"])
    def test_the_list_documents_every_parameter_endpoints_md_gives_it(
        self, client: TestClient, name: str
    ) -> None:
        operation = client.get("/api/openapi.json").json()["paths"][MACHINES]["get"]

        assert name in {parameter["name"] for parameter in operation["parameters"]}

    def test_the_list_documents_r2s_page_size(self, client: TestClient) -> None:
        operation = client.get("/api/openapi.json").json()["paths"][MACHINES]["get"]
        limit = next(p for p in operation["parameters"] if p["name"] == "limit")

        assert limit["schema"]["default"] == DEFAULT_LIMIT == 25
        assert limit["schema"]["maximum"] == MAX_LIMIT == 10000

    def test_the_list_enumerates_the_sort_fields_rather_than_taking_any_string(
        self, client: TestClient
    ) -> None:
        # endpoints.md names four and no others, so a generated client should not be able to ask
        # for a fifth.
        operation = client.get("/api/openapi.json").json()["paths"][MACHINES]["get"]
        sort = next(p for p in operation["parameters"] if p["name"] == "sort")

        assert set(sort["schema"]["enum"]) == {"name", "-name", "last_run_at", "-last_run_at"}

    def test_the_list_returns_r2s_offset_envelope(self, client: TestClient) -> None:
        document = client.get("/api/openapi.json").json()
        body = document["paths"][MACHINES]["get"]["responses"]["200"]["content"][
            "application/json"
        ]["schema"]
        envelope = document["components"]["schemas"][body["$ref"].rsplit("/", 1)[-1]]

        assert set(envelope["properties"]) == {"items", "total"}

    def test_creating_and_reading_a_machine_share_the_entity_object(
        self, client: TestClient
    ) -> None:
        # D7: `POST` takes the same object a run submission nests, and the response is that object
        # plus the derived `last_run_at`. A generated client must be able to feed one to the other.
        schemas = client.get("/api/openapi.json").json()["components"]["schemas"]

        assert set(schemas["Machine"]["properties"]) == {
            *schemas["MachineObject"]["properties"],
            "last_run_at",
        }

    def test_the_response_promises_every_key_it_documents(self, client: TestClient) -> None:
        # R4: a key an endpoint documents is always present, and null when it has no value. The
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
    """R8: the document describes what the API can actually do, including these six."""

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
            # An unknown suite on every one of them (R1), an unknown commit on the three that
            # address one, and D2's stale reader everywhere the suite's own columns are queried.
            # The list's 404 covers an unknown `machine=` too (R3), and the writes' 409 covers a
            # duplicate value, a taken ordinal and a commit a regression still references.
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
        "name", ["search", "machine", "has_profiles", "sort", "limit", "cursor"]
    )
    def test_the_list_documents_every_parameter_endpoints_md_gives_it(
        self, client: TestClient, name: str
    ) -> None:
        operation = client.get("/api/openapi.json").json()["paths"][COMMITS]["get"]

        assert name in {parameter["name"] for parameter in operation["parameters"]}

    def test_the_list_takes_no_offset(self, client: TestClient) -> None:
        # R2 pairs `offset` with `total`, and a cursor-paginated list has neither.
        operation = client.get("/api/openapi.json").json()["paths"][COMMITS]["get"]

        assert "offset" not in {parameter["name"] for parameter in operation["parameters"]}

    def test_the_list_enumerates_the_sort_fields_rather_than_taking_any_string(
        self, client: TestClient
    ) -> None:
        # endpoints.md names two and no others, and omitting it is the third, distinct, option.
        operation = client.get("/api/openapi.json").json()["paths"][COMMITS]["get"]
        sort = next(p for p in operation["parameters"] if p["name"] == "sort")
        allowed = [option for option in sort["schema"]["anyOf"] if "enum" in option]

        assert [set(option["enum"]) for option in allowed] == [{"ordinal", "-ordinal"}]

    def test_the_list_returns_r2s_cursor_envelope(self, client: TestClient) -> None:
        document = client.get("/api/openapi.json").json()
        body = document["paths"][COMMITS]["get"]["responses"]["200"]["content"]["application/json"][
            "schema"
        ]
        envelope = document["components"]["schemas"][body["$ref"].rsplit("/", 1)[-1]]

        assert set(envelope["properties"]) == {"items", "cursor"}

    def test_the_cursor_promises_a_null_previous(self, client: TestClient) -> None:
        # R2: pagination is forward-only, so the document must not advertise a backward cursor the
        # API can never produce (R8).
        cursor = client.get("/api/openapi.json").json()["components"]["schemas"]["PageCursor"]

        assert cursor["properties"]["previous"]["type"] == "null"
        assert set(cursor["required"]) == {"next", "previous"}

    def test_creating_and_reading_a_commit_share_the_entity_object(
        self, client: TestClient
    ) -> None:
        # D7: `POST` takes the same object a run submission nests, and the response is that object
        # plus what only a stored commit has.
        schemas = client.get("/api/openapi.json").json()["components"]["schemas"]

        assert set(schemas["Commit"]["properties"]) == {
            *schemas["CommitObject"]["properties"],
            "tag",
        }
        assert set(schemas["CommitDetail"]["properties"]) == {
            *schemas["Commit"]["properties"],
            "previous",
            "next",
        }

    def test_no_request_body_accepts_a_tag_at_creation(self, client: TestClient) -> None:
        # D7 makes `tag` PATCH-only, so the document must not advertise it where it is refused.
        schemas = client.get("/api/openapi.json").json()["components"]["schemas"]

        assert "tag" not in schemas["CommitObject"]["properties"]
        assert "tag" in schemas["CommitUpdate"]["properties"]

    def test_no_request_body_accepts_a_rename(self, client: TestClient) -> None:
        # endpoints.md: `value` is immutable.
        schemas = client.get("/api/openapi.json").json()["components"]["schemas"]

        assert "value" not in schemas["CommitUpdate"]["properties"]

    @pytest.mark.parametrize("model", ["Commit", "CommitDetail"])
    def test_the_response_promises_every_key_it_documents(
        self, client: TestClient, model: str
    ) -> None:
        # R4: a key an endpoint documents is always present, and null when it has no value.
        schemas = client.get("/api/openapi.json").json()["components"]["schemas"]

        assert set(schemas[model]["required"]) == set(schemas[model]["properties"])


RUNS = RUNS_PATH
RUN = f"{RUNS_PATH}/{{uuid}}"


class TestRunOperations:
    """R8: the document describes what the API can actually do, including these three."""

    @pytest.mark.parametrize(("path", "method"), [(RUNS, "post"), (RUN, "get"), (RUN, "delete")])
    def test_is_documented(self, client: TestClient, path: str, method: str) -> None:
        paths = client.get("/api/openapi.json").json()["paths"]

        assert method in paths[path], f"{method.upper()} {path} is not in the document"

    @pytest.mark.parametrize(
        ("path", "method", "status"),
        [
            # An unknown suite on every one of them (R1), an unknown run on the two that address
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
        # R4: a key an endpoint documents is always present, and null when it has no value.
        run = client.get("/api/openapi.json").json()["components"]["schemas"]["Run"]

        assert set(run["required"]) == set(run["properties"])
        assert set(run["properties"]) == {
            "uuid",
            "machine",
            "commit",
            "submitted_at",
            "run_parameters",
        }

    def test_a_run_names_the_entities_it_references_rather_than_nesting_them(
        self, client: TestClient
    ) -> None:
        # R4: a reference carries the other entity's identifier under a key named after it.
        run = client.get("/api/openapi.json").json()["components"]["schemas"]["Run"]

        assert run["properties"]["machine"]["type"] == "string"
        assert run["properties"]["commit"]["type"] == "string"

    def test_the_submission_body_is_the_one_d6_specifies(self, client: TestClient) -> None:
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
        # D6 and D7: one object per entity, shared with `POST /machines` and `POST /commits`, so a
        # generated client can feed one to the other.
        submission = client.get("/api/openapi.json").json()["components"]["schemas"][
            "RunSubmission"
        ]["properties"]

        assert submission["machine"]["$ref"].endswith("/MachineObject")
        assert submission["commit"]["$ref"].endswith("/CommitObject")


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

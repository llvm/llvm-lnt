"""The API documentation routes (R8): the OpenAPI document and the viewer over it."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from lnt_v5.querying import DEFAULT_LIMIT, MAX_LIMIT
from lnt_v5.routes.commits import COMMITS_PATH
from lnt_v5.routes.machines import MACHINES_PATH
from lnt_v5.routes.profiles import PROFILES_PATH, RUN_PROFILES_PATH
from lnt_v5.routes.regressions import INDICATORS_PATH, REGRESSIONS_PATH
from lnt_v5.routes.runs import MACHINE_RUNS_PATH, RUNS_PATH
from lnt_v5.routes.samples import SAMPLES_PATH
from lnt_v5.routes.tests import TESTS_PATH
from lnt_v5.routes.timeseries import DEFAULT_LAST_N, QUERY_PATH, TRENDS_PATH


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

    @pytest.mark.parametrize("path", ["/healthz", "/llms.txt"])
    def test_excludes_the_routes_outside_the_rest_api(self, client: TestClient, path: str) -> None:
        # R5 places both of these outside the REST API surface, so neither is part of what R8
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
        schemas = client.get("/api/openapi.json").json()["components"]["schemas"]
        run = schemas["Run"]

        assert set(run["required"]) == set(run["properties"])
        assert set(run["properties"]) == {"uuid", "machine", "commit", "submitted_at"}

    def test_only_the_detail_carries_the_unbounded_blob(self, client: TestClient) -> None:
        # endpoints.md: `run_parameters` appears in the detail response only, because no list view
        # renders it. The detail is otherwise the list's object exactly.
        schemas = client.get("/api/openapi.json").json()["components"]["schemas"]
        detail = schemas["RunDetail"]

        assert set(detail["required"]) == set(detail["properties"])
        assert set(detail["properties"]) == {*schemas["Run"]["properties"], "run_parameters"}

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


class TestReadOperations:
    """R8: the lists that read runs, tests and samples back."""

    @pytest.mark.parametrize("path", [RUNS, MACHINE_RUNS_PATH, TESTS_PATH, SAMPLES_PATH])
    def test_is_documented(self, client: TestClient, path: str) -> None:
        paths = client.get("/api/openapi.json").json()["paths"]

        assert "get" in paths[path], f"GET {path} is not in the document"

    @pytest.mark.parametrize("path", [RUNS, MACHINE_RUNS_PATH, TESTS_PATH, SAMPLES_PATH])
    @pytest.mark.parametrize("status", ["404", "409"])
    def test_documents_the_failures_endpoints_md_specifies(
        self, client: TestClient, path: str, status: str
    ) -> None:
        # An unknown suite on every one of them (R1) -- and on three of the four, an unknown entity
        # named by the path or by a filter as well. D2's stale reader accounts for the 409.
        operation = client.get("/api/openapi.json").json()["paths"][path]["get"]

        assert status in operation["responses"]

    @pytest.mark.parametrize(
        ("path", "expected"),
        [
            (RUNS, {"search", "machine", "commit", "after", "before", "has_profiles", "sort"}),
            (MACHINE_RUNS_PATH, {"after", "before", "sort"}),
            (TESTS_PATH, {"search", "machine", "metric"}),
            (SAMPLES_PATH, {"test"}),
        ],
    )
    def test_documents_exactly_the_filters_endpoints_md_gives_it(
        self, client: TestClient, path: str, expected: set[str]
    ) -> None:
        """Exactly, not merely at least: a filter the spec does not give a list is as wrong as a
        missing one.

        R3 is explicit that `GET /tests` supports no time range, for instance, and a subset
        assertion would let one appear unnoticed. The path's own templated segments and R2's two
        paging parameters are the rest of what every one of these declares.
        """
        templated = {segment[1:-1] for segment in path.split("/") if segment.startswith("{")}
        operation = client.get("/api/openapi.json").json()["paths"][path]["get"]
        names = {parameter["name"] for parameter in operation["parameters"]}

        assert names == expected | templated | {"limit", "cursor"}

    @pytest.mark.parametrize("path", [RUNS, MACHINE_RUNS_PATH, TESTS_PATH, SAMPLES_PATH])
    def test_pages_with_a_cursor_rather_than_an_offset(self, client: TestClient, path: str) -> None:
        # R2: an unbounded list is cursor-paginated and carries no `total`, which is what a client
        # generated from this document has to be told.
        document = client.get("/api/openapi.json").json()
        operation = document["paths"][path]["get"]
        body = operation["responses"]["200"]["content"]["application/json"]["schema"]
        envelope = document["components"]["schemas"][body["$ref"].rsplit("/", 1)[-1]]
        names = {parameter["name"] for parameter in operation["parameters"]}

        assert {"limit", "cursor"} <= names
        assert "offset" not in names
        assert set(envelope["properties"]) == {"items", "cursor"}

    @pytest.mark.parametrize("path", [RUNS, MACHINE_RUNS_PATH])
    def test_the_run_lists_enumerate_their_sort_fields(self, client: TestClient, path: str) -> None:
        # endpoints.md names one field and both directions, so a generated client should not be
        # able to ask for a third spelling.
        operation = client.get("/api/openapi.json").json()["paths"][path]["get"]
        sort = next(p for p in operation["parameters"] if p["name"] == "sort")

        assert set(sort["schema"]["anyOf"][0]["enum"]) == {"submitted_at", "-submitted_at"}

    @pytest.mark.parametrize("path", [TESTS_PATH, SAMPLES_PATH])
    def test_the_lists_with_no_order_of_their_own_offer_no_sort(
        self, client: TestClient, path: str
    ) -> None:
        operation = client.get("/api/openapi.json").json()["paths"][path]["get"]

        assert "sort" not in {parameter["name"] for parameter in operation["parameters"]}

    def test_no_path_carries_a_test_name(self, client: TestClient) -> None:
        """R1: a test name legitimately contains `/`, so no path segment can hold one.

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
        # R4's stated exception: `metrics` is not a `fields` dict, so nothing in it is ever null.
        sample = client.get("/api/openapi.json").json()["components"]["schemas"]["Sample"]
        values = sample["properties"]["metrics"]["additionalProperties"]

        assert set(sample["required"]) == set(sample["properties"]) == {"test", "metrics"}
        assert {"type": "null"} not in values["anyOf"]


RUN_PROFILES = RUN_PROFILES_PATH
PROFILE = f"{PROFILES_PATH}/{{uuid}}"
FUNCTIONS = f"{PROFILE}/functions"
FUNCTION = f"{FUNCTIONS}/{{fn_name}}"

# The three that serve what is inside a blob, as opposed to the listing, which never opens one.
PROFILE_DATA = [PROFILE, FUNCTIONS, FUNCTION]


class TestProfileOperations:
    """R8: the four reads endpoints.md specifies under Profiles."""

    @pytest.mark.parametrize("path", [RUN_PROFILES, *PROFILE_DATA])
    def test_is_documented(self, client: TestClient, path: str) -> None:
        paths = client.get("/api/openapi.json").json()["paths"]

        assert "get" in paths[path], f"GET {path} is not in the document"

    @pytest.mark.parametrize("path", [RUN_PROFILES, *PROFILE_DATA])
    @pytest.mark.parametrize("status", ["404", "409"])
    def test_documents_the_failures_endpoints_md_specifies(
        self, client: TestClient, path: str, status: str
    ) -> None:
        # An unknown suite on every one of them (R1), plus the run, the profile or the function the
        # path names. D2's stale reader accounts for the 409.
        operation = client.get("/api/openapi.json").json()["paths"][path]["get"]

        assert status in operation["responses"]

    @pytest.mark.parametrize("path", PROFILE_DATA)
    def test_the_data_endpoints_document_the_corrupt_blob_500(
        self, client: TestClient, path: str
    ) -> None:
        # endpoints.md specifies it and R4 gives it a code, so unlike the generic handler's 500
        # this one is part of the contract and has to be in the document.
        operation = client.get("/api/openapi.json").json()["paths"][path]["get"]

        assert "500" in operation["responses"]

    def test_the_listing_documents_no_500(self, client: TestClient) -> None:
        # It never opens a blob, so it has no way to discover that one is corrupt.
        operation = client.get("/api/openapi.json").json()["paths"][RUN_PROFILES]["get"]

        assert "500" not in operation["responses"]

    @pytest.mark.parametrize("path", [RUN_PROFILES, FUNCTIONS])
    def test_the_lists_are_unpaginated(self, client: TestClient, path: str) -> None:
        # R2: both are bounded -- by the tests of one run, and by the functions of one binary -- so
        # they carry `items` alone, with neither a cursor nor a total to page by.
        document = client.get("/api/openapi.json").json()
        operation = document["paths"][path]["get"]
        body = operation["responses"]["200"]["content"]["application/json"]["schema"]
        envelope = document["components"]["schemas"][body["$ref"].rsplit("/", 1)[-1]]
        names = {parameter["name"] for parameter in operation["parameters"]}

        assert set(envelope["properties"]) == {"items"}
        assert not names & {"limit", "offset", "cursor"}

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
        ],
    )
    def test_a_response_carries_exactly_the_keys_endpoints_md_gives_it(
        self, client: TestClient, schema: str, keys: set[str]
    ) -> None:
        # R4: a documented key is always present, so `properties` and `required` agree.
        described = client.get("/api/openapi.json").json()["components"]["schemas"][schema]

        assert set(described["properties"]) == keys
        assert set(described["required"]) == keys

    def test_a_top_level_counter_is_an_integer_and_every_other_counter_a_number(
        self, client: TestClient
    ) -> None:
        # endpoints.md draws that line: the top-level counters are integers, and the function and
        # instruction counters are floats. Both are raw values rather than percentages.
        schemas = client.get("/api/openapi.json").json()["components"]["schemas"]

        assert schemas["ProfileMetadata"]["properties"]["counters"]["additionalProperties"] == {
            "type": "integer"
        }
        for schema in ("ProfileFunction", "Instruction", "FunctionDisassembly"):
            counters = schemas[schema]["properties"]["counters"]
            assert counters["additionalProperties"] == {"type": "number"}, schema

    def test_the_function_name_is_one_path_parameter(self, client: TestClient) -> None:
        """R1: the segment spans the rest of the path, and the document still shows one segment.

        `{fn_name:path}` is how a name containing `/` stays addressable -- a demangled
        `std::operator/(...)` -- and the point of checking it here is that the wire contract a
        generated client sees is unchanged by it.
        """
        operation = client.get("/api/openapi.json").json()["paths"][FUNCTION]["get"]

        assert {parameter["name"] for parameter in operation["parameters"]} == {
            "testsuite",
            "uuid",
            "fn_name",
        }

    @pytest.mark.parametrize("path", [RUN_PROFILES, *PROFILE_DATA])
    def test_can_be_refused_but_never_forbidden(self, client: TestClient, path: str) -> None:
        # R5: all four are `read`-scoped, and every valid key grants `read`.
        operation = client.get("/api/openapi.json").json()["paths"][path]["get"]

        assert "403" not in operation["responses"]


REGRESSIONS = REGRESSIONS_PATH
REGRESSION = f"{REGRESSIONS_PATH}/{{uuid}}"
INDICATORS = INDICATORS_PATH


class TestRegressionOperations:
    """R8: the document describes what the API can actually do, including these seven."""

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
        ],
    )
    def test_is_documented(self, client: TestClient, path: str, method: str) -> None:
        paths = client.get("/api/openapi.json").json()["paths"]

        assert method in paths[path], f"{method.upper()} {path} is not in the document"

    @pytest.mark.parametrize(
        ("path", "method"),
        [
            # An unknown suite on every one of them (R1); on the list, an unknown `machine=` or
            # `test=`; on the writes, an unknown regression, commit, machine or test named by the
            # path or the body. D2's stale reader accounts for the 409 everywhere.
            (REGRESSIONS, "get"),
            (REGRESSIONS, "post"),
            (REGRESSION, "get"),
            (REGRESSION, "patch"),
            (REGRESSION, "delete"),
            (INDICATORS, "post"),
            (INDICATORS, "delete"),
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
        # Exactly, not merely at least: R3 gives this list no time range and no `sort`, and a
        # subset assertion would let one appear unnoticed.
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
            "limit",
            "cursor",
        }

    def test_the_list_pages_with_a_cursor_rather_than_an_offset(self, client: TestClient) -> None:
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
            "indicators",
        }

    @pytest.mark.parametrize("model", ["Regression", "RegressionDetail", "Indicator"])
    def test_the_response_promises_every_key_it_documents(
        self, client: TestClient, model: str
    ) -> None:
        # R4: a key an endpoint documents is always present, and null when it has no value.
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

    def test_no_update_body_accepts_indicators(self, client: TestClient) -> None:
        # endpoints.md: `PATCH` does not touch them, so the document must not advertise a key the
        # endpoint refuses every time.
        schemas = client.get("/api/openapi.json").json()["components"]["schemas"]

        assert "indicators" in schemas["RegressionCreate"]["properties"]
        assert "indicators" not in schemas["RegressionUpdate"]["properties"]

    def test_an_indicator_names_the_entities_it_references_rather_than_nesting_them(
        self, client: TestClient
    ) -> None:
        # R4: a reference carries the other entity's identifier under a key named after it.
        indicator = client.get("/api/openapi.json").json()["components"]["schemas"]["Indicator"]

        for key in ("machine", "test", "metric"):
            assert indicator["properties"][key]["type"] == "string"

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
    """R8: the two read-only POSTs endpoints.md specifies under Time Series."""

    @pytest.mark.parametrize("path", [QUERY_PATH, TRENDS_PATH])
    def test_is_documented(self, client: TestClient, path: str) -> None:
        paths = client.get("/api/openapi.json").json()["paths"]

        assert "post" in paths[path], f"POST {path} is not in the document"

    @pytest.mark.parametrize("path", [QUERY_PATH, TRENDS_PATH])
    @pytest.mark.parametrize("status", ["404", "409"])
    def test_documents_the_failures_endpoints_md_specifies(
        self, client: TestClient, path: str, status: str
    ) -> None:
        # An unknown suite on both (R1), plus an unknown machine, test or bounding commit the body
        # names; D2's stale reader accounts for the 409.
        operation = client.get("/api/openapi.json").json()["paths"][path]["post"]

        assert status in operation["responses"]

    @pytest.mark.parametrize("path", [QUERY_PATH, TRENDS_PATH])
    def test_takes_its_filters_in_the_body_rather_than_the_query_string(
        self, client: TestClient, path: str
    ) -> None:
        # The whole reason these are POSTs: a list of test names and six bounds do not fit a query
        # string. The suite is the only thing left in the path.
        operation = client.get("/api/openapi.json").json()["paths"][path]["post"]

        assert "requestBody" in operation
        assert {p["name"] for p in operation.get("parameters", [])} == {"testsuite"}

    def test_the_query_body_carries_exactly_the_keys_endpoints_md_gives_it(
        self, client: TestClient
    ) -> None:
        # Exactly, not merely at least: R2's `limit` and `cursor` are keys here rather than query
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

    def test_the_query_body_documents_r2s_page_size(self, client: TestClient) -> None:
        limit = client.get("/api/openapi.json").json()["components"]["schemas"]["QueryRequest"][
            "properties"
        ]["limit"]

        assert limit["default"] == DEFAULT_LIMIT == 25
        assert limit["maximum"] == MAX_LIMIT == 10000

    def test_the_query_enumerates_its_sort_fields_rather_than_taking_any_string(
        self, client: TestClient
    ) -> None:
        # endpoints.md names three fields, and R3's `-` prefix spells each of them backwards; a
        # generated client should not be able to ask for a fourth.
        sort = client.get("/api/openapi.json").json()["components"]["schemas"]["QueryRequest"][
            "properties"
        ]["sort"]
        allowed = [option for option in sort["anyOf"] if "enum" in option]

        assert [set(option["enum"]) for option in allowed] == [
            {"test", "-test", "commit", "-commit", "submitted_at", "-submitted_at"}
        ]

    def test_the_trends_body_carries_exactly_the_three_keys_endpoints_md_gives_it(
        self, client: TestClient
    ) -> None:
        schemas = client.get("/api/openapi.json").json()["components"]["schemas"]

        assert set(schemas["TrendsRequest"]["properties"]) == {"metric", "machine", "last_n"}
        assert schemas["TrendsRequest"]["required"] == ["metric"]

    def test_the_trends_window_defaults_to_a_bounded_one(self, client: TestClient) -> None:
        # endpoints.md: this response is unpaginated and `read`-scoped, so an omitted `last_n` must
        # not mean "aggregate the whole suite". The default is part of the wire contract.
        last_n = client.get("/api/openapi.json").json()["components"]["schemas"]["TrendsRequest"][
            "properties"
        ]["last_n"]

        assert last_n["default"] == DEFAULT_LAST_N == 500
        assert (last_n["minimum"], last_n["maximum"]) == (1, MAX_LIMIT)

    def test_the_trends_machine_is_a_list_where_the_querys_is_one_name(
        self, client: TestClient
    ) -> None:
        # endpoints.md draws the difference deliberately: the Dashboard needs several machines in
        # one call, and the Graph page plots one at a time.
        schemas = client.get("/api/openapi.json").json()["components"]["schemas"]
        query = schemas["QueryRequest"]["properties"]["machine"]["anyOf"]
        trends = schemas["TrendsRequest"]["properties"]["machine"]["anyOf"]

        assert {"type": "string"} in query
        assert [option["type"] for option in trends if "type" in option] == ["array", "null"]

    def test_the_query_pages_with_a_cursor_and_trends_does_not_page_at_all(
        self, client: TestClient
    ) -> None:
        # R2: one is unbounded and carries a cursor, the other is bounded by (machines x last_n)
        # and carries `items` alone.
        document = client.get("/api/openapi.json").json()
        envelopes = {
            path: document["components"]["schemas"][
                document["paths"][path]["post"]["responses"]["200"]["content"]["application/json"][
                    "schema"
                ]["$ref"].rsplit("/", 1)[-1]
            ]
            for path in (QUERY_PATH, TRENDS_PATH)
        }

        assert set(envelopes[QUERY_PATH]["properties"]) == {"items", "cursor"}
        assert set(envelopes[TRENDS_PATH]["properties"]) == {"items"}

    def test_a_data_point_carries_exactly_what_endpoints_md_gives_it(
        self, client: TestClient
    ) -> None:
        # R4: a documented key is always present, and null when it has no value.
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

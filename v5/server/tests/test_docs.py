"""The API documentation routes (R8): the OpenAPI document and the viewer over it."""

from __future__ import annotations

from fastapi.testclient import TestClient


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

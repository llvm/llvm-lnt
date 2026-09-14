"""The API index (R1)."""

from __future__ import annotations

from fastapi.testclient import TestClient

from lnt_v5.routes.index import DOCS_PATH, OPENAPI_PATH, SUITES_PATH


class TestIndex:
    def test_links_to_the_suite_list_and_the_documentation(self, api_client: TestClient) -> None:
        response = api_client.get("/api/")

        assert response.status_code == 200
        assert response.json() == {
            "links": {"suites": SUITES_PATH, "openapi": OPENAPI_PATH, "docs": DOCS_PATH}
        }

    def test_the_documentation_links_resolve(self, api_client: TestClient) -> None:
        # The index is only useful if what it points at is actually served here. `suites` is
        # deliberately not checked: the suite endpoints do not exist yet.
        links = api_client.get("/api/").json()["links"]

        assert api_client.get(links["openapi"]).status_code == 200
        assert api_client.get(links["docs"]).status_code == 200

    def test_is_reachable_without_the_trailing_slash(self, api_client: TestClient) -> None:
        # The SPA mount matches every path, so `/api` would otherwise be answered by the catch-all
        # as a 404 rather than redirected to `/api/`.
        assert api_client.get("/api").json() == api_client.get("/api/").json()

    def test_does_not_enumerate_the_suites_itself(self, api_client: TestClient) -> None:
        # `GET /api/suites` is the canonical list; the index only points at it.
        assert set(api_client.get("/api/").json()) == {"links"}

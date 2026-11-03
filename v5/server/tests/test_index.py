"""The API index (I1)."""

from __future__ import annotations

from fastapi.testclient import TestClient

from lnt_v5.app import create_app
from lnt_v5.config import Settings
from lnt_v5.routes.index import DOCS_PATH, OPENAPI_PATH
from lnt_v5.routes.suites import PROJECTS_PATH


class TestIndex:
    def test_links_to_the_project_list_and_the_documentation(self, api_client: TestClient) -> None:
        response = api_client.get("/api")

        assert response.status_code == 200
        assert response.json() == {
            "links": {"projects": PROJECTS_PATH, "openapi": OPENAPI_PATH, "docs": DOCS_PATH},
            "revision": None,
        }

    def test_reports_the_configured_revision(self, api_settings: Settings) -> None:
        settings = api_settings.model_copy(update={"lnt_revision": "0dd267f1"})
        with TestClient(create_app(settings)) as client:
            assert client.get("/api").json()["revision"] == "0dd267f1"

    def test_every_link_resolves(self, api_client: TestClient) -> None:
        # The index is only useful if what it points at is actually served here.
        links = api_client.get("/api").json()["links"]

        assert api_client.get(links["projects"]).status_code == 200
        assert api_client.get(links["openapi"]).status_code == 200
        assert api_client.get(links["docs"]).status_code == 200

    def test_the_trailing_slash_form_redirects_to_it(self, api_client: TestClient) -> None:
        # `/api` is canonical, like every other path in the API.
        response = api_client.get("/api/", follow_redirects=False)

        assert response.status_code == 307
        assert response.headers["location"] == "/api"

    def test_does_not_enumerate_the_projects_itself(self, api_client: TestClient) -> None:
        # `GET /api/projects` is the canonical list; the index only points at it.
        assert set(api_client.get("/api").json()) == {"links", "revision"}

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from lnt_v5.app import create_app
from lnt_v5.config import Settings
from lnt_v5.spa import is_api_path, is_static_asset_path

# Both predicates read a request path, never a URL: what reaches them is `scope["path"]`, which
# carries no query string. Cases below are written in that shape.


class TestIsApiPath:
    @pytest.mark.parametrize("path", ["/api", "/api/", "/api/suites/nts/runs", "/api/suites"])
    def test_treats_as_an_api_path(self, path: str) -> None:
        assert is_api_path(path) is True

    @pytest.mark.parametrize("path", ["/", "/suites/nts", "/apiary", "/graph"])
    def test_treats_as_a_client_path(self, path: str) -> None:
        assert is_api_path(path) is False


class TestIsStaticAssetPath:
    @pytest.mark.parametrize(
        "path",
        [
            "/favicon.ico",
            "/assets/index-DcWSbQGc.js",
            "/assets/index-BfuC4xkh.css",
            "/assets/index-DcWSbQGc.js.map",
            "/fonts/inter.woff2",
            "/llms.txt",
            "/site.webmanifest",
            "/favicon.ICO",
        ],
    )
    def test_treats_as_a_static_asset_request(self, path: str) -> None:
        assert is_static_asset_path(path) is True

    # Plenty of real routes end in something dot-like, so a bare "contains a dot" check would
    # break them. Machine names in particular routinely carry version numbers.
    @pytest.mark.parametrize(
        "path",
        [
            "/",
            "/suites/nts",
            "/suites/nts/machines/macos-26.5-arm64",
            "/suites/nts/machines/linux-x86_64",
            "/suites/nts/commits/014621ede7c1",
            "/suites/nts/runs/573af861-8303-4a5b-a643-b8321e0142c4",
            "/graph",
            "/compare",
            "/profiles",
            "/admin",
        ],
    )
    def test_treats_as_a_client_route(self, path: str) -> None:
        assert is_static_asset_path(path) is False


class TestSpaServing:
    def test_serves_index_html_for_an_unknown_deep_link(self, client: TestClient) -> None:
        response = client.get("/suites/nts/runs/abc")

        assert response.status_code == 200
        assert "<title>LNT</title>" in response.text
        assert response.headers["content-type"].startswith("text/html")

    def test_still_serves_the_spa_for_a_route_whose_last_segment_contains_dots(
        self, client: TestClient
    ) -> None:
        response = client.get("/suites/nts/machines/macos-26.5-arm64")

        assert response.status_code == 200
        assert "<title>LNT</title>" in response.text

    def test_serves_an_asset_that_exists(self, client: TestClient) -> None:
        response = client.get("/real.css")

        assert response.status_code == 200
        assert response.text == "body{}"

    @pytest.mark.parametrize("url", ["/", "/suites/nts", "/real.css"])
    def test_head_is_answered_like_get(self, client: TestClient, url: str) -> None:
        # A literal port of the TypeScript `method !== 'GET'` check would 404 every HEAD.
        response = client.head(url)

        assert response.status_code == 200

    def test_returns_the_json_error_envelope_for_an_unmatched_api_route(
        self, client: TestClient
    ) -> None:
        response = client.get("/api/suites/nts/nope")

        assert response.status_code == 404
        assert response.json()["error"]["code"] == "not_found"
        assert response.headers["content-type"].startswith("application/json")

    @pytest.mark.parametrize("method", ["post", "put", "patch", "delete", "options"])
    def test_does_not_serve_the_spa_for_non_get_requests(
        self, client: TestClient, method: str
    ) -> None:
        # Starlette's StaticFiles answers these with 405, which R4 does not permit.
        response = getattr(client, method)("/suites/nts")

        assert response.status_code == 404
        assert response.json()["error"]["code"] == "not_found"

    @pytest.mark.parametrize("url", ["/assets/index-STALEHASH.js", "/favicon.ico"])
    def test_404s_a_missing_asset_instead_of_serving_the_spa(
        self, client: TestClient, url: str
    ) -> None:
        # The shape a client ends up requesting when it is holding a hashed URL from a previous
        # deploy. Serving index.html here would be a MIME-type error rather than a clean miss.
        response = client.get(url)

        assert response.status_code == 404
        assert response.json()["error"]["code"] == "not_found"

    def test_a_miss_names_what_was_requested(self, client: TestClient) -> None:
        # StaticFiles raises its own 404 with a bare "Not Found" detail, which says nothing about
        # the request. The exact wording is R4-unstable, so this pins the content, not the prose.
        message = client.get("/favicon.ico").json()["error"]["message"]

        assert "GET" in message
        assert "/favicon.ico" in message

    def test_does_not_serve_files_outside_the_client_bundle(
        self, client_dist: Path, client: TestClient
    ) -> None:
        # The sentinel needs a servable extension: a traversal to a path without one would be
        # converted into an index.html response by the SPA fallback and pass for the wrong reason.
        secret = client_dist.parent / "secret.css"
        secret.write_text("SENTINEL")

        response = client.get("/%2e%2e/secret.css")

        assert response.status_code == 404
        assert "SENTINEL" not in response.text


class TestSpaWithoutABuiltClient:
    def test_404s_rather_than_trying_to_serve_a_missing_index_html(
        self, settings: Settings, tmp_path: Path
    ) -> None:
        unbuilt = settings.model_copy(update={"client_dist": str(tmp_path / "does-not-exist")})
        client = TestClient(create_app(unbuilt))

        response = client.get("/")

        assert response.status_code == 404
        assert response.json()["error"]["code"] == "not_found"

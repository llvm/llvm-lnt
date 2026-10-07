from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from lnt_v5.app import create_app
from lnt_v5.config import Settings
from lnt_v5.spa import canonical_server_path, is_api_path, is_static_asset_path

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
        response = client.head(url)

        assert response.status_code == 200
        assert response.headers["cache-control"] == "no-cache, max-age=0"

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
        # Starlette's StaticFiles answers these with 405, which I4 gives to the API alone.
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
        # A missing file gets I9's header, not AR2's: it may exist after the next deploy.
        assert response.headers["cache-control"] == "no-cache, max-age=0"

    def test_a_miss_names_what_was_requested(self, client: TestClient) -> None:
        # StaticFiles raises its own 404 with a bare "Not Found" detail, which says nothing about
        # the request. The exact wording is I4-unstable, so this pins the content, not the prose.
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


class TestSpaCacheControl:
    """AR2: hashed assets are cached forever, and everything else is revalidated on every use."""

    @pytest.mark.parametrize("url", ["/", "/index.html", "/real.css", "/assets/"])
    def test_revalidates_the_shell_and_unhashed_files(self, client: TestClient, url: str) -> None:
        # `/assets/` is answered with index.html, which must not get the hashed assets' header just
        # because of its URL.
        response = client.get(url)

        assert response.status_code == 200
        assert response.headers["cache-control"] == "no-cache, max-age=0"

    @pytest.mark.parametrize(
        ("url", "expected"),
        [
            ("/suites/nts/runs/abc", "no-cache, max-age=0"),
            ("/assets/index-DcWSbQGc.js", "public, max-age=31536000, immutable"),
        ],
    )
    def test_a_file_and_its_revalidation_carry_the_header(
        self, client: TestClient, url: str, expected: str
    ) -> None:
        # Browsers get a 304 on almost every load of the shell, and RFC 9110 says it repeats the
        # 200's Cache-Control.
        first = client.get(url)
        revalidated = client.get(url, headers={"If-None-Match": first.headers["etag"]})

        assert first.status_code == 200
        assert first.headers["cache-control"] == expected
        assert revalidated.status_code == 304
        assert revalidated.headers["cache-control"] == expected


class TestCanonicalServerPath:
    @pytest.mark.parametrize(
        ("path", "canonical"),
        [
            ("/api/", "/api"),
            ("/api//", "/api"),
            ("/api/suites/", "/api/suites"),
            ("/api/admin/api-keys/", "/api/admin/api-keys"),
            ("/api/openapi.json/", "/api/openapi.json"),
            ("/healthz/", "/healthz"),
            ("/llms.txt/", "/llms.txt"),
        ],
    )
    def test_strips_a_trailing_slash_from_a_server_path(self, path: str, canonical: str) -> None:
        assert canonical_server_path(path) == canonical

    @pytest.mark.parametrize(
        "path",
        [
            "/api",  # already canonical
            "/healthz",
            "/llms.txt",
            "/",  # the client's own root, not a stray slash
            "//",
            "/suites/nts/",  # a client route: the SPA answers both forms itself
            "/graph/",
            "/apiary/",  # not the API despite the prefix
        ],
    )
    def test_leaves_everything_else_alone(self, path: str) -> None:
        assert canonical_server_path(path) is None


class TestRedirectTrailingSlash:
    @pytest.mark.parametrize(
        "path", ["/api/", "/api/admin/api-keys/", "/api/docs/", "/api/openapi.json/", "/llms.txt/"]
    )
    def test_sends_a_server_path_to_its_canonical_form(self, client: TestClient, path: str) -> None:
        response = client.get(path, follow_redirects=False)

        assert response.status_code == 307
        assert response.headers["location"] == path.rstrip("/")

    def test_names_neither_a_scheme_nor_a_host(self, client: TestClient) -> None:
        # Behind the TLS-terminating proxy the request reaches the server as plain http, and the
        # Host header is the client's to choose: neither belongs in the target (I1).
        response = client.get(
            "https://lnt.example/api/suites/",
            headers={"Host": "evil.example"},
            follow_redirects=False,
        )

        assert response.headers["location"] == "/api/suites"

    def test_redirects_a_path_that_exists_under_neither_spelling(self, client: TestClient) -> None:
        # Purely syntactic, so a miss costs one extra round trip before its 404 rather than
        # requiring the middleware to consult the route table.
        assert client.get("/api/nope/", follow_redirects=False).status_code == 307
        assert client.get("/api/nope/").status_code == 404

    @pytest.mark.parametrize(
        ("path", "location"),
        [
            ("/api/?limit=25", "/api?limit=25"),
            # Passed through as it was encoded: `%26` is a literal `&` inside a value rather than
            # a separator, and `%FF` is not UTF-8 at all.
            ("/api/?q=a%26b&r=%FF", "/api?q=a%26b&r=%FF"),
        ],
    )
    def test_keeps_the_query_string(self, client: TestClient, path: str, location: str) -> None:
        response = client.get(path, follow_redirects=False)

        assert response.headers["location"] == location

    @pytest.mark.parametrize(
        "segment",
        [
            "a%23b",  # left bare, `#` would start a fragment and cut the name short
            "a%3Fb",  # ... and `?` a query string
            "a%25b",  # ... and `%` an escape that is not one
            "caf%C3%A9",
        ],
    )
    def test_keeps_a_segment_encoded(self, client: TestClient, segment: str) -> None:
        # I1 allows all of these in a machine name or a commit value.
        response = client.get(f"/api/suites/nts/machines/{segment}/", follow_redirects=False)

        assert response.headers["location"] == f"/api/suites/nts/machines/{segment}"

    def test_does_not_redirect_an_encoded_slash_to_itself(self, client: TestClient) -> None:
        # `%2F` is decoded before routing, so this does end in a slash -- but only once decoded,
        # and a target built from the raw path would be the very URL requested.
        response = client.get("/api/suites/x%2F", follow_redirects=False)

        assert response.headers["location"] == "/api/suites/x"

    @pytest.mark.parametrize("path", ["/api/admin/api-keys/", "/api/suites/"])
    def test_preserves_the_method_and_body(self, client: TestClient, path: str) -> None:
        # 307 rather than 301 or 308, so a misspelled write arrives intact rather than as a GET.
        response = client.post(path, json={"name": "x"}, follow_redirects=False)

        assert response.status_code == 307
        assert response.headers["location"] == path.rstrip("/")

    @pytest.mark.parametrize("path", ["/api/suites/", "/api/suites/nts/"])
    def test_redirects_a_suite_path_to_its_canonical_form(
        self, client: TestClient, path: str
    ) -> None:
        # The paths a client is most likely to spell with a trailing slash, now that they exist.
        response = client.get(path, follow_redirects=False)

        assert response.status_code == 307
        assert response.headers["location"] == path.rstrip("/")

    def test_does_not_let_the_health_probe_be_answered_by_the_spa(self, client: TestClient) -> None:
        # Without this, `/healthz/` falls through to the catch-all and answers 200 with the client
        # shell -- reporting a healthy server whether or not the database is reachable.
        response = client.get("/healthz/", follow_redirects=False)

        assert response.status_code == 307
        assert response.headers["location"] == "/healthz"

    @pytest.mark.parametrize("path", ["/", "/suites/nts/", "/graph/"])
    def test_leaves_client_routes_alone(self, client: TestClient, path: str) -> None:
        # The SPA answers both spellings, so bouncing the browser between them would be noise.
        response = client.get(path, follow_redirects=False)

        assert response.status_code == 200
        assert "<title>LNT</title>" in response.text


class TestRejectNulInUrl:
    """D5, at the edge: a URL carrying a NUL is refused before anything routes it.

    A NUL reaches no column the API can compare it against -- PostgreSQL refuses it even as a
    query parameter -- so a request carrying one in a path segment or a filter would otherwise be
    an unattributable 500 for something the caller supplied. Refusing the URL whole is what keeps
    that from having to be remembered for each path segment and each filter; the cases below are
    one of each rather than an enumeration, since none of them reaches its endpoint.
    """

    @pytest.mark.parametrize(
        ("path", "why"),
        [
            ("/api/suites/nosuch/commits/a%00b", "a path segment"),
            ("/api/suites/nosuch/commits?search=a%00b", "a query filter"),
            ("/api/suites/nosuch/machines/a%00b", "a path segment on a route already on main"),
            ("/api/admin/api-keys/a%00b", "a path segment on an admin-scoped route"),
            ("/healthz%00", "a route outside the REST API"),
            ("/suites/a%00b", "a client route"),
        ],
    )
    def test_refuses_a_url_carrying_one(self, client: TestClient, path: str, why: str) -> None:
        response = client.get(path)

        assert response.status_code == 400, why
        assert response.json()["error"]["code"] == "invalid_request"

    def test_refuses_it_before_authentication(self, client: TestClient) -> None:
        # The one thing here that is not simply "a 400 instead of a 500": this sits with the
        # oversized body and the trailing-slash redirect, ahead of I5's order of checks, so an
        # admin-scoped route answers it without a credential. It names no resource, so the reason
        # I5 puts authorization first does not apply.
        response = client.delete("/api/admin/api-keys/a%00b")

        assert response.status_code == 400

    def test_leaves_an_ordinary_url_alone(self, client: TestClient) -> None:
        assert client.get("/llms.txt").status_code == 200
        assert client.get("/suites/nts?search=abc").status_code == 200


class TestSpaWithoutABuiltClient:
    def test_404s_rather_than_trying_to_serve_a_missing_index_html(
        self, settings: Settings, tmp_path: Path
    ) -> None:
        unbuilt = settings.model_copy(update={"client_dist": str(tmp_path / "does-not-exist")})
        client = TestClient(create_app(unbuilt))

        response = client.get("/")

        assert response.status_code == 404
        assert response.json()["error"]["code"] == "not_found"

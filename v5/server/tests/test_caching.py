"""I9: every response gets the caching headers its request calls for.

Expected values are written out from the spec rather than taken from the constants, and compared
whole: a header added twice comes back joined with a comma, and fails the comparison.
"""

from __future__ import annotations

from collections.abc import Callable

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from httpx2 import Response

from lnt_v5.app import create_app
from lnt_v5.config import Settings
from lnt_v5.scopes import Scope

REVALIDATE = "no-cache, max-age=0"
PRIVATE = "private, no-store"

# Not a valid token of any kind, but still a credential in the request, which is all I9 looks at.
SOME_CREDENTIAL = {"Authorization": "Basic zzz"}

# Each request without and with a credential, with the header each one should get.
EITHER_REQUEST = pytest.mark.parametrize(
    ("headers", "cache_control"),
    [({}, REVALIDATE), (SOME_CREDENTIAL, PRIVATE)],
    ids=["anonymous", "credential"],
)


def assert_cache_headers(response: Response, cache_control: str) -> None:
    assert response.headers["cache-control"] == cache_control
    assert response.headers["vary"] == "Authorization"


class TestWithoutTheDatabase:
    # One of each kind of response that no endpoint body produces: a miss, a method mismatch, the
    # redirect and the NUL rejection handled before any endpoint, misses in the web UI, and the
    # routes I5 exempts (where an `Authorization` header changes nothing else). Each row also checks
    # the status, so that a row now answered by something else fails instead of passing by accident.
    @EITHER_REQUEST
    @pytest.mark.parametrize(
        ("method", "path", "status"),
        [
            ("GET", "/api/nope", 404),
            ("PUT", "/api/suites", 405),
            ("GET", "/api/", 307),
            ("GET", "/api/suites/x/commits/a%00b", 400),
            ("GET", "/favicon.ico", 404),
            # AR2: a missing asset may exist after the next deploy, so it is not cached forever.
            ("GET", "/assets/index-STALEHASH.js", 404),
            ("GET", "/llms.txt", 200),
            ("GET", "/api/openapi.json", 200),
            ("GET", "/api/docs", 200),
        ],
    )
    def test_a_response_gets_headers_from_its_request(
        self,
        client: TestClient,
        method: str,
        path: str,
        status: int,
        headers: dict[str, str],
        cache_control: str,
    ) -> None:
        response = client.request(method, path, headers=headers, follow_redirects=False)

        assert response.status_code == status
        assert_cache_headers(response, cache_control)

    @EITHER_REQUEST
    def test_an_oversized_body_gets_headers(
        self, settings: Settings, headers: dict[str, str], cache_control: str
    ) -> None:
        # Rejected by middleware before any endpoint, in plain text rather than the envelope.
        client = TestClient(create_app(settings.model_copy(update={"body_limit": 10})))

        response = client.post("/api/anything", content=b"x" * 100, headers=headers)

        assert response.status_code == 413
        assert_cache_headers(response, cache_control)

    @EITHER_REQUEST
    def test_an_unhandled_exception_gets_headers(
        self, app: FastAPI, headers: dict[str, str], cache_control: str
    ) -> None:
        # Sent from the outermost layer of the stack, outside all middleware. Without the lifespan
        # there is no engine, so the first endpoint that needs one fails with an unhandled error.
        client = TestClient(app, raise_server_exceptions=False)

        response = client.get("/api/suites", headers=headers)

        assert response.status_code == 500
        assert_cache_headers(response, cache_control)

    @pytest.mark.parametrize(
        ("path", "cache_control"),
        [("/", REVALIDATE), ("/assets/index-DcWSbQGc.js", "public, max-age=31536000, immutable")],
    )
    def test_the_web_ui_keeps_its_own_headers(
        self, client: TestClient, path: str, cache_control: str
    ) -> None:
        # AR2's headers, whatever the request carries: none of these files depends on a credential.
        response = client.get(path, headers=SOME_CREDENTIAL)

        assert response.status_code == 200
        assert response.headers["cache-control"] == cache_control
        assert "vary" not in response.headers


def test_the_key_a_request_authenticated_with_is_private(
    api_client: TestClient,
    make_key: Callable[..., str],
    bearer: Callable[[str], dict[str, str]],
) -> None:
    # The case I9's rule exists for: a response whose body depends on the credential. The anonymous
    # response is revalidated instead, so that a cache checks with the server before reusing it,
    # and the server answers any request with a token itself.
    anonymous = api_client.get("/api/auth")
    keyed = api_client.get("/api/auth", headers=bearer(make_key(Scope.READ)))

    assert anonymous.json() == {"key": None}
    assert_cache_headers(anonymous, REVALIDATE)
    assert keyed.json()["key"] is not None
    assert_cache_headers(keyed, PRIVATE)


def test_a_token_that_does_not_authenticate_is_private(
    api_client: TestClient, bearer: Callable[[str], dict[str, str]]
) -> None:
    # A well-formed token that belongs to no key gets I5's 401, like a revoked one. A cache must
    # never give this response to an anonymous request.
    response = api_client.get("/api", headers=bearer("f" * 64))

    assert response.status_code == 401
    assert_cache_headers(response, PRIVATE)

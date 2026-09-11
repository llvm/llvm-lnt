from __future__ import annotations

import json

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from pydantic import BaseModel

from lnt_v5.app import create_app
from lnt_v5.config import Settings
from lnt_v5.errors import ErrorCode, error_response, register_error_handlers

# The statuses R4 permits a REST API response to carry.
R4_STATUSES = {200, 201, 204, 400, 401, 403, 404, 409, 500}


class Body(BaseModel):
    count: int


@pytest.fixture
def handlers_client() -> TestClient:
    """A minimal app exercising the handlers in isolation from the SPA mount."""
    app = FastAPI()
    register_error_handlers(app)

    @app.get("/boom")
    def boom() -> None:
        raise RuntimeError("something went wrong internally")

    @app.get("/missing")
    def missing() -> None:
        raise HTTPException(status_code=404, detail="Machine 'foo' not found")

    @app.post("/too-large")
    def too_large() -> None:
        # What RequestBodyLimitMiddleware raises when it cannot pre-empt the response, i.e. when
        # the request carried no Content-Length. Raised directly here so the handler's branch can
        # be tested without driving raw ASGI.
        raise HTTPException(status_code=413, detail="Content Too Large")

    @app.post("/validated")
    def validated(body: Body) -> dict[str, int]:
        return {"count": body.count}

    # raise_server_exceptions=False: TestClient otherwise re-raises the original exception rather
    # than letting the registered handler produce a response.
    return TestClient(app, raise_server_exceptions=False)


class TestErrorCodes:
    @pytest.mark.parametrize("code", list(ErrorCode))
    def test_every_code_is_served_with_a_status_r4_permits(self, code: ErrorCode) -> None:
        assert error_response(code, "message").status_code in R4_STATUSES

    @pytest.mark.parametrize(
        "code", [ErrorCode.DUPLICATE, ErrorCode.ORDINAL_CONFLICT, ErrorCode.IN_USE]
    )
    def test_the_409_family_stays_distinguishable(self, code: ErrorCode) -> None:
        # The point of the code/status split: R4 serves four codes as 409, and choosing 409 must
        # not flatten them to `conflict`.
        response = error_response(code, "nope")

        assert response.status_code == 409
        assert json.loads(bytes(response.body))["error"]["code"] == code.value


def test_http_exceptions_use_the_error_envelope(handlers_client: TestClient) -> None:
    response = handlers_client.get("/missing")

    assert response.status_code == 404
    assert response.json()["error"]["code"] == "not_found"
    assert response.json()["error"]["message"] == "Machine 'foo' not found"


def test_a_method_mismatch_becomes_404_rather_than_405(handlers_client: TestClient) -> None:
    # R4 permits 200, 201, 204, 400, 401, 403, 404, 409 and 500. Starlette's default 405 is not
    # in that set.
    response = handlers_client.post("/missing")

    assert response.status_code == 404
    assert response.json()["error"]["code"] == "not_found"


def test_request_validation_becomes_400_rather_than_422(handlers_client: TestClient) -> None:
    response = handlers_client.post("/validated", json={"count": "not-a-number"})

    assert response.status_code == 400
    assert response.json()["error"]["code"] == "invalid_request"


def test_an_unhandled_exception_becomes_500_without_leaking_a_traceback(
    handlers_client: TestClient,
) -> None:
    response = handlers_client.get("/boom")

    assert response.status_code == 500
    assert response.json()["error"]["code"] == "internal_error"
    assert "RuntimeError" not in response.text
    assert "something went wrong internally" not in response.text


def test_an_oversized_body_stays_plain_text_outside_the_envelope(
    handlers_client: TestClient,
) -> None:
    # R4 places an oversized body at the transport layer, outside the REST API surface, so this
    # is deliberately not the error envelope. It has to match what starlette itself emits on the
    # Content-Length path (asserted in TestApplicationWiring below), since a client cannot tell
    # which of the two rejected it.
    response = handlers_client.post("/too-large")

    assert response.status_code == 413
    assert response.headers["content-type"].startswith("text/plain")
    assert response.text == "Content Too Large"
    assert "error" not in response.text


class TestApplicationWiring:
    """Assertions that only hold for the fully assembled create_app()."""

    def test_an_oversized_body_is_rejected(self, settings: Settings) -> None:
        # TestClient always sets Content-Length, which is the path production takes too: the
        # reverse proxy buffers the request before forwarding it. Starlette answers this one
        # itself, in plain text, overwriting whatever the app produced.
        settings = settings.model_copy(update={"body_limit": 10})
        client = TestClient(create_app(settings))

        response = client.post("/api/anything", content=b"x" * 100)

        assert response.status_code == 413
        assert response.headers["content-type"].startswith("text/plain")
        assert response.text == "Content Too Large"

    @pytest.mark.parametrize("path", ["/docs", "/redoc", "/openapi.json"])
    def test_fastapis_default_documentation_paths_are_not_used(
        self, client: TestClient, path: str
    ) -> None:
        # R8 moves these under /api. Left at the defaults they would sit in the SPA's namespace:
        # the two HTML ones fall through to the client, and .json reads as a missing asset.
        response = client.get(path)

        if path.endswith(".json"):
            assert response.status_code == 404
        else:
            assert "<title>LNT</title>" in response.text

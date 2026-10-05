"""The I4 JSON error envelope, and the handlers that make the framework produce it.

FastAPI's defaults do not match I4: HTTPException renders `{"detail": ...}`, request validation
fails with 422, and an unhandled exception returns a plain-text body. 422 is not a status I4
permits, so these handlers are what keep the API inside its specified surface.

They are registered app-wide rather than under `/api/`, so a miss on a client path answers with
the envelope too. The one deliberate hole is an oversized request body, which I4 places at the
transport layer and outside the envelope; see `_http_exception_handler`.
"""

from __future__ import annotations

import logging
from collections.abc import Mapping
from enum import StrEnum
from typing import Any

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, PlainTextResponse, Response
from pydantic import BaseModel, ValidationError
from starlette.exceptions import HTTPException as StarletteHTTPException

logger = logging.getLogger(__name__)


class ErrorCode(StrEnum):
    """I4's machine-readable error codes; see infrastructure.md for what each one means.

    Callers name a code and the status follows from it, never the other way round: the relation
    is not invertible, since I4 serves three distinct codes as 409.
    """

    INVALID_REQUEST = "invalid_request"
    UNAUTHORIZED = "unauthorized"
    FORBIDDEN = "forbidden"
    NOT_FOUND = "not_found"
    METHOD_NOT_ALLOWED = "method_not_allowed"
    DUPLICATE = "duplicate"
    CONFLICT = "conflict"
    RETRY = "retry"
    INTERNAL_ERROR = "internal_error"


# The status I4 serves each code with.
_STATUS: dict[ErrorCode, int] = {
    ErrorCode.INVALID_REQUEST: 400,
    ErrorCode.UNAUTHORIZED: 401,
    ErrorCode.FORBIDDEN: 403,
    ErrorCode.NOT_FOUND: 404,
    ErrorCode.METHOD_NOT_ALLOWED: 405,
    ErrorCode.DUPLICATE: 409,
    ErrorCode.CONFLICT: 409,
    ErrorCode.RETRY: 409,
    ErrorCode.INTERNAL_ERROR: 500,
}


def error_response(
    code: ErrorCode, message: str, headers: Mapping[str, str] | None = None
) -> JSONResponse:
    return JSONResponse(
        status_code=_STATUS[code],
        content={"error": {"code": code.value, "message": message}},
        headers=dict(headers) if headers else None,
    )


class ErrorBody(BaseModel):
    """An error's machine-readable code and human-readable message."""

    # Deliberately a plain string rather than ErrorCode: this one schema describes every error
    # response, and enumerating every code on it would claim a 401 might carry `duplicate`.
    code: str
    message: str


class ErrorEnvelope(BaseModel):
    """The body of every error response.

    Branch on `code`, which is stable. `message` is for humans and may be reworded at any time.
    """

    error: ErrorBody


class ApiError(Exception):
    """An error an endpoint reports by naming its I4 code.

    The code is what a client branches on, and it does not follow from the status: I4 serves three
    distinct codes as 409. So a caller names the code and the status follows, which is why this
    exists rather than endpoints raising HTTPException with a status the handler would have to
    guess a code from.

    `headers` carries anything the response must include beside the envelope -- today only I5's
    `WWW-Authenticate: Bearer` on a 401.
    """

    def __init__(
        self, code: ErrorCode, message: str, headers: Mapping[str, str] | None = None
    ) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.headers = dict(headers) if headers else None


def validation_problems(error: ValidationError | RequestValidationError) -> str:
    """Where validation failed and why, as one line.

    Location and reason only. Pydantic's raw `errors()` carries an `input` key holding the entire
    rejected value, so echoing it would turn one malformed run submission -- which legitimately
    carries tens of megabytes of base64 profile -- into an equally large error response.

    Shared by the handler below, which catches what the framework validates, and by code that
    validates something itself and has to translate the failure where it raises it. Two spellings
    would drift, and only one of them would carry the reason `input` is left out. The two exception
    types are unrelated by inheritance but agree on `errors()`, which is all this reads.

    A failure at the root of what was validated has no location -- validating a bare value through
    a `TypeAdapter` produces one -- so the reason is given on its own rather than after an empty
    prefix and a stray colon.
    """

    def described(problem: Mapping[str, Any]) -> str:
        location = ".".join(str(part) for part in problem["loc"])
        return f"{location}: {problem['msg']}" if location else str(problem["msg"])

    return "; ".join(described(problem) for problem in error.errors())


async def _api_error_handler(request: Request, exc: Exception) -> Response:
    assert isinstance(exc, ApiError)
    return error_response(exc.code, exc.message, headers=exc.headers)


async def _http_exception_handler(request: Request, exc: Exception) -> Response:
    assert isinstance(exc, StarletteHTTPException)

    # An oversized body is rejected at the transport layer, before the request is part of the
    # REST API surface at all, so I4 leaves it plain text and outside the envelope. Starlette's
    # RequestBodyLimitMiddleware (installed in app.py) already answers exactly this way when a
    # Content-Length is present -- which is every request in production, since the reverse proxy
    # buffers. Without one it cannot pre-empt the response and the rejection arrives here
    # instead; matching its wording keeps the two paths indistinguishable to a client.
    if exc.status_code == 413:
        return PlainTextResponse("Content Too Large", status_code=413)

    # 404s reach here already worded, because spa.py replaces StaticFiles' bare "Not Found".
    if exc.status_code == 404:
        return error_response(ErrorCode.NOT_FOUND, str(exc.detail))

    # FastAPI's own answer to a body it could not read at all, such as JSON that is not UTF-8.
    if exc.status_code == 400:
        return error_response(ErrorCode.INVALID_REQUEST, str(exc.detail))

    # Under the SPA mount a method mismatch is spa.py's, raised as an `ApiError`, and this never
    # fires. Without that mount -- or under a future sub-mount -- Starlette raises its own 405,
    # carrying `Allow`.
    if exc.status_code == 405:
        return error_response(
            ErrorCode.METHOD_NOT_ALLOWED,
            f"{request.method} is not allowed on {request.url.path}",
            headers=exc.headers,
        )

    # Nothing else is expected. An endpoint that needs a specific code raises `ApiError` rather than
    # a status this would have to guess a code from -- guessing cannot tell `duplicate` from
    # `conflict`. Answer inside I4's surface and log.
    logger.warning("Unexpected HTTPException with status %d; answering 500", exc.status_code)
    return error_response(ErrorCode.INTERNAL_ERROR, "The server failed to answer this request")


async def _validation_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    assert isinstance(exc, RequestValidationError)
    return error_response(
        ErrorCode.INVALID_REQUEST, f"Request validation failed: {validation_problems(exc)}"
    )


async def _unhandled_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    # Deliberately unconditional: there is no development/production switch, so an internal error
    # never reveals a traceback to the caller. The traceback reaches the logs via Starlette's
    # ServerErrorMiddleware, which re-raises after this runs.
    return error_response(ErrorCode.INTERNAL_ERROR, "The server failed to answer this request")


def register_error_handlers(app: FastAPI) -> None:
    app.add_exception_handler(ApiError, _api_error_handler)
    app.add_exception_handler(StarletteHTTPException, _http_exception_handler)
    app.add_exception_handler(RequestValidationError, _validation_exception_handler)
    app.add_exception_handler(Exception, _unhandled_exception_handler)

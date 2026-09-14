"""The R4 JSON error envelope, and the handlers that make the framework produce it.

FastAPI's defaults do not match R4: HTTPException renders `{"detail": ...}`, request validation
fails with 422, an unmatched method on a declared route gives 405, and an unhandled exception
returns a plain-text body. Neither 422 nor 405 is a status R4 permits, so these handlers are what
keep the API inside its specified surface.

They are registered app-wide rather than under `/api/`, so a miss on a client path answers with
the envelope too. The one deliberate hole is an oversized request body, which R4 places at the
transport layer and outside the envelope; see `_http_exception_handler`.
"""

from __future__ import annotations

import logging
from collections.abc import Mapping
from enum import StrEnum

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, PlainTextResponse, Response
from pydantic import BaseModel
from starlette.exceptions import HTTPException as StarletteHTTPException

logger = logging.getLogger(__name__)


class ErrorCode(StrEnum):
    """R4's machine-readable error codes; see infrastructure.md for what each one means.

    Callers name a code and the status follows from it, never the other way round: the relation
    is not invertible, since R4 serves four distinct codes as 409.
    """

    INVALID_REQUEST = "invalid_request"
    UNAUTHORIZED = "unauthorized"
    FORBIDDEN = "forbidden"
    NOT_FOUND = "not_found"
    DUPLICATE = "duplicate"
    ORDINAL_CONFLICT = "ordinal_conflict"
    IN_USE = "in_use"
    CONFLICT = "conflict"
    INTERNAL_ERROR = "internal_error"


# The status R4 serves each code with.
_STATUS: dict[ErrorCode, int] = {
    ErrorCode.INVALID_REQUEST: 400,
    ErrorCode.UNAUTHORIZED: 401,
    ErrorCode.FORBIDDEN: 403,
    ErrorCode.NOT_FOUND: 404,
    ErrorCode.DUPLICATE: 409,
    ErrorCode.ORDINAL_CONFLICT: 409,
    ErrorCode.IN_USE: 409,
    ErrorCode.CONFLICT: 409,
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
    # response, and enumerating all nine codes on it would claim a 401 might carry `duplicate`.
    code: str
    message: str


class ErrorEnvelope(BaseModel):
    """The body of every error response.

    Branch on `code`, which is stable. `message` is for humans and may be reworded at any time.
    """

    error: ErrorBody


class ApiError(Exception):
    """An error an endpoint reports by naming its R4 code.

    The code is what a client branches on, and it does not follow from the status: R4 serves four
    distinct codes as 409. So a caller names the code and the status follows, which is why this
    exists rather than endpoints raising HTTPException with a status the handler would have to
    guess a code from.

    `headers` carries anything the response must include beside the envelope -- today only R5's
    `WWW-Authenticate: Bearer` on a 401.
    """

    def __init__(
        self, code: ErrorCode, message: str, headers: Mapping[str, str] | None = None
    ) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.headers = dict(headers) if headers else None


def no_route(method: str | None, path: str) -> str:
    """The message for a request that matched nothing. Shared so the wording has one source."""
    return f"No route for {method} {path}"


async def _api_error_handler(request: Request, exc: Exception) -> Response:
    assert isinstance(exc, ApiError)
    return error_response(exc.code, exc.message, headers=exc.headers)


async def _http_exception_handler(request: Request, exc: Exception) -> Response:
    assert isinstance(exc, StarletteHTTPException)

    # An oversized body is rejected at the transport layer, before the request is part of the
    # REST API surface at all, so R4 leaves it plain text and outside the envelope. Starlette's
    # RequestBodyLimitMiddleware (installed in app.py) already answers exactly this way when a
    # Content-Length is present -- which is every request in production, since the reverse proxy
    # buffers. Without one it cannot pre-empt the response and the rejection arrives here
    # instead; matching its wording keeps the two paths indistinguishable to a client.
    if exc.status_code == 413:
        return PlainTextResponse("Content Too Large", status_code=413)

    # Starlette raises a bare 405 when a path matches but the method does not. R4 has no 405, so
    # it collapses to "nothing here".
    if exc.status_code == 405:
        return error_response(ErrorCode.NOT_FOUND, no_route(request.method, request.url.path))

    # 404s reach here already worded, because spa.py replaces StaticFiles' bare "Not Found".
    if exc.status_code == 404:
        return error_response(ErrorCode.NOT_FOUND, str(exc.detail))

    # Nothing else raises HTTPException today. An endpoint that needs to report a specific code
    # should gain an exception type carrying one, rather than a status this would have to guess a
    # code from -- guessing cannot tell `duplicate` from `ordinal_conflict`, which is the whole
    # reason R4 splits them. Until then, answer inside R4's surface and say so in the log.
    logger.warning("Unexpected HTTPException with status %d; answering 500", exc.status_code)
    return error_response(ErrorCode.INTERNAL_ERROR, "The server failed to answer this request")


async def _validation_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    assert isinstance(exc, RequestValidationError)
    # Location and reason only. Pydantic's raw errors() carries an `input` key holding the entire
    # rejected value, so echoing it would turn one malformed run submission -- which legitimately
    # carries tens of megabytes of base64 profile -- into an equally large error response.
    problems = "; ".join(
        f"{'.'.join(str(part) for part in error['loc'])}: {error['msg']}" for error in exc.errors()
    )
    return error_response(ErrorCode.INVALID_REQUEST, f"Request validation failed: {problems}")


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

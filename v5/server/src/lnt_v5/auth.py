"""Authentication and authorization (R5).

An endpoint declares the scope it requires, and everything else follows from that: whether an
anonymous caller is allowed, which failures are a 400 rather than a 401, and what R8's document
says the operation can answer.

Order of checks matters and is guaranteed structurally. R5 requires authentication before
authorization before resolving the addressed resource, so that an under-scoped caller cannot
learn which resources exist by reading a 404. FastAPI runs a route's dependencies before its body,
so an endpoint that resolves what it addresses *in its body* gets that order for free. An endpoint
that instead resolves through a dependency of its own must make that dependency depend on this
one, or it will resolve first and answer 404 where R5 requires 403.
"""

from __future__ import annotations

import logging
from collections.abc import Iterator, Sequence
from typing import Annotated, Any

from fastapi import Depends, Request
from fastapi.openapi.models import HTTPBearer as HTTPBearerModel
from fastapi.routing import RouteContext, iter_route_contexts
from fastapi.security.base import SecurityBase
from fastapi.security.utils import get_authorization_scheme_param
from starlette.routing import BaseRoute

from . import keys
from .db import EngineDep
from .errors import ApiError, ErrorCode
from .keys import ResolvedKey
from .scopes import Scope

logger = logging.getLogger(__name__)

# R5: every 401 tells the caller which scheme it should have used.
UNAUTHENTICATED_HEADERS = {"WWW-Authenticate": "Bearer"}


class BearerToken(SecurityBase):
    """R5's `Authorization: Bearer <token>`, reduced to the token or to nothing.

    FastAPI's own `HTTPBearer` does not fit either way round. With `auto_error` it raises a 403,
    which is not what R5 specifies for any of these cases. With `auto_error=False` it answers
    `None` to a missing header, a non-Bearer scheme and an empty credential alike -- and R5 keeps
    the first apart from the other two, because falling through to anonymous access would silently
    ignore a credential the caller believes it sent.

    It is therefore not subclassed but replaced, reusing only its OpenAPI model: that is what
    declares the scheme in R8's document and gives the viewer its Authorize button.
    """

    def __init__(self) -> None:
        self.model = HTTPBearerModel(
            description="An LNT API key: 64 lowercase hexadecimal characters (see R5)."
        )
        self.scheme_name = "ApiKey"

    async def __call__(self, request: Request) -> str | None:
        header = request.headers.get("Authorization")
        if header is None:
            return None

        scheme, credentials = get_authorization_scheme_param(header)
        # The scheme is matched case-insensitively, per RFC 9110. An empty credential is a syntax
        # error rather than a token that failed to resolve: RFC 6750's grammar requires at least
        # one character, so there is no token there to call malformed.
        if scheme.lower() != "bearer" or not credentials:
            raise ApiError(
                ErrorCode.INVALID_REQUEST,
                "The Authorization header must carry a Bearer credential.",
            )
        return credentials


_bearer_token = BearerToken()

TokenDep = Annotated[str | None, Depends(_bearer_token)]


class RequireScope:
    """The scope an endpoint requires, as a dependency.

    A class rather than a closure so that the requirement can be read back off a route:
    :func:`required_scope` recovers it, which is how R8's document learns each operation's auth
    failures and how the route-coverage test notices an endpoint shipping without a scope.

    Returns the authenticated key, or None for an allowed anonymous caller, so an endpoint that
    needs to know who is calling can depend on this directly rather than resolve the token twice.
    """

    def __init__(self, scope: Scope) -> None:
        self.scope = scope

    def __call__(self, engine: EngineDep, token: TokenDep) -> ResolvedKey | None:
        if token is None:
            # R5: read-scoped endpoints allow unauthenticated access, anything above does not.
            if self.scope is Scope.READ:
                return None
            raise ApiError(
                ErrorCode.UNAUTHORIZED,
                "This endpoint requires an API key.",
                headers=UNAUTHENTICATED_HEADERS,
            )

        # R5 resolves the token on every request rather than caching the decision, so that
        # revoking a key takes effect immediately.
        with engine.connect() as connection:
            key = keys.resolve_token(connection, token)

        if key is None or not key.is_active:
            # A bad credential is never quietly downgraded to anonymous access, even on an
            # endpoint that would have allowed it -- that would turn a broken or revoked token
            # into results the caller misreads as authoritative.
            #
            # The prefix is logged only for a key we recognise: for one we do not, the only
            # "prefix" available is eight characters of whatever the caller sent.
            if key is not None:
                logger.info("Rejected API key %s: revoked", key.prefix)
            else:
                logger.info("Rejected an API key: unknown, or not the shape a token has")
            raise ApiError(
                ErrorCode.UNAUTHORIZED,
                "This API key is unknown or has been revoked.",
                headers=UNAUTHENTICATED_HEADERS,
            )

        # D5 records use on successful *authentication*, so this happens before the scope check:
        # a key turned away by authorization was still presented and still resolved.
        keys.touch_last_used(engine, key.id)

        if not key.scope.grants(self.scope):
            raise ApiError(
                ErrorCode.FORBIDDEN,
                f"This endpoint requires the '{self.scope.value}' scope, "
                f"and this API key grants '{key.scope.value}'.",
            )

        return key


def require_scope(scope: Scope) -> Any:
    """Declare the scope an endpoint requires, for its `dependencies=[...]`.

    Returns `Any` because that is how FastAPI types `Depends` -- it has to be assignable to a
    parameter of any annotated type.
    """
    return Depends(RequireScope(scope))


def iter_routes(routes: Sequence[BaseRoute]) -> Iterator[RouteContext]:
    """Every route the app can serve, each with the path it is actually served at.

    `app.routes` is not a flat list of endpoints: FastAPI keeps an included router as a single
    entry and resolves its routes' effective paths lazily, so a scan that iterates it directly
    finds no endpoints at all. This is the traversal FastAPI's own document generator uses, which
    is also what makes `path_format` here the key that document is written under.
    """
    return iter_route_contexts(routes)


def required_scope(route: RouteContext) -> Scope | None:
    """The scope a route requires, or None if it declares none (or is not an endpoint).

    Walks the whole dependency tree rather than only its top level, so that a scope declared
    through a dependency of a dependency is still found -- a guard that reports "unprotected"
    for a route that is in fact protected would train its readers to ignore it.
    """
    dependant = getattr(route, "dependant", None)
    if dependant is None:
        return None

    pending = list(dependant.dependencies)
    while pending:
        dependency = pending.pop()
        call = dependency.call
        if isinstance(call, RequireScope):
            return call.scope
        pending.extend(dependency.dependencies)
    return None

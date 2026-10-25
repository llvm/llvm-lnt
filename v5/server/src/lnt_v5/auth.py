"""Authentication and authorization (I5).

An endpoint declares the scope it requires, and everything else follows from that: whether an
anonymous caller is allowed, what I8's document says the operation can answer, and -- since the
scope is what marks an endpoint as part of the REST API surface -- that it refuses a query parameter
it does not take (I3).

Order of checks matters and is guaranteed structurally. I5 requires authentication before
authorization before resolving the addressed resource, so that an under-scoped caller cannot
learn which resources exist by reading a 404. FastAPI runs a route's dependencies before its body,
so an endpoint that resolves what it addresses *in its body* gets that order for free. An endpoint
that instead resolves through a dependency of its own must make that dependency depend on this
one, or it will resolve first and answer 404 where I5 requires 403.

A key restricted to some suites is checked against the suite the request addresses, which is read
off the route's path (see `suite_parameter`). That is only sound because of an invariant no test can
check: a request that addresses a suite writes only to that suite, never to another (I5). An
endpoint that reached into another suite would let a restricted key write where it has only
`read`.
"""

from __future__ import annotations

import logging
import re
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
from .keys import LastUseRecorder, ResolvedKey
from .querying import reject_unknown_query_parameters
from .scopes import Scope

logger = logging.getLogger(__name__)

# I5: every 401 tells the caller which scheme it should have used.
UNAUTHENTICATED_HEADERS = {"WWW-Authenticate": "Bearer"}

# What I8's document calls the scheme, and so what every operation's security requirement names.
SECURITY_SCHEME = "ApiKey"

# A path template whose first segment below the suite collection is a parameter: `{testsuite}` on
# every suite-scoped route, and `{name}` on E10's routes for one suite.
_SUITE_PATH = re.compile(r"\A/api/suites/\{(\w+)\}(/|\Z)")


def suite_parameter(path_format: str) -> str | None:
    """The path parameter naming the suite a route addresses (I5), or None if it addresses none.

    Rests on I1's layout: everything below `/api/suites/` starts with a suite name, so no route has
    a literal segment directly under it. A route that did (`/api/suites/import`, say) would not be
    seen as addressing a suite, and a restricted key would get only `read` on it.
    """
    match = _SUITE_PATH.match(path_format)
    return match.group(1) if match else None


def _addressed_suite(request: Request) -> str | None:
    """The suite a request addresses, read off the route it matched.

    `path_format` is the route's whole path only because no router is included with a prefix of
    its own (see `create_app`). The test that drives every scoped operation with a restricted key
    is what notices if that changes.
    """
    route = request.scope.get("route")
    parameter = suite_parameter(getattr(route, "path_format", ""))
    return None if parameter is None else request.path_params[parameter]


class BearerToken(SecurityBase):
    """I5's `Authorization: Bearer <token>`, reduced to the token or to nothing.

    FastAPI's own `HTTPBearer` does not fit either way round. With `auto_error` it raises a 403,
    which is not what I5 specifies for any of these cases. With `auto_error=False` it answers
    `None` to a missing header, a non-Bearer scheme and an empty credential alike -- and I5 keeps
    the first apart from the other two: they are a 401, because falling through to anonymous access
    would silently ignore a credential the caller believes it sent.

    It is therefore not subclassed but replaced, reusing only its OpenAPI model: that is what
    declares the scheme in I8's document and gives the viewer its Authorize button.
    """

    def __init__(self) -> None:
        self.model = HTTPBearerModel(
            description="An LNT API key: 64 lowercase hexadecimal characters."
        )
        self.scheme_name = SECURITY_SCHEME

    async def __call__(self, request: Request) -> str | None:
        header = request.headers.get("Authorization")
        if header is None:
            return None

        scheme, credentials = get_authorization_scheme_param(header)
        # The scheme is matched case-insensitively, per RFC 9110. Another scheme, or none at all,
        # is no credentials in RFC 6750's terms, which is a 401 -- on every endpoint, since I5
        # never lets an unusable header fall through to anonymous access.
        if scheme.lower() != "bearer" or not credentials:
            raise ApiError(
                ErrorCode.UNAUTHORIZED,
                "The Authorization header must carry a Bearer credential.",
                headers=UNAUTHENTICATED_HEADERS,
            )
        return credentials


_bearer_token = BearerToken()

TokenDep = Annotated[str | None, Depends(_bearer_token)]


def _last_use(request: Request) -> LastUseRecorder:
    """This worker's record of when it last recorded each key's use, built by `create_app`."""
    recorder: LastUseRecorder = request.app.state.last_use
    return recorder


class RequireScope:
    """The scope an endpoint requires, as a dependency.

    A class rather than a closure so that the requirement can be read back off a route:
    :func:`required_scope` recovers it, which is how I8's document learns each operation's auth
    failures and how the route-coverage test notices an endpoint shipping without a scope.

    Returns the authenticated key, or None for an allowed anonymous caller, so an endpoint that
    needs to know who is calling can depend on this directly rather than resolve the token twice.
    """

    def __init__(self, scope: Scope) -> None:
        self.scope = scope

    # Declared before the token, since dependencies are solved in order: I5 lets I3's refusal of a
    # query parameter come before authentication, and the header may itself be a 401.
    def __call__(
        self,
        request: Request,
        _query: Annotated[None, Depends(reject_unknown_query_parameters)],
        engine: EngineDep,
        last_use: Annotated[LastUseRecorder, Depends(_last_use)],
        token: TokenDep,
    ) -> ResolvedKey | None:
        if token is None:
            # I5: read-scoped endpoints allow unauthenticated access, anything above does not.
            if self.scope is Scope.READ:
                return None
            raise ApiError(
                ErrorCode.UNAUTHORIZED,
                "This endpoint requires an API key.",
                headers=UNAUTHENTICATED_HEADERS,
            )

        # I5 resolves the token on every request rather than caching the decision, so that
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
        last_use.record(engine, key.id)

        # Only a restricted key depends on the suite.
        suite = None if key.suites is None else _addressed_suite(request)
        if not key.grants(self.scope, suite):
            raise ApiError(ErrorCode.FORBIDDEN, self._refusal(key, suite))

        return key

    def _refusal(self, key: ResolvedKey, suite: str | None) -> str:
        """Why `key` is refused, on a request addressing `suite`."""
        required = self.scope.value
        if not key.scope.grants(self.scope):
            return (
                f"This endpoint requires the '{required}' scope, and this API key grants "
                f"'{key.scope.value}'."
            )
        # Refused although its scope suffices, so the key is restricted to suites other than this
        # request's.
        assert key.suites is not None
        if suite is None:
            return (
                f"This endpoint requires the '{required}' scope from an unrestricted API key, and "
                f"this one is restricted to test suites: {', '.join(key.suites)}."
            )
        return (
            f"This endpoint requires the '{required}' scope in test suite '{suite}', and this API "
            f"key grants it only in: {', '.join(key.suites)}."
        )


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

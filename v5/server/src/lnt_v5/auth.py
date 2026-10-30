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

A restricted key is checked against what the request addresses, which is read off the route's path:
a suite, for every route under `/api/projects/{project}/suites/{suite}` (see `suite_parameters`), or
a project, for a route that declares so (see `Coverage`). Any other request needs an instance-wide
key, so a route that declares nothing fails closed. Two routes also read their body, which can ask
for more (see `BodyRule`): moving a suite, and renaming a project. That is only sound because of an
invariant no test can check: a request that addresses a suite writes only to that suite, plus the
destination project of a move, and one that addresses a project only to that project (I5). An
endpoint that reached elsewhere would let a restricted key write where it has only `read`.
"""

from __future__ import annotations

import email.message
import logging
import re
from collections.abc import Iterator, Sequence
from dataclasses import dataclass
from enum import Enum
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
from .suites.store import full_name

logger = logging.getLogger(__name__)

# I5: every 401 tells the caller which scheme it should have used.
UNAUTHENTICATED_HEADERS = {"WWW-Authenticate": "Bearer"}

# What I8's document calls the scheme, and so what every operation's security requirement names.
SECURITY_SCHEME = "ApiKey"

# A path template whose first segments below the project collection and below its suite collection
# are parameters: every suite-scoped route, and E10's routes for one suite.
_SUITE_PATH = re.compile(r"\A/api/projects/\{(\w+)\}/suites/\{(\w+)\}(/|\Z)")

# A path template whose first segment below the project collection is a parameter.
_PROJECT_PATH = re.compile(r"\A/api/projects/\{(\w+)\}(/|\Z)")


def suite_parameters(path_format: str) -> tuple[str, str] | None:
    """The path parameters naming the project and the suite a route addresses (I5), or None if it
    addresses no suite.

    Rests on I1's layout: everything below `/api/projects/` starts with a project name, and
    everything below its `suites/` with a suite name, so no route has a literal segment directly
    under either. A route that did (`/api/projects/{project}/suites/import`, say) would not be seen
    as addressing a suite, and a restricted key would get only `read` on it.
    """
    match = _SUITE_PATH.match(path_format)
    return (match.group(1), match.group(2)) if match else None


def project_parameter(path_format: str) -> str | None:
    """The path parameter naming the project a route is under, or None if it is under none."""
    match = _PROJECT_PATH.match(path_format)
    return match.group(1) if match else None


class Coverage(Enum):
    """What a restricted key must cover to be granted its scope on a route (I5), when the route
    addresses no suite: the project its path names, in full, or (by default) the whole instance,
    which only an instance-wide key covers. A route that addresses a suite needs the suite covered,
    whatever it declares."""

    INSTANCE = "instance"
    PROJECT = "project"


def _addressed(request: Request, coverage: Coverage) -> tuple[str | None, str | None]:
    """The project and the suite a request addresses, read off the route it matched: both for a
    suite, the project alone for a project, and neither for the instance (see `ApiKeyInfo.covers`).

    `path_format` is the route's whole path only because no router is included with a prefix of
    its own (see `create_app`). The test that drives every scoped operation with a restricted key
    is what notices if that changes.
    """
    route = request.scope.get("route")
    path_format = getattr(route, "path_format", "")
    if (parameters := suite_parameters(path_format)) is not None:
        project, suite = parameters
        return request.path_params[project], request.path_params[suite]
    parameter = project_parameter(path_format)
    if coverage is Coverage.PROJECT and parameter is not None:
        return request.path_params[parameter], None
    return None, None


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


class BodyRule(Enum):
    """What a route's body can ask a restricted key to cover beyond what its path addresses (I5).

    I5 decides it from the body, before the body is validated: a request is a move when its body has
    a `project` other than the path's, and a project rename when its body has a `name` other than
    the path's, whatever that value is. A body that is not a JSON object asks for nothing more, and
    is refused once validated.
    """

    # `PATCH /api/projects/{project}/suites/{suite}`: a move also needs the destination project
    # covered in full.
    MOVE = "move"
    # `PATCH /api/projects/{project}`: renaming the project needs an instance-wide key.
    PROJECT_RENAME = "project_rename"

    @property
    def documentation(self) -> str:
        """What I8's document adds to the sentence saying what an operation needs (I8)."""
        if self is BodyRule.MOVE:
            return "Moving it to another project also needs that project covered in full."
        return "Renaming it needs an unrestricted key."

    def requirement(
        self, required: Scope, project: str, body: dict[str, Any]
    ) -> BodyRequirement | None:
        """What `body`, sent to a route requiring `required` and addressing the project `project`,
        asks for, if anything."""
        scope = f"the '{required.value}' scope"
        if self is BodyRule.MOVE:
            if "project" not in body or body["project"] == project:
                return None
            destination = body["project"]
            if not isinstance(destination, str):
                # Not a project name, so nothing a restricted key can cover.
                return BodyRequirement(
                    None,
                    f"Moving a test suite requires {scope} covering the project it is moved to in "
                    "full",
                )
            return BodyRequirement(
                destination,
                f"Moving a test suite to project '{destination}' requires {scope} covering that "
                "project in full",
            )
        if "name" not in body or body["name"] == project:
            return None
        return BodyRequirement(
            None, f"Renaming a project requires {scope} from an instance-wide API key"
        )


@dataclass(frozen=True)
class BodyRequirement:
    """What a restricted key must cover, beyond what the request's path addresses, for what its body
    asks (see `BodyRule`): a project in full, or with None, the instance. `refusal` says why a key
    that does not is refused, to be followed by what it is restricted to."""

    project: str | None
    refusal: str


def _is_json(content_type: str | None) -> bool:
    """Whether FastAPI reads a body sent with `content_type` as JSON: `application/json`, or a
    subtype ending in `+json`. Without a content type, it does not (its strict content types)."""
    if not content_type:
        return False
    message = email.message.Message()
    message["content-type"] = content_type
    subtype = message.get_content_subtype()
    return message.get_content_maintype() == "application" and (
        subtype == "json" or subtype.endswith("+json")
    )


async def _json_object(request: Request) -> dict[str, Any] | None:
    """The request's body, if FastAPI reads it as JSON and it is an object, and None otherwise.

    FastAPI has read and parsed the body before solving the route's dependencies, and refused one
    that does not parse, so `request.json()` returns what it parsed. Anything else is left to the
    body's validation, after authorization.
    """
    if not _is_json(request.headers.get("content-type")) or not await request.body():
        return None
    body = await request.json()
    return body if isinstance(body, dict) else None


class RequireScope:
    """The scope an endpoint requires, as a dependency.

    A class rather than a closure so that the requirement can be read back off a route:
    :func:`required_scope` recovers it, which is how I8's document learns each operation's auth
    failures and how the route-coverage test notices an endpoint shipping without a scope.

    Returns the authenticated key, or None for an allowed anonymous caller, so an endpoint that
    needs to know who is calling can depend on this directly rather than resolve the token twice.
    """

    body_rule: BodyRule | None = None

    def __init__(self, scope: Scope, coverage: Coverage = Coverage.INSTANCE) -> None:
        self.scope = scope
        self.coverage = coverage

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

        # Only a restricted key depends on what the request addresses.
        project, suite = (
            (None, None) if key.restricted_to is None else _addressed(request, self.coverage)
        )
        if not key.grants(self.scope, project, suite):
            raise ApiError(ErrorCode.FORBIDDEN, self._refusal(key, project, suite))

        return key

    def _refusal(self, key: ResolvedKey, project: str | None, suite: str | None) -> str:
        """Why `key` is refused, on a request addressing `project` and `suite` (`_addressed`)."""
        required = self.scope.value
        if not key.scope.grants(self.scope):
            return (
                f"This endpoint requires the '{required}' scope, and this API key grants "
                f"'{key.scope.value}'."
            )
        # Refused although its scope suffices, so the key is restricted to something other than
        # what this request addresses.
        assert key.restricted_to is not None
        if not key.restricted_to:
            # I5: deleting what a key is restricted to leaves it restricted, to nothing.
            return (
                f"This endpoint requires the '{required}' scope, and this API key is restricted "
                "to projects and test suites that have all been deleted, so it can only read."
            )
        covered = _covered(key)
        if project is None:
            return (
                f"This endpoint requires the '{required}' scope from an instance-wide API key, and "
                f"this one is restricted to: {covered}."
            )
        if suite is None:
            return (
                f"This endpoint requires the '{required}' scope covering project '{project}' in "
                f"full, and this API key is restricted to: {covered}."
            )
        return (
            f"This endpoint requires the '{required}' scope in test suite "
            f"'{full_name(project, suite)}', and "
            f"this API key grants it only in: {covered}."
        )


def _covered(key: ResolvedKey) -> str:
    """What the restricted `key` lists, as a refusal names it."""
    assert key.restricted_to is not None
    return ", ".join(str(entry) for entry in key.restricted_to)


class RequireScopeAndBody(RequireScope):
    """`RequireScope`, on a route whose body can ask a restricted key for more (see `BodyRule`)."""

    def __init__(self, scope: Scope, coverage: Coverage, body_rule: BodyRule) -> None:
        super().__init__(scope, coverage)
        self.body_rule = body_rule

    def __call__(  # type: ignore[override]
        self,
        request: Request,
        _query: Annotated[None, Depends(reject_unknown_query_parameters)],
        engine: EngineDep,
        last_use: Annotated[LastUseRecorder, Depends(_last_use)],
        token: TokenDep,
        body: Annotated[dict[str, Any] | None, Depends(_json_object)],
    ) -> ResolvedKey | None:
        key = super().__call__(request, _query, engine, last_use, token)
        # Only once the path is covered, which `super()` checks, so that a key not covering it is
        # refused for that.
        if key is None or key.restricted_to is None or body is None:
            return key
        project, _ = _addressed(request, self.coverage)
        assert project is not None and self.body_rule is not None
        wanted = self.body_rule.requirement(self.scope, project, body)
        if wanted is not None and not key.grants(self.scope, wanted.project, None):
            raise ApiError(
                ErrorCode.FORBIDDEN,
                f"{wanted.refusal}, and this API key is restricted to: {_covered(key)}.",
            )
        return key


def require_scope(
    scope: Scope, coverage: Coverage = Coverage.INSTANCE, body_rule: BodyRule | None = None
) -> Any:
    """Declare the scope an endpoint requires, for its `dependencies=[...]`, and what a restricted
    key must cover to be granted it there, unless the endpoint addresses a suite (see `Coverage`),
    and with `body_rule`, what the request's body can ask it to cover as well (see `BodyRule`).

    Returns `Any` because that is how FastAPI types `Depends` -- it has to be assignable to a
    parameter of any annotated type.
    """
    if body_rule is None:
        return Depends(RequireScope(scope, coverage))
    return Depends(RequireScopeAndBody(scope, coverage, body_rule))


def iter_routes(routes: Sequence[BaseRoute]) -> Iterator[RouteContext]:
    """Every route the app can serve, each with the path it is actually served at.

    `app.routes` is not a flat list of endpoints: FastAPI keeps an included router as a single
    entry and resolves its routes' effective paths lazily, so a scan that iterates it directly
    finds no endpoints at all. This is the traversal FastAPI's own document generator uses, which
    is also what makes `path_format` here the key that document is written under.
    """
    return iter_route_contexts(routes)


def required_scope(route: RouteContext) -> Scope | None:
    """The scope a route requires, or None if it declares none (or is not an endpoint)."""
    requirement = route_requirement(route)
    return None if requirement is None else requirement.scope


def route_requirement(route: RouteContext) -> RequireScope | None:
    """What a route requires, or None if it declares nothing (or is not an endpoint).

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
            return call
        pending.extend(dependency.dependencies)
    return None

"""Serving the built client, and what is decided about a request path before anything routes it.

Deep links and hard refreshes must resolve to a client route rather than 404, so anything that is
not the API, not an infrastructure route, and not a request for a file falls through to
index.html. See docs/design/client/architecture.md.

Two things are settled before the route table is consulted at all, and both live here because both
are statements about the raw path rather than about any endpoint: a URL carrying a NUL is refused
(R4, D3), and a server path carrying a trailing slash is redirected (R1).
"""

from __future__ import annotations

from pathlib import PurePosixPath

from starlette.datastructures import URL
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.responses import RedirectResponse, Response
from starlette.staticfiles import StaticFiles
from starlette.types import ASGIApp, Receive, Scope, Send

from .errors import ErrorCode, error_response, no_route
from .routes.health import HEALTHZ_PATH
from .routes.llms import LLMS_PATH

# Extensions that mark a request as asking for a file rather than for a page. Accepted
# limitation: a client route whose last segment ends in one of these (a machine named `node.js`,
# say) is misread as an asset and 404s rather than reaching the client.
STATIC_ASSET_EXTENSIONS = frozenset(
    {
        "avif", "cjs", "css", "eot", "gif", "ico", "jpeg", "jpg", "js", "json", "map", "mjs",
        "otf", "png", "svg", "ttf", "txt", "wasm", "webmanifest", "webp", "woff", "woff2", "xml",
    }
)  # fmt: skip

# Paths the server answers itself that are not under /api/. They share the API's slash handling:
# a probe is as easy to misconfigure with a trailing slash as an endpoint is. Each is named by the
# route module that owns it, so there is one place that decides where it lives.
INFRASTRUCTURE_PATHS = frozenset({HEALTHZ_PATH, LLMS_PATH})


def is_api_path(path: str) -> bool:
    """True for paths owned by the REST API.

    These must never fall through to index.html: an unmatched `/api/...` route is a genuine 404
    and has to answer with the JSON error envelope rather than a page of HTML.
    """
    return path == "/api" or path.startswith("/api/")


def is_server_path(path: str) -> bool:
    """True for paths the server answers itself, as opposed to client routes."""
    return is_api_path(path) or path in INFRASTRUCTURE_PATHS


def canonical_server_path(path: str) -> str | None:
    """The slash-less form of a server path given with a trailing slash, or None if it is fine.

    Server paths are canonically slash-less -- every path in the endpoints spec is written that
    way -- so `/api/suites/` names the same endpoint as `/api/suites`.
    """
    if path == "/" or not path.endswith("/"):
        return None
    stripped = path.rstrip("/")
    return stripped if stripped and is_server_path(stripped) else None


class RejectNulInUrl:
    """Refuse a request whose URL carries a NUL character (D3).

    A NUL reaches the server only percent-encoded, and it is never a value this API can act on:
    PostgreSQL stores it in neither a `text` column nor a `jsonb` value, and refuses it even as a
    query parameter. D3 requires such a value to be the caller's 400 rather than the 500 an
    unattributable `DataError` would produce, and requires the check to live where values are
    typed rather than on each endpoint that reads one.

    For a request *body* the types are that place, and `entities.Storable` is the check: a body is
    a document the endpoint declares whole, so one annotation covers every value in it. A URL is
    not -- each path segment and each filter is declared separately, and a check on each is
    per-endpoint by construction, so the rule would hold only for as long as everyone adding a
    filter remembered it. Refusing the URL whole is the same rule applied where the URL is still
    one thing.

    Before authentication, unlike everything in R5's order of checks, and R4 says so: this belongs
    with the oversized body and the trailing-slash redirect, which are likewise settled before a
    request reaches an endpoint. It reveals nothing -- the answer is a fact about the bytes sent,
    not about what this instance holds. A reverse proxy commonly refuses such a URL before the
    server ever sees it; this is what makes the server's own answer the same one.
    """

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] == "http" and _has_nul(scope):
            response = error_response(
                ErrorCode.INVALID_REQUEST,
                "The request URL may not contain a NUL character (U+0000).",
            )
            await response(scope, receive, send)
            return
        await self.app(scope, receive, send)


def _has_nul(scope: Scope) -> bool:
    """Whether a request's path or query string carries a NUL, in either spelling.

    The path arrives percent-decoded, so it holds the character itself. The query string does not,
    and is matched against its encoded form rather than unquoted here -- decoding it would mean
    choosing a character encoding for bytes that have not been through the framework's own parser
    yet, and `%00` is the only spelling it can arrive in.
    """
    path: str = scope["path"]
    query: bytes = scope.get("query_string", b"")
    return "\x00" in path or b"\x00" in query or b"%00" in query


class RedirectTrailingSlash:
    """Send a server path carrying a trailing slash to its canonical form.

    Starlette does this out of the box, but only once nothing has matched -- and the SPA mount at
    "/" matches every path, so its redirect is unreachable here. This restores the framework's
    behaviour for the paths the server owns, and leaves client routes alone: the SPA answers
    `/suites/nts` and `/suites/nts/` alike, and bouncing the browser between them would be noise.

    Purely syntactic, with no consultation of the route table: a trailing slash on a path that
    exists under neither spelling simply costs one extra round trip before its 404.

    307 rather than 301 or 308: it preserves the method and body, so a misspelled POST arrives
    intact, and it does not license a cache to remember the mapping.
    """

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] == "http":
            target = canonical_server_path(scope["path"])
            if target is not None:
                url = URL(scope=scope).replace(path=target)
                await RedirectResponse(url, status_code=307)(scope, receive, send)
                return
        await self.app(scope, receive, send)


def is_static_asset_path(path: str) -> bool:
    """True for paths that look like a request for a static file.

    Matching is against a known set of extensions rather than "the last segment contains a dot",
    because real routes do: `/suites/nts/machines/macos-26.5-arm64` must still reach the client.
    """
    return PurePosixPath(path).suffix[1:].lower() in STATIC_ASSET_EXTENSIONS


def _not_found(method: str | None, path: str) -> StarletteHTTPException:
    """A 404 worded like every other 404 the app emits, rather than StaticFiles' "Not Found"."""
    return StarletteHTTPException(404, no_route(method, path))


class SpaStaticFiles(StaticFiles):
    """Static files, with unmatched page routes falling back to index.html.

    Mounted at `/`, so it is the last thing to see a request; everything it declines becomes a 404
    carrying the error envelope. Constructed with `directory=None` when the client has not been
    built, which the base class understands as "serve nothing".
    """

    async def get_response(self, path: str, scope: Scope) -> Response:
        # `path` is the mount-relative filesystem path, already normalized by get_path (so `..`
        # segments are gone, and `/` arrives as `.`). Rebuild the request path the predicates read.
        request_path = "/" + ("" if path == "." else path)

        # StaticFiles answers a non-GET/HEAD with 405, and would happily serve a file that
        # shadowed an API route. Both are "nothing here" as far as the design is concerned.
        method = scope.get("method")
        if method not in ("GET", "HEAD") or is_api_path(request_path):
            raise _not_found(method, request_path)

        try:
            return await super().get_response(path, scope)
        except StarletteHTTPException as exc:
            if exc.status_code != 404:
                raise
            # A missing asset stays a 404. Serving index.html under a script or stylesheet URL
            # turns a stale deploy into a MIME-type error instead of a clean miss.
            if is_static_asset_path(request_path):
                raise _not_found(method, request_path) from exc

        try:
            return await super().get_response("index.html", scope)
        except StarletteHTTPException as exc:
            # No built client, or a bundle somehow missing its entry point.
            raise _not_found(method, request_path) from exc

"""Serving the built client, and routing unknown paths to it.

Deep links and hard refreshes must resolve to a client route rather than 404, so anything that is
not the API, not an infrastructure route, and not a request for a file falls through to
index.html. See docs/design/client/architecture.md.
"""

from __future__ import annotations

from pathlib import PurePosixPath

from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.responses import Response
from starlette.staticfiles import StaticFiles
from starlette.types import Scope

from .errors import no_route

# Extensions that mark a request as asking for a file rather than for a page. Accepted
# limitation: a client route whose last segment ends in one of these (a machine named `node.js`,
# say) is misread as an asset and 404s rather than reaching the client.
STATIC_ASSET_EXTENSIONS = frozenset(
    {
        "avif", "cjs", "css", "eot", "gif", "ico", "jpeg", "jpg", "js", "json", "map", "mjs",
        "otf", "png", "svg", "ttf", "txt", "wasm", "webmanifest", "webp", "woff", "woff2", "xml",
    }
)  # fmt: skip


def is_api_path(path: str) -> bool:
    """True for paths owned by the REST API.

    These must never fall through to index.html: an unmatched `/api/...` route is a genuine 404
    and has to answer with the JSON error envelope rather than a page of HTML.
    """
    return path == "/api" or path.startswith("/api/")


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

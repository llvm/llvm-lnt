"""The caching headers on every response (I9), and the values for the web UI's files (AR2).

A response without `Cache-Control` leaves caches to decide for themselves, and some shared caches
then apply a default lifetime. That is long enough to answer a revoked token with data, or to keep
returning a 404 for a run submitted since. So every response gets the header.

The web UI's files get theirs where they are served (spa.py), because their header depends on the
file. Every other response gets it here, based on the request alone.
"""

from __future__ import annotations

from fastapi import FastAPI
from starlette.datastructures import Headers, MutableHeaders
from starlette.types import ASGIApp, Message, Receive, Scope, Send

# AR2: the client build gives files under assets/ content-hashed names, so they can be cached
# forever.
IMMUTABLE = "public, max-age=31536000, immutable"

# For anything that may change: a cache may store it, but must check with the server before every
# reuse. `max-age=0` repeats this for shared caches that ignore `no-cache`, such as Fastly, which
# would otherwise apply a fallback TTL.
REVALIDATE = "no-cache, max-age=0"

# I9: a response to a request with a credential is meant for that request only. Fastly honours
# only `private`, and some other caches honour only `no-store`.
PRIVATE = "private, no-store"


class AddCacheHeaders:
    """Add I9's caching headers to every response that does not set `Cache-Control` itself.

    The header depends only on whether the request has an `Authorization` header, whatever its
    value. Only such a request can get a response that depends on a credential, so this covers
    every such endpoint, every 401 for a credential and every 403, without listing them. `Vary`
    keeps a cache that serves an anonymous response stale, or to the requests queued behind it,
    from giving it to a request with a credential.

    A response that already has a `Cache-Control` header keeps it. That is how the web UI's files
    keep their own. It also means an endpoint that set one would bypass I9; none does.
    """

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        has_credential = "authorization" in Headers(scope=scope)

        async def send_with_headers(message: Message) -> None:
            if message["type"] == "http.response.start":
                headers = MutableHeaders(scope=message)
                if "cache-control" not in headers:
                    headers["Cache-Control"] = PRIVATE if has_credential else REVALIDATE
                    headers.add_vary_header("Authorization")
            await send(message)

        await self.app(scope, receive, send_with_headers)


class CachingFastAPI(FastAPI):
    """FastAPI, with `AddCacheHeaders` wrapped around its whole middleware stack.

    It wraps the stack instead of being added to it, because `add_middleware` does not reach the
    outermost layer, which is where Starlette sends the 500 for an unhandled exception. Wrapping
    the stack covers that response too, along with the ones other middleware send without reaching
    an endpoint (the NUL 400, the trailing-slash 307, the oversized-body 413).
    """

    def build_middleware_stack(self) -> ASGIApp:
        return AddCacheHeaders(super().build_middleware_stack())

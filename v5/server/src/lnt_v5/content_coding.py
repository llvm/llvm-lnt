"""Compressed request bodies (I4): decoding a gzip body before any endpoint reads it.

Neither the reverse proxy nor the CDN in front of the server decodes a request body, so the server
does it itself, for every route at once: an endpoint only ever sees the decoded body. Responses are
compressed by Starlette's `GZipMiddleware` instead (see app.py), which needs nothing of ours.
"""

from __future__ import annotations

import zlib

from starlette.datastructures import Headers
from starlette.exceptions import HTTPException
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from .errors import ErrorCode, error_response

# The content codings a request body may have, by name. `x-gzip` is gzip's old name, which RFC 9110
# (section 8.4.1.3) asks recipients to accept as gzip.
GZIP = frozenset({"gzip", "x-gzip"})

# What a 415 offers instead (RFC 9110, section 15.5.16).
ACCEPTED = "gzip"

# The gzip container rather than a raw deflate stream; see `zlib.decompressobj`.
_GZIP_WBITS = 16 + zlib.MAX_WBITS


class DecodeRequestBody:
    """Decode a gzip request body as it is read, refusing it once it grows past `max_body_size`.

    Decoded lazily, inside `receive`, so that a decompression bomb is refused once it reaches the
    limit rather than expanded in full, and so that every failure surfaces while the endpoint reads
    the body: FastAPI does that before resolving dependencies, which puts a 400 for a corrupt body
    before authentication, as I5 allows. Failures are `HTTPException`s, which the exception handlers
    render; FastAPI turns anything else raised while reading the body into a generic 400.

    The limit is enforced here rather than by a second `RequestBodyLimitMiddleware`, which would
    overwrite the limit of the one outside this, on the body as sent, rather than add its own.
    """

    def __init__(self, app: ASGIApp, max_body_size: int) -> None:
        self.app = app
        self.max_body_size = max_body_size

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        codings = _codings(Headers(scope=scope))
        if not codings:
            await self.app(scope, receive, send)
            return
        if len(codings) > 1 or codings[0] not in GZIP:
            response = error_response(
                ErrorCode.UNSUPPORTED_ENCODING,
                f"The request body's content coding ({', '.join(codings)}) is not supported; send "
                f"it uncompressed, or compressed with {ACCEPTED} alone.",
                headers={"Accept-Encoding": ACCEPTED},
            )
            await response(scope, receive, send)
            return

        # A copy, never the caller's scope, as in `AnswerHeadLikeGet`. Both headers describe the
        # body as sent, which nothing past this point sees.
        headers = [
            (name, value)
            for name, value in scope["headers"]
            if name.lower() not in (b"content-encoding", b"content-length")
        ]
        body = _GzipBody(receive, self.max_body_size)
        await self.app({**scope, "headers": headers}, body.receive, send)


def _codings(headers: Headers) -> list[str]:
    """The content codings a request's body went through, in the order they were applied.

    Every `Content-Encoding` header counts, since a list may be split across several (RFC 9110,
    section 5.3), and `identity` is dropped, since it stands for no coding at all.
    """
    return [
        coding
        for value in headers.getlist("content-encoding")
        for coding in (part.strip().lower() for part in value.split(","))
        if coding and coding != "identity"
    ]


class _GzipBody:
    """The `receive` of a request whose body is gzip-compressed, yielding the decoded body.

    Several gzip members one after the other decode to their concatenation, as RFC 1952 has it, and
    as `gzip -d` reads them.
    """

    def __init__(self, receive: Receive, max_body_size: int) -> None:
        self._receive = receive
        self._max_body_size = max_body_size
        self._decompressor = zlib.decompressobj(wbits=_GZIP_WBITS)
        self._size = 0
        # Whether any of the body has arrived: an empty body stays empty, whatever its coding says.
        self._started = False

    async def receive(self) -> Message:
        # Not wrapped in a handler: what the inner `receive` raises, such as the 413 for a body too
        # large as sent, is meant for the exception handlers as it is.
        message = await self._receive()
        if message["type"] != "http.request":
            return message
        data = message.get("body", b"")
        self._started = self._started or bool(data)
        body = self._decode(data)
        if not message.get("more_body", False) and self._started and not self._decompressor.eof:
            raise _unreadable("the gzip data ends before its stream does")
        return {**message, "body": body}

    def _decode(self, data: bytes) -> bytes:
        chunks = []
        while data:
            if self._decompressor.eof:
                self._decompressor = zlib.decompressobj(wbits=_GZIP_WBITS)
            # One byte past what the limit allows, so that reaching it is told from exceeding it.
            # Output stops there, so a bomb is never expanded beyond the limit.
            allowed = self._max_body_size - self._size + 1
            try:
                chunk = self._decompressor.decompress(data, allowed)
            except zlib.error as error:
                raise _unreadable(f"it is not valid gzip data ({error})") from error
            self._size += len(chunk)
            if self._size > self._max_body_size:
                # Worded as Starlette's own 413, which errors.py renders the same way.
                raise HTTPException(413, "Content Too Large")
            chunks.append(chunk)
            # What follows the end of a member, if anything. Input is left over for want of output
            # room only when the output reached `allowed`, which is the 413 above, so there is no
            # `unconsumed_tail` to carry on with here.
            decompressor = self._decompressor
            data = decompressor.unused_data if decompressor.eof else b""
        return b"".join(chunks)


def _unreadable(problem: str) -> HTTPException:
    # A 400, which errors.py renders as I4's `invalid_request` with this message.
    return HTTPException(400, f"The request body cannot be decoded: {problem}.")

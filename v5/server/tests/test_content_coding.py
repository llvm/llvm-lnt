"""I4's compressed request bodies and responses.

The request side is driven both through the application, for what a client sees, and as raw ASGI,
for what TestClient cannot do: it always sends a body in one message, and never one byte at a time.
The submissions that need a database are in `test_runs.py`.
"""

from __future__ import annotations

import gzip
import json
import zlib
from pathlib import Path
from typing import Any

import anyio
import pytest
from fastapi.testclient import TestClient
from starlette.exceptions import HTTPException
from starlette.types import Message, Receive, Scope, Send

from conftest import code_of, run_payload, vary
from lnt_v5.app import create_app
from lnt_v5.config import Settings
from lnt_v5.content_coding import DecodeRequestBody

# A write endpoint: it reads its body before authenticating (I5), so without a token a body that
# decodes gets a 401, which takes a database, and one that does not gets a 400, which does not.
RUNS = "/api/projects/nts/suites/nts/runs"

SUBMISSION = json.dumps(run_payload()).encode()


def gzipped(data: bytes = SUBMISSION) -> bytes:
    return gzip.compress(data)


def post(client: TestClient, body: bytes, encoding: str | None = "gzip") -> Any:
    headers = {"Content-Type": "application/json"}
    if encoding is not None:
        headers["Content-Encoding"] = encoding
    return client.post(RUNS, content=body, headers=headers)


class TestRequestBodies:
    @pytest.mark.parametrize("encoding", ["gzip", "x-gzip", "GZIP", " gzip ", "identity, gzip"])
    def test_a_gzip_body_is_decoded(self, api_client: TestClient, encoding: str) -> None:
        assert post(api_client, gzipped(), encoding).status_code == 401

    @pytest.mark.parametrize("encoding", [None, "identity"])
    def test_an_uncompressed_body_is_read_as_it_is(
        self, api_client: TestClient, encoding: str | None
    ) -> None:
        assert post(api_client, SUBMISSION, encoding).status_code == 401

    @pytest.mark.parametrize("encoding", ["br", "zstd", "deflate", "gzip, gzip", "compress"])
    def test_any_other_coding_is_415(self, client: TestClient, encoding: str) -> None:
        response = post(client, gzipped(), encoding)

        assert response.status_code == 415
        assert code_of(response) == "unsupported_encoding"
        # RFC 9110, section 15.5.16: what the server would have accepted.
        assert response.headers["accept-encoding"] == "gzip"
        assert response.headers["cache-control"] == "no-cache, max-age=0"

    @pytest.mark.parametrize(
        "body",
        [b"not gzip at all", gzipped()[:-6], gzipped() + b"trailing"],
        ids=["corrupt", "truncated", "trailing data"],
    )
    def test_a_body_that_does_not_decode_is_400_before_authentication(
        self, client: TestClient, body: bytes
    ) -> None:
        # I5 allows a body that cannot be read at all to be refused before authenticating: the
        # endpoint needs a token, and none was sent.
        response = post(client, body)

        assert response.status_code == 400
        assert code_of(response) == "invalid_request"
        assert "cannot be decoded" in response.json()["error"]["message"]

    def test_several_gzip_members_decode_to_their_concatenation(
        self, api_client: TestClient
    ) -> None:
        half = len(SUBMISSION) // 2
        body = gzipped(SUBMISSION[:half]) + gzipped(SUBMISSION[half:])

        assert post(api_client, body).status_code == 401

    def test_a_body_larger_than_the_limit_once_decoded_is_413(self, settings: Settings) -> None:
        # I4: the limit applies to the decoded body as well as to the one sent, which is far
        # smaller here.
        limit = 1000
        client = TestClient(create_app(settings.model_copy(update={"body_limit": limit})))
        padded = json.dumps(run_payload(run_parameters={"x": " " * limit})).encode()
        assert len(gzipped(padded)) < limit

        response = post(client, gzipped(padded))

        assert response.status_code == 413
        assert response.headers["content-type"].startswith("text/plain")


async def _echo(scope: Scope, receive: Receive, send: Send) -> None:
    """An app that answers with the body it received, and the headers it was given."""
    body = b""
    while True:
        message = await receive()
        body += message.get("body", b"")
        if not message.get("more_body", False):
            break
    headers = [(b"x-seen", name) for name, _ in scope["headers"]]
    await send({"type": "http.response.start", "status": 200, "headers": headers})
    await send({"type": "http.response.body", "body": body})


def drive(body: bytes, chunk: int, limit: int = 1 << 20) -> tuple[bytes, list[bytes]]:
    """Send `body`, gzip-encoded, through the middleware `chunk` bytes at a time.

    Returns what the app read, and the names of the headers it was given.
    """
    messages: list[Message] = [
        {"type": "http.request", "body": body[i : i + chunk], "more_body": i + chunk < len(body)}
        for i in range(0, len(body), chunk)
    ] or [{"type": "http.request", "body": b"", "more_body": False}]
    sent: list[Message] = []

    async def receive() -> Message:
        return messages.pop(0) if messages else {"type": "http.disconnect"}

    async def send(message: Message) -> None:
        sent.append(message)

    scope: Scope = {
        "type": "http",
        "method": "POST",
        "headers": [(b"content-encoding", b"gzip"), (b"content-length", b"1"), (b"x-other", b"1")],
    }
    anyio.run(DecodeRequestBody(_echo, max_body_size=limit), scope, receive, send)
    seen = [value for name, value in sent[0]["headers"] if name == b"x-seen"]
    return sent[1]["body"], seen


class TestIncrementalDecoding:
    @pytest.mark.parametrize("chunk", [1, 7, 1 << 20])
    def test_the_body_is_decoded_however_it_is_split(self, chunk: int) -> None:
        data = b"0123456789" * 1000

        assert drive(gzipped(data) + gzipped(data), chunk)[0] == data * 2

    def test_the_app_does_not_see_the_headers_of_the_encoded_body(self) -> None:
        assert drive(gzipped(), 1 << 20)[1] == [b"x-other"]

    def test_an_empty_body_stays_empty(self) -> None:
        assert drive(b"", 1)[0] == b""

    @pytest.mark.parametrize("chunk", [1, 1 << 20])
    def test_a_stream_cut_short_is_refused(self, chunk: int) -> None:
        with pytest.raises(HTTPException) as refused:
            drive(gzipped()[:-1], chunk)

        assert refused.value.status_code == 400

    @pytest.mark.parametrize("chunk", [1, 1 << 20])
    def test_a_bomb_is_refused_without_being_expanded_past_the_limit(
        self, chunk: int, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # 64 MiB of zeros, about 64 KiB compressed, refused at a 1 KiB limit. Sent whole as well as
        # a byte at a time: an uncapped decoder handed the whole body would expand all 64 MiB
        # before noticing, so what the decompressors produce is counted.
        produced = 0
        decompressobj = zlib.decompressobj

        class Counting:
            def __init__(self, **kwargs: Any) -> None:
                self._inner = decompressobj(**kwargs)

            def decompress(self, data: bytes, max_length: int = 0) -> bytes:
                nonlocal produced
                output = self._inner.decompress(data, max_length)
                produced += len(output)
                return output

            def __getattr__(self, name: str) -> Any:
                return getattr(self._inner, name)

        monkeypatch.setattr(zlib, "decompressobj", Counting)
        bomb = gzip.compress(bytes(64 << 20), compresslevel=9)

        with pytest.raises(HTTPException) as refused:
            drive(bomb, chunk, limit=1024)

        assert refused.value.status_code == 413
        assert produced == 1025

    def test_the_limit_itself_is_accepted(self) -> None:
        data = b"x" * 1024

        assert drive(gzipped(data), 1, limit=1024)[0] == data

    def test_one_byte_past_the_limit_is_refused(self) -> None:
        with pytest.raises(HTTPException) as refused:
            drive(gzipped(b"x" * 1025), 1, limit=1024)

        assert refused.value.status_code == 413


@pytest.fixture
def plain(client: TestClient) -> TestClient:
    """A client that, like plain curl, sends no `Accept-Encoding`, which TestClient sends."""
    del client.headers["accept-encoding"]
    return client


class TestResponses:
    def test_a_response_is_compressed_when_the_request_accepts_gzip(
        self, client: TestClient
    ) -> None:
        response = client.get("/llms.txt", headers={"Accept-Encoding": "gzip"})

        assert response.status_code == 200
        assert response.headers["content-encoding"] == "gzip"
        assert sorted(vary(response)) == ["Accept-Encoding", "Authorization"]
        assert response.text.startswith("# LNT")

    def test_a_request_without_accept_encoding_gets_an_uncompressed_response(
        self, plain: TestClient
    ) -> None:
        response = plain.get("/llms.txt")

        assert response.status_code == 200
        assert "content-encoding" not in response.headers
        # Still `Vary`: the response would have been compressed for a request that accepted it.
        assert sorted(vary(response)) == ["Accept-Encoding", "Authorization"]

    def test_a_small_response_is_not_compressed(self, client: TestClient) -> None:
        response = client.get("/api/nope", headers={"Accept-Encoding": "gzip"})

        assert "content-encoding" not in response.headers
        assert vary(response) == ["Authorization"]

    def test_head_gets_the_headers_of_get(self, client: TestClient) -> None:
        get = client.get("/api/openapi.json", headers={"Accept-Encoding": "gzip"})
        head = client.head("/api/openapi.json", headers={"Accept-Encoding": "gzip"})

        assert head.status_code == 200
        assert head.content == b""
        for name in ("content-encoding", "content-type", "vary", "cache-control"):
            assert head.headers[name] == get.headers[name]


class TestWebUiFiles:
    def test_a_file_is_compressed_with_a_weak_etag_that_still_revalidates(
        self, client: TestClient, client_dist: Path
    ) -> None:
        (client_dist / "assets" / "chunk-Ab12Cd34.js").write_text("export const x = 1;\n" * 1000)
        url = "/assets/chunk-Ab12Cd34.js"

        first = client.get(url, headers={"Accept-Encoding": "gzip"})
        assert first.headers["content-encoding"] == "gzip"
        assert first.headers["etag"].startswith('W/"')

        revalidated = client.get(
            url, headers={"Accept-Encoding": "gzip", "If-None-Match": first.headers["etag"]}
        )
        assert revalidated.status_code == 304
        assert revalidated.headers["etag"] == first.headers["etag"]
        # RFC 9110, section 15.4.5: a 304 repeats the `Vary` its 200 would carry.
        assert "Accept-Encoding" in vary(revalidated)

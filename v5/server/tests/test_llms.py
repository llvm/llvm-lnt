"""The AI agent orientation document (R6).

Beyond how it is served, the tests here are about the *content*: every API path the document names,
and every error code, has to be one this server really has. The document exists to be followed
literally by something that cannot check, so a path that stopped existing would send every reader
at a 404, and nothing else in the suite would notice.

Two of its properties are covered where they belong with their siblings rather than here: its
trailing-slash handling with the other server paths in `test_spa.py`, and its absence from R8's
document with the other exempt route in `test_docs.py`.

Nothing here needs a database: the document is static and the route table is built without one.
"""

from __future__ import annotations

import re

from fastapi import FastAPI
from fastapi.testclient import TestClient

from lnt_v5.auth import iter_routes, required_scope
from lnt_v5.errors import ErrorCode
from lnt_v5.routes.llms import LLMS_PATH
from lnt_v5.scopes import Scope


def _document(client: TestClient) -> str:
    return client.get(LLMS_PATH).text


class TestServing:
    def test_is_served_as_utf8_plain_text(self, client: TestClient) -> None:
        # Also covers route ordering: `.txt` is a static-asset extension, so this would 404
        # rather than reach the client if the route were registered after the SPA mount at "/".
        response = client.get(LLMS_PATH)

        assert response.status_code == 200
        # R6 fixes both halves: `text/plain`, and a charset saying how to read the bytes.
        assert response.headers["content-type"] == "text/plain; charset=utf-8"
        assert response.text.startswith("# LNT v5")


class TestContent:
    def test_links_to_both_documentation_routes(self, client: TestClient) -> None:
        # R6 requires both links: they are how a reader gets from this document to the details.
        document = _document(client)

        assert "/api/openapi.json" in document
        assert "/api/docs" in document

    def test_names_every_error_code(self, client: TestClient) -> None:
        # R4's codes are what the document tells a reader to branch on, so a code it does not
        # mention is one a reader will not handle.
        document = _document(client)

        assert {code for code in ErrorCode if code.value in document} == set(ErrorCode)

    def test_gives_the_right_scope_for_every_operation_it_annotates(
        self, client: TestClient, app: FastAPI
    ) -> None:
        """Where the document names an operation's scope, it agrees with what the route enforces.

        Only the write workflows carry one, since `read` is the document's stated default; those
        are also the ones a reader cannot guess, because R5 makes the method imply nothing.
        """
        declared = {
            (route.path_format, method): required_scope(route)
            for route in iter_routes(app.routes)
            for method in route.methods or ()
        }

        annotated = _OPERATION.findall(_document(client))
        assert annotated, "the document no longer annotates any operation with its scope"
        for method, path, scope in annotated:
            assert declared.get((path, method)) == Scope(scope), f"{method} {path}"

    def test_names_only_paths_this_server_serves(self, client: TestClient, app: FastAPI) -> None:
        """Every path in the document resolves to a route, as written or as a suite-relative tail.

        The document spells a suite-scoped path in full the first time and abbreviates it
        afterwards -- `/runs/{uuid}/samples` for what is really
        `/api/suites/{testsuite}/runs/{uuid}/samples` -- because a reader that has got that far
        knows the prefix and the full form is unreadable six times in a paragraph. Matching on a
        tail accepts both, and still catches a path that names nothing.
        """
        served = {
            _shape(route.path_format) for route in iter_routes(app.routes) if route.path_format
        }

        for path in _paths_named_in(_document(client)):
            shape = _shape(path)
            assert any(route.endswith(shape) for route in served), (
                f"the document names {path}, which no route serves"
            )


# An operation the document annotates with the scope it needs, as
# "`POST /api/suites/{testsuite}/runs` (scope `submit`)". `\s+` rather than a space because the
# annotation is prose and wraps.
_OPERATION = re.compile(r"`(GET|POST|PATCH|DELETE) (/[^`]+)`\s*\(scope\s+`(\w+)`\)")

# A path as the document writes one: a leading slash and at least one more character, stopping at
# whitespace, at a closing backtick or bracket, and at a query string -- `?test=<name>` names a
# parameter rather than part of the path. Trailing sentence punctuation is stripped after the fact.
_PATH = re.compile(r"/[A-Za-z0-9_{}/.-]+")

# Path parameters are named for the reader rather than for the router: the document writes
# `/profiles/{uuid}/functions/{name}` where the route says `{fn_name:path}`.
_PARAMETER = re.compile(r"\{[^}]*\}")


def _shape(path: str) -> str:
    """A path with its parameter names erased, so two spellings of the same route compare equal."""
    return _PARAMETER.sub("{}", path)


def _paths_named_in(document: str) -> set[str]:
    return {
        stripped
        for match in _PATH.finditer(document)
        if len(stripped := match.group().rstrip("./-")) > 1
    }

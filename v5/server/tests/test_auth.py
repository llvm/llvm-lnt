"""Authentication and authorization (R5).

`GET /api/` and the API key endpoints are the two surfaces these drive: one `read`-scoped, which
anonymous callers reach, and one `admin`-scoped, which they never do. Between them they cover
every outcome R5 specifies.

The scope hierarchy itself is `Scope.grants`, tested in `test_keys.py`; what is checked here is
that endpoints enforce it, and that they do so in the order R5 requires.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from lnt_v5.auth import iter_routes, required_scope
from lnt_v5.scopes import Scope

# A read-scoped endpoint and an admin-scoped one.
READABLE = "/api"
ADMIN_ONLY = "/api/admin/api-keys"
# A `manage`-scoped endpoint taking a body, for the one check that needs a request to validate.
SUITES = "/api/suites"

# R5 exempts four routes from the scope system. Two of them live under `/api/`; the other two,
# `/healthz` and `/llms.txt`, do not and are covered by `TestExemptRoutes` below.
EXEMPT_API_PATHS = {"/api/openapi.json", "/api/docs"}

# Well-formed as a Bearer credential, but not a token this server ever issued.
UNKNOWN_TOKEN = "f" * 64


class TestHeaderParsing:
    def test_no_header_reaches_a_read_endpoint(self, api_client: TestClient) -> None:
        # R5: read-scoped endpoints allow unauthenticated access.
        assert api_client.get(READABLE).status_code == 200

    def test_no_header_is_refused_above_read(self, api_client: TestClient) -> None:
        response = api_client.get(ADMIN_ONLY)

        assert response.status_code == 401
        assert response.json()["error"]["code"] == "unauthorized"

    @pytest.mark.parametrize("scheme", ["Bearer", "bearer", "BEARER", "BeArEr"])
    def test_the_scheme_is_matched_case_insensitively(
        self, api_client: TestClient, make_key: Callable[..., str], scheme: str
    ) -> None:
        # RFC 9110 makes the scheme name case-insensitive, and R5 defers to it.
        token = make_key(Scope.ADMIN)

        response = api_client.get(ADMIN_ONLY, headers={"Authorization": f"{scheme} {token}"})

        assert response.status_code == 200

    @pytest.mark.parametrize(
        ("header", "why"),
        [
            ("Basic dXNlcjpwYXNz", "a scheme other than Bearer"),
            ("token abc123", "a scheme other than Bearer"),
            ("justgarbage", "no scheme at all"),
            ("Bearer", "no credential at all"),
            ("Bearer ", "an empty credential"),
            ("", "an empty header"),
        ],
    )
    def test_an_unreadable_header_is_a_400(
        self, api_client: TestClient, header: str, why: str
    ) -> None:
        # R5: this is a malformed request rather than a rejected credential, and deliberately not
        # treated as an absent header -- falling through to anonymous access would silently ignore
        # a credential the caller believes it sent.
        response = api_client.get(READABLE, headers={"Authorization": header})

        assert response.status_code == 400, why
        assert response.json()["error"]["code"] == "invalid_request"

    @pytest.mark.parametrize(
        "token",
        [
            UNKNOWN_TOKEN,
            "not-hex-" + "0" * 56,
            "ABCDEF" + "0" * 58,  # uppercase hex is not the shape R5 fixes
            "0" * 63,
            "0" * 65,
            "short",
        ],
    )
    def test_a_token_that_resolves_to_nothing_is_a_401(
        self, api_client: TestClient, bearer: Callable[[str], dict[str, str]], token: str
    ) -> None:
        # R5 folds malformed and unknown together: both are `invalid_token`.
        response = api_client.get(ADMIN_ONLY, headers=bearer(token))

        assert response.status_code == 401
        assert response.json()["error"]["code"] == "unauthorized"

    def test_a_bad_token_is_not_downgraded_to_anonymous(
        self, api_client: TestClient, bearer: Callable[[str], dict[str, str]]
    ) -> None:
        # The same request without a header would have succeeded. R5 refuses it anyway, so that a
        # broken or revoked token cannot return results the caller misreads as authoritative.
        assert api_client.get(READABLE).status_code == 200

        assert api_client.get(READABLE, headers=bearer(UNKNOWN_TOKEN)).status_code == 401

    def test_a_401_says_which_scheme_to_use(self, api_client: TestClient) -> None:
        assert api_client.get(ADMIN_ONLY).headers["WWW-Authenticate"] == "Bearer"


class TestScopeEnforcement:
    @pytest.mark.parametrize("scope", [Scope.READ, Scope.SUBMIT, Scope.TRIAGE, Scope.MANAGE])
    def test_a_key_below_the_requirement_is_a_403(
        self,
        api_client: TestClient,
        make_key: Callable[..., str],
        bearer: Callable[[str], dict[str, str]],
        scope: Scope,
    ) -> None:
        response = api_client.get(ADMIN_ONLY, headers=bearer(make_key(scope)))

        assert response.status_code == 403
        assert response.json()["error"]["code"] == "forbidden"

    @pytest.mark.parametrize("scope", list(Scope))
    def test_every_scope_reaches_a_read_endpoint(
        self,
        api_client: TestClient,
        make_key: Callable[..., str],
        bearer: Callable[[str], dict[str, str]],
        scope: Scope,
    ) -> None:
        # A key grants its own scope plus every lower one, so `read` is reachable by all of them.
        assert api_client.get(READABLE, headers=bearer(make_key(scope))).status_code == 200

    def test_a_403_does_not_reveal_whether_the_resource_exists(
        self,
        api_client: TestClient,
        make_key: Callable[..., str],
        bearer: Callable[[str], dict[str, str]],
    ) -> None:
        # R5 puts authorization before resolving the addressed resource, so that an unauthorized
        # caller cannot enumerate which resources do exist by reading a 404.
        headers = bearer(make_key(Scope.MANAGE))

        response = api_client.delete(f"{ADMIN_ONLY}/nosuchpr", headers=headers)

        assert response.status_code == 403

    def test_a_missing_credential_is_answered_before_the_request_is_validated(
        self, api_client: TestClient
    ) -> None:
        # R5's order of checks starts at authentication, so a caller with no key hears 401 rather
        # than being told what is wrong with a request it was never going to be allowed to make.
        # Pinned because it is the framework's ordering rather than this code's, and an upgrade
        # that reversed it would turn every one of these into a 400.
        response = api_client.post(SUITES, json={"nope": 1})

        assert response.status_code == 401
        assert response.json()["error"]["code"] == "unauthorized"

    def test_but_unparseable_json_is_answered_first(self, api_client: TestClient) -> None:
        # The narrow exception R5 records: a body declared as JSON is decoded before anything can
        # decide about it, so one that does not parse is 400 with no credential at all.
        response = api_client.post(
            SUITES, headers={"Content-Type": "application/json"}, content=b"{oops"
        )

        assert response.status_code == 400
        assert response.json()["error"]["code"] == "invalid_request"

    def test_and_only_when_the_body_says_it_is_json(self, api_client: TestClient) -> None:
        # The same bytes under another content type are never decoded, so the order above stands.
        # Pinned because R5 warns a caller not to read anything into the exception, and a document
        # that says so while the implementation generalized it would be the worse of the two.
        response = api_client.post(SUITES, headers={"Content-Type": "text/plain"}, content=b"{oops")

        assert response.status_code == 401


class TestRevocation:
    def test_a_revoked_key_is_refused(
        self,
        api_client: TestClient,
        make_key: Callable[..., str],
        bearer: Callable[[str], dict[str, str]],
    ) -> None:
        token = make_key(Scope.ADMIN)
        prefix = token[:8]
        assert api_client.delete(f"{ADMIN_ONLY}/{prefix}", headers=bearer(token)).status_code == 204

        # R5 resolves every request against the database rather than caching the decision, so this
        # takes effect on the very next request.
        assert api_client.get(ADMIN_ONLY, headers=bearer(token)).status_code == 401

    def test_a_revoked_key_is_refused_even_where_anonymous_would_be_allowed(
        self,
        api_client: TestClient,
        make_key: Callable[..., str],
        bearer: Callable[[str], dict[str, str]],
    ) -> None:
        admin = make_key(Scope.ADMIN)
        revoked = make_key(Scope.READ, name="doomed")
        api_client.delete(f"{ADMIN_ONLY}/{revoked[:8]}", headers=bearer(admin))

        assert api_client.get(READABLE, headers=bearer(revoked)).status_code == 401


class TestExemptRoutes:
    @pytest.mark.parametrize("path", ["/api/openapi.json", "/api/docs", "/healthz", "/llms.txt"])
    def test_an_authorization_header_has_no_effect(self, api_client: TestClient, path: str) -> None:
        # R5: no authentication happens on their path at all -- not even for a header that would
        # be a 400 or a 401 anywhere else under /api/.
        unauthenticated = api_client.get(path)

        for header in ("Basic zzz", f"Bearer {UNKNOWN_TOKEN}", "Bearer"):
            response = api_client.get(path, headers={"Authorization": header})

            assert response.status_code == unauthenticated.status_code == 200, header


class TestLastUsed:
    def test_starts_null_and_is_recorded_on_use(
        self,
        api_client: TestClient,
        make_key: Callable[..., str],
        read_key: Callable[[str], Any],
        bearer: Callable[[str], dict[str, str]],
    ) -> None:
        token = make_key(Scope.ADMIN)
        assert read_key(token[:8]).last_used_at is None

        api_client.get(ADMIN_ONLY, headers=bearer(token))

        assert read_key(token[:8]).last_used_at is not None

    def test_is_recorded_even_when_the_request_is_refused_by_its_scope(
        self,
        api_client: TestClient,
        make_key: Callable[..., str],
        read_key: Callable[[str], Any],
        bearer: Callable[[str], dict[str, str]],
    ) -> None:
        """D5 records use on successful *authentication*, and on a transaction of its own.

        A 403 is the case that shows both at once: the key was presented and resolved, so its use
        is recorded, while the endpoint never ran and so had no transaction for the write to have
        ridden along in.
        """
        token = make_key(Scope.READ)

        assert api_client.get(ADMIN_ONLY, headers=bearer(token)).status_code == 403

        assert read_key(token[:8]).last_used_at is not None

    def test_is_not_recorded_for_a_key_that_failed_to_authenticate(
        self,
        api_client: TestClient,
        make_key: Callable[..., str],
        read_key: Callable[[str], Any],
        bearer: Callable[[str], dict[str, str]],
    ) -> None:
        admin = make_key(Scope.ADMIN)
        revoked = make_key(Scope.READ, name="doomed")
        api_client.delete(f"{ADMIN_ONLY}/{revoked[:8]}", headers=bearer(admin))

        api_client.get(READABLE, headers=bearer(revoked))

        assert read_key(revoked[:8]).last_used_at is None


class TestRouteCoverage:
    def test_every_api_route_declares_a_scope(self, api_app: FastAPI) -> None:
        """R5: every endpoint under `/api/` declares the scope it requires.

        The guard that keeps a future endpoint from shipping unprotected -- which would otherwise
        be invisible, since an endpoint with no scope simply works for everyone.
        """
        unscoped = {
            (route.path_format, method)
            for route in iter_routes(api_app.routes)
            for method in sorted(route.methods or ())
            if (route.path_format or "").startswith("/api")
            and route.path_format not in EXEMPT_API_PATHS
            and required_scope(route) is None
        }

        assert unscoped == set()

    def test_the_exempt_routes_are_the_ones_r5_names(self, api_app: FastAPI) -> None:
        # The exemption is an explicit list rather than a consequence of living outside `/api/`,
        # so it is worth failing when something joins it by accident.
        exempt = {
            route.path_format
            for route in iter_routes(api_app.routes)
            if (route.path_format or "").startswith("/api") and required_scope(route) is None
        }

        assert exempt == EXEMPT_API_PATHS

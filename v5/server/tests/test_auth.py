"""Authentication and authorization (I5).

`GET /api/` and the API key endpoints are the two surfaces these drive: one `read`-scoped, which
anonymous callers reach, and one `admin`-scoped, which they never do. Between them they cover
every outcome I5 specifies.

The scope hierarchy itself is `Scope.grants`, tested in `test_keys.py`; what is checked here is
that endpoints enforce it, and that they do so in the order I5 requires.

Also here: I3's refusal of a query parameter an endpoint does not take, which every scoped endpoint
runs before authenticating.
"""

from __future__ import annotations

import re
from collections import deque
from collections.abc import Callable, Collection, Sequence
from typing import Annotated, Any

import pytest
from fastapi import FastAPI, Query
from fastapi._compat import field_annotation_is_sequence
from fastapi.testclient import TestClient
from sqlalchemy import Engine, update

from lnt_v5 import keys
from lnt_v5.auth import iter_routes, required_scope
from lnt_v5.querying import _takes_several
from lnt_v5.scopes import UNRESTRICTABLE_SCOPES, Scope
from lnt_v5.tables import api_key

# A read-scoped endpoint and an admin-scoped one.
READABLE = "/api"
ADMIN_ONLY = "/api/admin/api-keys"

# Two of the routes I5 exempts from the scope system live under `/api/`. The others, `/healthz`,
# `/llms.txt` and `/robots.txt`, do not and are covered by `TestExemptRoutes` below.
EXEMPT_API_PATHS = {"/api/openapi.json", "/api/docs"}

# Well-formed as a Bearer credential, but not a token this server ever issued.
UNKNOWN_TOKEN = "f" * 64

# The operations a restrictable scope reaches that address no suite, so that a key restricted to
# some suites can never call them (I5).
UNRESTRICTED_ONLY = {("POST", "/api/suites")}

# A suite of the smallest shape, for the tests that need one to exist.
NTS: dict[str, Any] = {"name": "nts", "metrics": [{"name": "execution_time", "type": "real"}]}


def operations(app: FastAPI, scopes: Collection[Scope]) -> list[tuple[str, str]]:
    """Every operation requiring one of `scopes`, as (method, path template)."""
    found = [
        (method, route.path_format)
        for route in iter_routes(app.routes)
        if required_scope(route) in scopes and route.path_format is not None
        for method in sorted(route.methods or ())
    ]
    assert found
    return found


def placeholders_filled(template: str) -> str:
    """A path for `template`, with every parameter set to `x`."""
    return re.sub(r"\{[^}]*\}", "x", template)


class TestHeaderParsing:
    def test_no_header_reaches_a_read_endpoint(self, api_client: TestClient) -> None:
        # I5: read-scoped endpoints allow unauthenticated access.
        assert api_client.get(READABLE).status_code == 200

    def test_no_header_is_refused_above_read(self, api_client: TestClient) -> None:
        response = api_client.get(ADMIN_ONLY)

        assert response.status_code == 401
        assert response.json()["error"]["code"] == "unauthorized"

    def test_head_is_refused_like_get(self, api_client: TestClient) -> None:
        # I4 answers HEAD as it would GET, which includes I5's checks: a HEAD must not be a way
        # around them, nor answered as if it had passed them.
        get = api_client.get(ADMIN_ONLY)
        head = api_client.head(ADMIN_ONLY)

        assert head.status_code == 401
        assert head.headers == get.headers
        assert head.headers["www-authenticate"] == "Bearer"

    @pytest.mark.parametrize("scheme", ["Bearer", "bearer", "BEARER", "BeArEr"])
    def test_the_scheme_is_matched_case_insensitively(
        self, api_client: TestClient, make_key: Callable[..., str], scheme: str
    ) -> None:
        # RFC 9110 makes the scheme name case-insensitive, and I5 defers to it.
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
    def test_a_header_with_no_usable_bearer_credential_is_a_401(
        self, api_client: TestClient, header: str, why: str
    ) -> None:
        # I5: RFC 6750 treats this as a request without credentials, and it is deliberately not
        # treated as an absent header -- falling through to anonymous access on this read-scoped
        # endpoint would silently ignore a credential the caller believes it sent.
        response = api_client.get(READABLE, headers={"Authorization": header})

        assert response.status_code == 401, why
        assert response.json()["error"]["code"] == "unauthorized"
        assert response.headers["WWW-Authenticate"] == "Bearer"

    @pytest.mark.parametrize(
        "token",
        [
            UNKNOWN_TOKEN,
            "not-hex-" + "0" * 56,
            "ABCDEF" + "0" * 58,  # uppercase hex is not the shape I5 fixes
            "0" * 63,
            "0" * 65,
            "short",
        ],
    )
    def test_a_token_that_resolves_to_nothing_is_a_401(
        self, api_client: TestClient, bearer: Callable[[str], dict[str, str]], token: str
    ) -> None:
        # I5 folds malformed and unknown together: both are `invalid_token`.
        response = api_client.get(ADMIN_ONLY, headers=bearer(token))

        assert response.status_code == 401
        assert response.json()["error"]["code"] == "unauthorized"

    def test_a_bad_token_is_not_downgraded_to_anonymous(
        self, api_client: TestClient, bearer: Callable[[str], dict[str, str]]
    ) -> None:
        # The same request without a header would have succeeded. I5 refuses it anyway, so that a
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
        # I5 puts authorization before resolving the addressed resource, so that an unauthorized
        # caller cannot enumerate which resources do exist by reading a 404.
        headers = bearer(make_key(Scope.MANAGE))

        response = api_client.delete(f"{ADMIN_ONLY}/nosuchpr", headers=headers)

        assert response.status_code == 403


class TestSuiteRestriction:
    """I5: a key restricted to some suites has its scope on requests addressing one of them, and
    only `read` on any other."""

    def test_every_operation_above_read_honours_a_restriction(
        self,
        api_client: TestClient,
        api_app: FastAPI,
        restricted_key: Callable[..., str],
        bearer: Callable[[str], dict[str, str]],
    ) -> None:
        """The guard that keeps a future endpoint from letting a restricted key out of its suites.

        Every operation a restrictable scope reaches is called on suite `x`, which does not exist,
        with a `manage` key restricted to another suite and with one restricted to `x`. The first
        is refused everywhere, before the missing suite is noticed (I5's order of checks), and the
        second only where no suite is addressed. An endpoint whose suite is not where the
        authorization looks for it fails one or the other.
        """
        elsewhere = bearer(restricted_key(Scope.MANAGE, "other"))
        here = bearer(restricted_key(Scope.MANAGE, "x"))
        restrictable = set(Scope) - set(UNRESTRICTABLE_SCOPES)

        refused_here = set()
        for method, template in operations(api_app, restrictable):
            path = placeholders_filled(template)
            response = api_client.request(method, path, headers=elsewhere)
            assert response.status_code == 403, f"{method} {template}"
            if api_client.request(method, path, headers=here).status_code == 403:
                refused_here.add((method, template))

        assert refused_here == UNRESTRICTED_ONLY

    def test_reads_every_other_suite(
        self,
        api_client: TestClient,
        make_api_suite: Callable[[dict[str, Any]], Any],
        restricted_key: Callable[..., str],
        bearer: Callable[[str], dict[str, str]],
    ) -> None:
        # Exactly what anonymous access gets, which a restriction never takes away.
        make_api_suite(NTS)
        headers = bearer(restricted_key(Scope.MANAGE, "other"))

        assert api_client.get("/api/suites/nts/machines", headers=headers).status_code == 200

    def test_cannot_create_a_suite_even_one_it_names(
        self,
        api_client: TestClient,
        restricted_key: Callable[..., str],
        bearer: Callable[[str], dict[str, str]],
    ) -> None:
        headers = bearer(restricted_key(Scope.MANAGE, "nts"))

        response = api_client.post("/api/suites", json=NTS, headers=headers)

        assert response.status_code == 403
        assert "not restricted" in response.json()["error"]["message"]

    def test_changes_and_deletes_a_suite_it_names(
        self,
        api_client: TestClient,
        make_api_suite: Callable[[dict[str, Any]], Any],
        make_key: Callable[..., str],
        bearer: Callable[[str], dict[str, str]],
    ) -> None:
        make_api_suite(NTS)
        headers = bearer(make_key(Scope.MANAGE, suites=["nts"]))
        patch = {"metrics": {"add": [{"name": "size", "type": "integer"}]}}

        assert api_client.patch("/api/suites/nts/schema", json=patch, headers=headers).is_success
        assert api_client.delete("/api/suites/nts?confirm=true", headers=headers).status_code == 204

    def test_covers_a_suite_created_again_under_its_name(
        self,
        api_client: TestClient,
        make_api_suite: Callable[[dict[str, Any]], Any],
        make_key: Callable[..., str],
        manage: dict[str, str],
        bearer: Callable[[str], dict[str, str]],
    ) -> None:
        # A key names its suites and is not linked to them, so deleting one leaves its name on
        # the key, which then covers whatever suite takes the name next.
        make_api_suite(NTS)
        headers = bearer(make_key(Scope.MANAGE, suites=["nts"]))
        assert api_client.delete("/api/suites/nts?confirm=true", headers=manage).status_code == 204
        make_api_suite(NTS)

        response = api_client.post("/api/suites/nts/machines", json={"name": "m"}, headers=headers)

        assert response.status_code == 201

    @pytest.mark.parametrize(
        ("scope", "path", "says"),
        [
            # Under-scoped wherever it is used: the restriction is beside the point.
            (Scope.SUBMIT, "/api/suites/x/machines", "this API key grants 'submit'"),
            (Scope.MANAGE, "/api/suites/y/machines", "grants it only in: x"),
        ],
    )
    def test_a_403_says_why(
        self,
        api_client: TestClient,
        restricted_key: Callable[..., str],
        bearer: Callable[[str], dict[str, str]],
        scope: Scope,
        path: str,
        says: str,
    ) -> None:
        response = api_client.post(path, json={}, headers=bearer(restricted_key(scope, "x")))

        assert response.status_code == 403
        assert says in response.json()["error"]["message"]


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

        # I5 resolves every request against the database rather than caching the decision, so this
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
    @pytest.mark.parametrize(
        "path", ["/api/openapi.json", "/api/docs", "/healthz", "/llms.txt", "/robots.txt"]
    )
    def test_an_authorization_header_has_no_effect(self, api_client: TestClient, path: str) -> None:
        # I5: no authentication happens on their path at all -- not even for a header that would
        # be a 401 anywhere else under /api/.
        unauthenticated = api_client.get(path)

        for header in ("Basic zzz", f"Bearer {UNKNOWN_TOKEN}", "Bearer"):
            response = api_client.get(path, headers={"Authorization": header})

            assert response.status_code == unauthenticated.status_code == 200, header

    @pytest.mark.parametrize(
        "path",
        ["/api/openapi.json", "/api/docs", "/healthz", "/llms.txt", "/robots.txt", "/suites/nts"],
    )
    def test_a_query_parameter_has_no_effect(self, api_client: TestClient, path: str) -> None:
        # I3's refusal is for the REST API surface, which these are outside of: a proxy busting a
        # cache, or a probe tagging its requests, must not turn them into a 400. Nor must the web
        # UI's own routes, whose query strings carry its state (AR2 "State") -- not exempt from the
        # scope system, but never part of it.
        assert api_client.get(f"{path}?v=1&v=2").status_code == 200


class TestUnknownQueryParameters:
    """I3: a query parameter an endpoint does not take is a 400, as is repeating one it takes once.

    Most of these need no database: the refusal comes before authentication, and so before anything
    that reads one.
    """

    def test_every_scoped_operation_refuses_one_before_authenticating(
        self, client: TestClient, app: FastAPI
    ) -> None:
        # Every operation rather than a sample, because the point is that no endpoint has to opt
        # in. The Authorization header is one I5 answers with 401 everywhere under /api/, so a 400
        # here also shows the order I5 states.
        for method, template in operations(app, set(Scope)):
            path = placeholders_filled(template)
            response = client.request(
                method, f"{path}?bogus=1", headers={"Authorization": "Basic zzz"}
            )

            assert response.status_code == 400, f"{method} {path}"
            assert response.json()["error"]["code"] == "invalid_request"
            assert "'bogus'" in response.json()["error"]["message"]

    def test_names_every_one_and_what_the_endpoint_takes(self, client: TestClient) -> None:
        response = client.get("/api/suites/nts/machines?machnie=linux&serch=x&search=y")

        message = response.json()["error"]["message"]
        assert "'machnie'" in message
        assert "'serch'" in message
        # Then what the caller may have meant.
        assert "'search'" in message
        assert "'tracked'" in message
        assert "body" not in message

    def test_points_an_endpoint_taking_a_body_at_it(self, client: TestClient) -> None:
        # The indicator lookup takes its filters in its body (I2), so a `limit` in the query string
        # was almost certainly meant to be a key of it.
        response = client.post("/api/suites/nts/regressions/indicators/query?limit=5", json={})

        assert response.status_code == 400
        assert "request body" in response.json()["error"]["message"]

    def test_one_without_a_value_is_still_refused(self, client: TestClient) -> None:
        assert client.get(f"{READABLE}?bogus").status_code == 400

    def test_a_single_valued_parameter_given_twice_is_refused(self, client: TestClient) -> None:
        # Rather than answered with the last value, which is what a client repeating `machine=`
        # in the belief that it took several would otherwise silently get.
        response = client.get("/api/suites/nts/runs?machine=a&machine=b")

        assert response.status_code == 400
        assert response.json()["error"]["code"] == "invalid_request"
        assert "'machine'" in response.json()["error"]["message"]

    @pytest.mark.parametrize(
        "annotation",
        [
            str,
            bytes,
            int | None,
            Annotated[str, Query()],
            list[str],
            list[str] | None,
            Annotated[list[str] | None, Query()],
            Sequence[str],
            tuple[str, ...],
            set[str],
            frozenset[str],
            deque[str],
        ],
    )
    def test_takes_several_values_exactly_where_fastapi_reads_them(self, annotation: Any) -> None:
        # A parameter of a type the check thought single-valued would have its repeated values
        # refused although the endpoint reads them all; the other way round, a repeated parameter
        # would be accepted and silently answered with its last value. FastAPI's own classifier is
        # private, which is why this compares against it rather than production code calling it:
        # should FastAPI change it, this is what notices.
        assert _takes_several(annotation) == field_annotation_is_sequence(annotation)


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

    def test_is_recorded_at_most_once_per_interval_for_each_key(
        self,
        api_client: TestClient,
        db_engine: Engine,
        make_key: Callable[..., str],
        read_key: Callable[[str], Any],
        bearer: Callable[[str], dict[str, str]],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """D5 lets these writes be coalesced, which spares every request sharing a key a write."""
        # From 0, as `monotonic()` may be in a freshly booted container: a first use still writes.
        now = 0.0
        monkeypatch.setattr(keys, "monotonic", lambda: now)
        token = make_key(Scope.ADMIN)
        other = make_key(Scope.READ, name="other")
        api_client.get(READABLE, headers=bearer(token))

        # Cleared behind the server's back, so that only a new write can fill it in again.
        with db_engine.begin() as connection:
            connection.execute(
                update(api_key).where(api_key.c.prefix == token[:8]).values(last_used_at=None)
            )
        now += keys.LAST_USED_INTERVAL - 1
        api_client.get(READABLE, headers=bearer(token))
        api_client.get(READABLE, headers=bearer(other))

        assert read_key(token[:8]).last_used_at is None
        assert read_key(other[:8]).last_used_at is not None

        now += 1
        api_client.get(READABLE, headers=bearer(token))

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
        """I5: every endpoint under `/api/` declares the scope it requires.

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

    def test_the_exempt_routes_are_the_specified_ones(self, api_app: FastAPI) -> None:
        # The exemption is an explicit list rather than a consequence of living outside `/api/`,
        # so it is worth failing when something joins it by accident.
        exempt = {
            route.path_format
            for route in iter_routes(api_app.routes)
            if (route.path_format or "").startswith("/api") and required_scope(route) is None
        }

        assert exempt == EXEMPT_API_PATHS

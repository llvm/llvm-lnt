"""The API key endpoints (endpoints.md, Admin).

Authentication itself is `test_auth.py`; what is checked here is what the three endpoints do once
a caller is through it.
"""

from __future__ import annotations

import re
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from fastapi.testclient import TestClient

from conftest import TOKEN_PATTERN
from lnt_v5.scopes import Scope
from lnt_v5.tables import KEY_NAME_MAX_LENGTH

KEYS = "/api/admin/api-keys"

# D5 serializes timestamps as ISO 8601 with a `Z` suffix, never a numeric offset.
UTC_TIMESTAMP = re.compile(r"\A\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z\Z")


@pytest.fixture
def admin(make_key: Callable[..., str], bearer: Callable[[str], dict[str, str]]) -> dict[str, str]:
    return bearer(make_key(Scope.ADMIN, name="the admin key"))


class TestList:
    def test_returns_an_envelope_even_when_there_is_nothing_but_the_caller(
        self, api_client: TestClient, admin: dict[str, str]
    ) -> None:
        # R2: `items` is present and empty rather than absent, and never a bare array.
        body = api_client.get(KEYS, headers=admin).json()

        assert list(body) == ["items"]
        assert [key["name"] for key in body["items"]] == ["the admin key"]

    def test_orders_newest_first_breaking_ties_on_prefix(
        self, api_client: TestClient, admin: dict[str, str], store_key: Callable[..., None]
    ) -> None:
        # `created_at` is immutable, so this order is stable across requests -- which is why
        # endpoints.md picks it over the mutable, approximate `last_used_at`.
        old = datetime(2026, 1, 1, tzinfo=UTC)
        store_key(prefix="bbbbbbbb", key_hash="b" * 64, name="older", created_at=old)
        store_key(prefix="aaaaaaaa", key_hash="c" * 64, name="tied", created_at=old)
        store_key(
            prefix="dddddddd", key_hash="d" * 64, name="newer", created_at=old + timedelta(days=1)
        )

        items = api_client.get(KEYS, headers=admin).json()["items"]

        # The caller's own key is newest of all; the rest fall in created_at order, and the two
        # sharing a timestamp fall in prefix order.
        assert [key["prefix"] for key in items][1:] == ["dddddddd", "aaaaaaaa", "bbbbbbbb"]

    def test_includes_revoked_keys(
        self, api_client: TestClient, admin: dict[str, str], make_key: Callable[..., str]
    ) -> None:
        # Revoking does not delete the row, and the list is where that stays visible.
        doomed = make_key(Scope.SUBMIT, name="doomed")
        api_client.delete(f"{KEYS}/{doomed[:8]}", headers=admin)

        items = api_client.get(KEYS, headers=admin).json()["items"]

        assert {key["prefix"]: key["is_active"] for key in items}[doomed[:8]] is False

    def test_never_exposes_a_token_or_its_hash(
        self, api_client: TestClient, admin: dict[str, str], make_key: Callable[..., str]
    ) -> None:
        token = make_key(Scope.SUBMIT, name="bot")

        response = api_client.get(KEYS, headers=admin)

        assert set(response.json()["items"][0]) == {
            "prefix",
            "name",
            "scope",
            "created_at",
            "last_used_at",
            "is_active",
        }
        assert token not in response.text

    def test_serializes_timestamps_the_way_d5_specifies(
        self, api_client: TestClient, admin: dict[str, str]
    ) -> None:
        # The first request is what gives the caller's own key a `last_used_at` to serialize; the
        # second is the one being inspected.
        api_client.get(KEYS, headers=admin)

        key = api_client.get(KEYS, headers=admin).json()["items"][0]

        assert UTC_TIMESTAMP.match(key["created_at"]), key["created_at"]
        assert UTC_TIMESTAMP.match(key["last_used_at"]), key["last_used_at"]


class TestCreate:
    def test_returns_the_new_key_with_its_token(
        self, api_client: TestClient, admin: dict[str, str]
    ) -> None:
        response = api_client.post(KEYS, headers=admin, json={"name": "bot", "scope": "submit"})

        assert response.status_code == 201
        body = response.json()
        assert body["name"] == "bot"
        assert body["scope"] == "submit"
        assert body["is_active"] is True
        assert body["last_used_at"] is None
        assert TOKEN_PATTERN.match(body["token"])
        assert body["prefix"] == body["token"][:8]

    def test_the_token_it_returns_authenticates(
        self,
        api_client: TestClient,
        admin: dict[str, str],
        bearer: Callable[[str], dict[str, str]],
    ) -> None:
        token = api_client.post(KEYS, headers=admin, json={"name": "bot", "scope": "read"}).json()[
            "token"
        ]

        assert api_client.get("/api", headers=bearer(token)).status_code == 200

    def test_sets_no_location_header(self, api_client: TestClient, admin: dict[str, str]) -> None:
        # Deliberate: there is no per-key detail route, so the list is the only way to read a key
        # back and there is nothing for a Location to point at.
        response = api_client.post(KEYS, headers=admin, json={"name": "bot", "scope": "read"})

        assert "Location" not in response.headers

    def test_the_token_is_shown_only_once(
        self, api_client: TestClient, admin: dict[str, str]
    ) -> None:
        token = api_client.post(KEYS, headers=admin, json={"name": "bot", "scope": "read"}).json()[
            "token"
        ]

        assert token not in api_client.get(KEYS, headers=admin).text

    def test_two_keys_may_share_a_name(self, api_client: TestClient, admin: dict[str, str]) -> None:
        # `name` is a label rather than an identifier.
        first = api_client.post(KEYS, headers=admin, json={"name": "bot", "scope": "read"})
        second = api_client.post(KEYS, headers=admin, json={"name": "bot", "scope": "read"})

        assert first.status_code == second.status_code == 201
        assert first.json()["prefix"] != second.json()["prefix"]

    @pytest.mark.parametrize(
        ("body", "why"),
        [
            ({"scope": "read"}, "no name"),
            ({"name": "", "scope": "read"}, "an empty name"),
            ({"name": "x" * (KEY_NAME_MAX_LENGTH + 1), "scope": "read"}, "an oversized name"),
            ({"name": "bot"}, "no scope"),
            ({"name": "bot", "scope": "root"}, "a scope outside R5's five"),
            ({"name": "bot", "scope": "READ"}, "a scope in the wrong case"),
            ({"name": "bot", "scope": None}, "a null scope"),
        ],
    )
    def test_rejects_a_bad_body(
        self, api_client: TestClient, admin: dict[str, str], body: dict[str, Any], why: str
    ) -> None:
        response = api_client.post(KEYS, headers=admin, json=body)

        assert response.status_code == 400, why
        assert response.json()["error"]["code"] == "invalid_request"

    def test_accepts_a_name_at_the_limit(
        self, api_client: TestClient, admin: dict[str, str]
    ) -> None:
        name = "x" * KEY_NAME_MAX_LENGTH

        response = api_client.post(KEYS, headers=admin, json={"name": name, "scope": "read"})

        assert response.status_code == 201
        assert response.json()["name"] == name


class TestRevoke:
    def test_deactivates_the_key_without_deleting_it(
        self,
        api_client: TestClient,
        admin: dict[str, str],
        make_key: Callable[..., str],
        read_key: Callable[[str], Any],
    ) -> None:
        prefix = make_key(Scope.SUBMIT, name="doomed")[:8]

        assert api_client.delete(f"{KEYS}/{prefix}", headers=admin).status_code == 204

        assert read_key(prefix).is_active is False

    def test_is_idempotent(
        self, api_client: TestClient, admin: dict[str, str], make_key: Callable[..., str]
    ) -> None:
        # A retried revocation is not an error: it destroys nothing and the end state is the same.
        prefix = make_key(Scope.SUBMIT, name="doomed")[:8]
        api_client.delete(f"{KEYS}/{prefix}", headers=admin)

        assert api_client.delete(f"{KEYS}/{prefix}", headers=admin).status_code == 204

    def test_reports_404_for_an_unknown_prefix(
        self, api_client: TestClient, admin: dict[str, str]
    ) -> None:
        response = api_client.delete(f"{KEYS}/nosuchpr", headers=admin)

        assert response.status_code == 404
        assert response.json()["error"]["code"] == "not_found"

    def test_reports_404_when_given_a_whole_token(
        self, api_client: TestClient, admin: dict[str, str], make_key: Callable[..., str]
    ) -> None:
        # endpoints.md calls this case out: keys are addressed by prefix, and no key has a
        # 64-character one, so passing the token is a miss rather than a malformed request.
        token = make_key(Scope.SUBMIT, name="doomed")

        assert api_client.delete(f"{KEYS}/{token}", headers=admin).status_code == 404

    def test_a_key_may_revoke_itself(
        self, api_client: TestClient, make_key: Callable[..., str], bearer: Callable[..., Any]
    ) -> None:
        # No special case for the caller's own key, nor for the last admin key: an operator's
        # ability to revoke a leaked key must not depend on which key leaked.
        token = make_key(Scope.ADMIN)

        assert api_client.delete(f"{KEYS}/{token[:8]}", headers=bearer(token)).status_code == 204
        assert api_client.get(KEYS, headers=bearer(token)).status_code == 401

"""The authentication endpoint (E12).

How a credential is parsed and judged is `test_auth.py`; what is checked here is what the endpoint
reports about the key once a request is through that.
"""

from __future__ import annotations

from collections.abc import Callable

import pytest
from fastapi.testclient import TestClient

from conftest import code_of
from lnt_v5.routes.auth import AUTH_PATH
from lnt_v5.scopes import Scope

KEYS = "/api/admin/api-keys"


def test_reports_no_key_for_an_anonymous_caller(api_client: TestClient) -> None:
    response = api_client.get(AUTH_PATH)

    assert response.status_code == 200
    assert response.json() == {"key": None}


@pytest.mark.parametrize("scope", list(Scope))
def test_reports_the_scope_of_any_key(
    api_client: TestClient,
    make_key: Callable[..., str],
    bearer: Callable[[str], dict[str, str]],
    scope: Scope,
) -> None:
    # `read` included: the endpoint exists so that any key can learn its own scope.
    token = make_key(scope)

    response = api_client.get(AUTH_PATH, headers=bearer(token))

    assert response.json()["key"]["scope"] == scope.value


def test_answers_with_the_key_object_the_admin_list_gives(
    api_client: TestClient, make_key: Callable[..., str], bearer: Callable[[str], dict[str, str]]
) -> None:
    # E12 reuses E11's key fields rather than defining a shape of its own -- which also shows that
    # nothing internal, such as the row id or the token, leaks into it.
    token = make_key(Scope.ADMIN)
    make_key(Scope.READ, name="another key")

    own = api_client.get(AUTH_PATH, headers=bearer(token)).json()["key"]
    listed = api_client.get(KEYS, headers=bearer(token)).json()["items"]
    (same,) = [key for key in listed if key["prefix"] == token[:8]]

    # The list request is a use of the key, which the endpoint above had not yet seen.
    assert own == {**same, "last_used_at": own["last_used_at"]}


def test_reports_last_used_at_as_it_stood_before_the_request(
    api_client: TestClient, make_key: Callable[..., str], bearer: Callable[[str], dict[str, str]]
) -> None:
    # Stricter than E12, which only says the value may predate the request: this server reads the
    # key before recording its use, so the first request still sees null.
    token = make_key(Scope.READ)

    first = api_client.get(AUTH_PATH, headers=bearer(token)).json()["key"]
    second = api_client.get(AUTH_PATH, headers=bearer(token)).json()["key"]

    assert first["last_used_at"] is None
    assert second["last_used_at"] is not None


def test_refuses_a_token_that_does_not_authenticate(api_client: TestClient) -> None:
    # What makes the endpoint a token check: an unusable token is not reported as anonymous, it is
    # refused like on any other endpoint (I5). `test_auth.py` covers the cases one by one.
    response = api_client.get(AUTH_PATH, headers={"Authorization": f"Bearer {'f' * 64}"})

    assert response.status_code == 401
    assert code_of(response) == "unauthorized"

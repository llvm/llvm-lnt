"""The branch list (E3): the branches of a suite's commits with an ordinal.

Driven over the real application and a real database, since what is worth checking is what the
query asks of PostgreSQL: which commits count, and the order, by code point whatever the
database's collation.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

import pytest
from fastapi.testclient import TestClient

from conftest import code_of
from lnt_v5.routes.branches import BRANCHES_PATH
from lnt_v5.routes.commits import COMMITS_PATH
from lnt_v5.suites.tables import SuiteTables

BRANCHES = BRANCHES_PATH.format(project="nts", suite="nts")
COMMITS = COMMITS_PATH.format(project="nts", suite="nts")


@pytest.fixture
def suite(make_api_suite: Callable[[dict[str, Any]], SuiteTables]) -> SuiteTables:
    return make_api_suite({"name": "nts", "metrics": [{"name": "execution_time", "type": "real"}]})


@pytest.fixture
def create(
    api_client: TestClient, manage: dict[str, str], suite: SuiteTables
) -> Callable[..., None]:
    """Create a commit, with the ordinal and branch given, if any."""

    def post(value: str, **body: Any) -> None:
        response = api_client.post(COMMITS, json={"value": value, **body}, headers=manage)
        assert response.status_code == 201, response.text

    return post


def branches_in(api_client: TestClient) -> list[str | None]:
    response = api_client.get(BRANCHES)
    assert response.status_code == 200, response.text
    return [item["name"] for item in response.json()["items"]]


def test_is_an_empty_envelope_for_a_suite_without_commits(
    api_client: TestClient, suite: SuiteTables
) -> None:
    assert api_client.get(BRANCHES).json() == {"items": []}


def test_lists_null_alone_when_no_ordered_commit_has_a_branch(
    api_client: TestClient, create: Callable[..., Any]
) -> None:
    create("n1", ordinal=1)
    create("n2", ordinal=2)
    # Without an ordinal, a commit's branch is not listed.
    create("unordered", branch="main")

    assert branches_in(api_client) == [None]


def test_lists_null_first_then_the_names_by_code_point(
    api_client: TestClient, create: Callable[..., Any]
) -> None:
    # Names a locale's collation orders otherwise, ignoring punctuation or case, each on a few
    # commits, created out of order. Only a database whose collation is such a locale's tells the
    # code-point order apart from the collation's: on one whose collation orders by code point, as
    # the C locale and musl's (Alpine's) do, this passes whatever the order asked for.
    for i, branch in enumerate(["ab", "a_b", "Z", "a-b", "a", "ab", "Z", "release/19.x"]):
        create(f"c{i}", ordinal=i, branch=branch)
    create("n", ordinal=1)

    assert branches_in(api_client) == [None, "Z", "a", "a-b", "a_b", "ab", "release/19.x"]


def test_leaves_out_null_when_every_ordered_commit_has_a_branch(
    api_client: TestClient, create: Callable[..., Any]
) -> None:
    create("m1", ordinal=1, branch="main")
    create("unordered")

    assert branches_in(api_client) == ["main"]


def test_follows_a_branch_change(
    api_client: TestClient, manage: dict[str, str], create: Callable[..., Any]
) -> None:
    create("m1", ordinal=1, branch="main")
    moved = api_client.patch(f"{COMMITS}/m1", json={"branch": "release"}, headers=manage)
    assert moved.status_code == 200, moved.text

    assert branches_in(api_client) == ["release"]


def test_needs_no_credential(api_client: TestClient, suite: SuiteTables) -> None:
    assert api_client.get(BRANCHES).status_code == 200


def test_is_a_404_for_a_suite_that_does_not_exist(api_client: TestClient) -> None:
    response = api_client.get(BRANCHES_PATH.format(project="nts", suite="nope"))

    assert response.status_code == 404
    assert code_of(response) == "not_found"


def test_refuses_a_filter(api_client: TestClient, suite: SuiteTables) -> None:
    response = api_client.get(f"{BRANCHES}?machine=linux")

    assert response.status_code == 400
    assert code_of(response) == "invalid_request"

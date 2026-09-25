"""The commit endpoints (endpoints.md, Commits).

Driven over the real application and a real database. What is interesting here is mostly what
PostgreSQL ends up doing: the unique ordinal that produces R4's `ordinal_conflict` (D11), the
neighbour lookups that replace a linked list, a cascade that reaches runs and their samples and
profiles, and the foreign key that refuses to let a regression's commit go.

The cursor mechanism itself is covered by `test_querying.py`; what this module checks about it is
that this endpoint wires it up -- the right order, the filters surviving a page boundary, and an
opaque token over the wire.
"""

from __future__ import annotations

from collections.abc import Callable
from datetime import UTC, datetime
from typing import Any
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import Engine, insert, select, text

from conftest import code_of, walk_pages
from introspection import row_count
from lnt_v5.querying import MAX_LIMIT
from lnt_v5.routes.commits import COMMITS_PATH
from lnt_v5.routes.suites import SUITES_PATH
from lnt_v5.scopes import Scope
from lnt_v5.suites.tables import SuiteTables

COMMITS = COMMITS_PATH.format(testsuite="nts")

NTS: dict[str, Any] = {
    "name": "nts",
    "metrics": [{"name": "execution_time", "type": "real"}],
    "machine_fields": [{"name": "hardware", "type": "text", "searchable": True}],
    "commit_fields": [
        {"name": "git_sha", "type": "text", "searchable": True, "display": True},
        {"name": "author", "type": "text", "searchable": True},
        # Deliberately not searchable, and deliberately not text: D9 covers neither.
        {"name": "commit_message", "type": "text"},
        {"name": "commit_timestamp", "type": "datetime"},
    ],
}

EVERY_FIELD = {field["name"]: None for field in NTS["commit_fields"]}

# What endpoints.md scopes above `read`, with a body each accepts. POST and PATCH need *different*
# scopes here, which is what makes this family worth checking one operation at a time.
WRITES = [
    ("post", COMMITS, {"value": "new"}, Scope.SUBMIT),
    ("patch", f"{COMMITS}/abc", {"ordinal": 5}, Scope.MANAGE),
    ("delete", f"{COMMITS}/abc", None, Scope.MANAGE),
]


@pytest.fixture
def suite(make_api_suite: Callable[[dict[str, Any]], SuiteTables]) -> SuiteTables:
    """The `nts` suite, created through the API, with its tables for reading the database back."""
    return make_api_suite(NTS)


@pytest.fixture
def create(
    api_client: TestClient, manage: dict[str, str], suite: SuiteTables
) -> Callable[..., Any]:
    """POST a commit. Named keys go straight into the entity object."""

    def post(value: str = "abc", **body: Any) -> Any:
        return api_client.post(COMMITS, json={"value": value, **body}, headers=manage)

    return post


@pytest.fixture
def patch(api_client: TestClient, manage: dict[str, str]) -> Callable[..., Any]:
    def send(value: str, body: dict[str, Any]) -> Any:
        return api_client.patch(f"{COMMITS}/{value}", json=body, headers=manage)

    return send


@pytest.fixture
def add_run(db_engine: Engine, suite: SuiteTables) -> Callable[..., str]:
    """Attach a run to an existing commit, optionally with a profile on it."""

    def add(commit: str, machine: str = "linux", *, profile: bool = False) -> str:
        with db_engine.begin() as connection:
            machine_id = connection.execute(
                select(suite.machine.c.id).where(suite.machine.c.name == machine)
            ).scalar_one_or_none()
            if machine_id is None:
                machine_id = connection.execute(
                    insert(suite.machine).values(name=machine).returning(suite.machine.c.id)
                ).scalar_one()
            commit_id = connection.execute(
                select(suite.commit.c.id).where(suite.commit.c.commit == commit)
            ).scalar_one()
            run = str(uuid4())
            run_id = connection.execute(
                insert(suite.run)
                .values(
                    uuid=run,
                    machine_id=machine_id,
                    commit_id=commit_id,
                    submitted_at=datetime(2026, 4, 1, 12, 0, tzinfo=UTC),
                )
                .returning(suite.run.c.id)
            ).scalar_one()
            test_id = connection.execute(
                select(suite.test.c.id).where(suite.test.c.name == "t")
            ).scalar_one_or_none()
            if test_id is None:
                test_id = connection.execute(
                    insert(suite.test).values(name="t").returning(suite.test.c.id)
                ).scalar_one()
            connection.execute(
                insert(suite.sample).values(run_id=run_id, test_id=test_id, execution_time=1.5)
            )
            if profile:
                connection.execute(
                    insert(suite.profile).values(
                        uuid=str(uuid4()), run_id=run_id, test_id=test_id, data=b"\x02"
                    )
                )
        return run

    return add


def values_in(response: Any) -> list[str]:
    return [item["value"] for item in response.json()["items"]]


def page(api_client: TestClient, query: str = "") -> Any:
    return api_client.get(f"{COMMITS}?{query}")


def walk(api_client: TestClient, query: str = "") -> list[str]:
    """Every commit the list serves, following cursors to the end."""
    return [item["value"] for item in walk_pages(api_client, COMMITS, query)]


class TestList:
    def test_is_a_cursor_envelope_even_when_nothing_matches(
        self, api_client: TestClient, suite: SuiteTables
    ) -> None:
        response = page(api_client)

        assert response.status_code == 200
        # R2: `items` present and empty, and a `cursor` rather than a `total` -- this list is
        # unbounded, so it is cursor-paginated and carries no count.
        assert response.json() == {"items": [], "cursor": {"next": None, "previous": None}}

    def test_is_ordered_by_first_sighting_by_default(
        self, api_client: TestClient, create: Callable[..., Any]
    ) -> None:
        # endpoints.md: the default is the internal id, which is the order the server first saw
        # each commit -- deliberately not the ordinal order.
        create("zebra", ordinal=30)
        create("alpha", ordinal=10)
        create("middle", ordinal=20)

        assert values_in(page(api_client)) == ["zebra", "alpha", "middle"]

    def test_sorts_by_ordinal(self, api_client: TestClient, create: Callable[..., Any]) -> None:
        create("zebra", ordinal=30)
        create("alpha", ordinal=10)

        assert values_in(page(api_client, "sort=ordinal")) == ["alpha", "zebra"]
        assert values_in(page(api_client, "sort=-ordinal")) == ["zebra", "alpha"]

    @pytest.mark.parametrize("sort", ["ordinal", "-ordinal"])
    def test_sorting_by_ordinal_excludes_the_commits_that_have_none(
        self, api_client: TestClient, create: Callable[..., Any], sort: str
    ) -> None:
        # endpoints.md: both directions exclude them, because they have no position in that order.
        create("ordered", ordinal=1)
        create("unordered")

        assert values_in(page(api_client, f"sort={sort}")) == ["ordered"]

    def test_keeps_the_commits_with_no_ordinal_when_not_sorting_by_one(
        self, api_client: TestClient, create: Callable[..., Any]
    ) -> None:
        create("ordered", ordinal=1)
        create("unordered")

        assert values_in(page(api_client)) == ["ordered", "unordered"]

    def test_refuses_a_sort_field_it_does_not_offer(
        self, api_client: TestClient, suite: SuiteTables
    ) -> None:
        response = page(api_client, "sort=value")

        assert response.status_code == 400
        assert code_of(response) == "invalid_request"

    def test_carries_the_detail_object_without_its_neighbours(
        self, api_client: TestClient, create: Callable[..., Any]
    ) -> None:
        create("abc", ordinal=1, fields={"git_sha": "abc123"})

        detail = api_client.get(f"{COMMITS}/abc").json()

        assert page(api_client).json()["items"] == [
            {key: value for key, value in detail.items() if key not in ("previous", "next")}
        ]

    def test_is_404_for_a_suite_that_is_not_there(self, api_client: TestClient) -> None:
        response = api_client.get(f"{SUITES_PATH}/nope/commits")

        assert response.status_code == 404
        assert code_of(response) == "not_found"


class TestListSearch:
    @pytest.fixture(autouse=True)
    def commits(self, create: Callable[..., Any], patch: Callable[..., Any]) -> None:
        create("abc123", fields={"git_sha": "deadbeef", "author": "Jane", "commit_message": "Xeon"})
        create("def456", fields={"git_sha": "cafebabe", "author": "Ashok"})
        patch("def456", {"tag": "release-18.1"})

    def test_matches_the_commit_value(self, api_client: TestClient) -> None:
        assert values_in(page(api_client, "search=abc")) == ["abc123"]

    def test_matches_the_tag(self, api_client: TestClient) -> None:
        # D9 always covers the tag, alongside the commit value and the searchable fields.
        assert values_in(page(api_client, "search=release")) == ["def456"]

    def test_matches_a_searchable_field(self, api_client: TestClient) -> None:
        assert values_in(page(api_client, "search=deadbeef")) == ["abc123"]

    def test_is_case_insensitive(self, api_client: TestClient) -> None:
        assert values_in(page(api_client, "search=JaNe")) == ["abc123"]

    def test_is_a_substring_match_rather_than_a_prefix(self, api_client: TestClient) -> None:
        assert values_in(page(api_client, "search=beef")) == ["abc123"]

    def test_ignores_a_field_that_is_not_searchable(self, api_client: TestClient) -> None:
        # `commit_message` is declared but not searchable, and `Xeon` is only in it.
        assert values_in(page(api_client, "search=Xeon")) == []

    def test_treats_a_wildcard_in_the_term_literally(
        self, api_client: TestClient, create: Callable[..., Any]
    ) -> None:
        create("a%b")
        create("axb")

        assert values_in(api_client.get(COMMITS, params={"search": "a%b"})) == ["a%b"]


class TestListMachineFilter:
    @pytest.fixture(autouse=True)
    def commits(self, create: Callable[..., Any], add_run: Callable[..., str]) -> None:
        create("on-linux")
        create("on-darwin")
        create("nowhere")
        add_run("on-linux", "linux")
        add_run("on-darwin", "darwin")

    def test_keeps_only_commits_with_a_run_on_that_machine(self, api_client: TestClient) -> None:
        assert values_in(page(api_client, "machine=linux")) == ["on-linux"]

    def test_is_404_for_a_machine_that_is_not_there(self, api_client: TestClient) -> None:
        # R3 makes an unknown `machine=` an error, unlike an unknown `commit=`.
        response = page(api_client, "machine=nope")

        assert response.status_code == 404
        assert code_of(response) == "not_found"


class TestListHasProfilesFilter:
    @pytest.fixture(autouse=True)
    def commits(self, create: Callable[..., Any], add_run: Callable[..., str]) -> None:
        create("profiled")
        create("bare")
        create("runless")
        add_run("profiled", "linux", profile=True)
        add_run("bare", "linux")

    def test_omitting_it_returns_both(self, api_client: TestClient) -> None:
        assert values_in(page(api_client)) == ["profiled", "bare", "runless"]

    def test_keeps_only_commits_with_profile_data(self, api_client: TestClient) -> None:
        assert values_in(page(api_client, "has_profiles=true")) == ["profiled"]

    def test_keeps_the_commits_with_no_runs_at_all_when_false(self, api_client: TestClient) -> None:
        # A commit with no runs has no run carrying profile data, so it belongs on this side.
        assert values_in(page(api_client, "has_profiles=false")) == ["bare", "runless"]

    def test_is_scoped_to_the_machine_filter(
        self, api_client: TestClient, create: Callable[..., Any], add_run: Callable[..., str]
    ) -> None:
        # endpoints.md: combined with `machine=`, only runs on that machine are considered. This
        # commit is profiled on linux and bare on darwin, so it is on a different side of the
        # filter depending on which machine is asked about.
        create("mixed")
        add_run("mixed", "linux", profile=True)
        add_run("mixed", "darwin")

        assert values_in(page(api_client, "machine=linux&has_profiles=true")) == [
            "profiled",
            "mixed",
        ]
        assert values_in(page(api_client, "machine=darwin&has_profiles=false")) == ["mixed"]

    def test_refuses_a_value_that_is_not_a_boolean(self, api_client: TestClient) -> None:
        assert page(api_client, "has_profiles=maybe").status_code == 400


class TestListPagination:
    @pytest.fixture(autouse=True)
    def commits(self, create: Callable[..., Any]) -> None:
        for index in range(5):
            create(f"c{index}", ordinal=(5 - index) * 10)

    def test_serves_one_page_at_a_time(self, api_client: TestClient) -> None:
        response = page(api_client, "limit=2")

        assert values_in(response) == ["c0", "c1"]
        assert response.json()["cursor"]["next"] is not None
        # R2: forward-only, so `previous` is always null.
        assert response.json()["cursor"]["previous"] is None

    @pytest.mark.parametrize("limit", [1, 2, 3, 5])
    def test_pages_cover_every_commit_exactly_once(
        self, api_client: TestClient, limit: int
    ) -> None:
        assert walk(api_client, f"limit={limit}") == ["c0", "c1", "c2", "c3", "c4"]

    def test_pages_the_ordinal_order_too(self, api_client: TestClient) -> None:
        assert walk(api_client, "limit=2&sort=ordinal") == ["c4", "c3", "c2", "c1", "c0"]
        assert walk(api_client, "limit=2&sort=-ordinal") == ["c0", "c1", "c2", "c3", "c4"]

    def test_the_filters_survive_a_page_boundary(
        self, api_client: TestClient, create: Callable[..., Any]
    ) -> None:
        # The cursor resumes the same query, so a filter must not be dropped on the second page --
        # which only shows if the filter excludes something and the walk crosses a boundary.
        for index in range(3):
            create(f"other{index}")

        assert walk(api_client, "limit=2&search=c") == ["c0", "c1", "c2", "c3", "c4"]

    def test_resumes_after_a_deleted_row(
        self, api_client: TestClient, manage: dict[str, str]
    ) -> None:
        cursor = page(api_client, "limit=2").json()["cursor"]["next"]
        assert api_client.delete(f"{COMMITS}/c1", headers=manage).status_code == 204

        assert values_in(page(api_client, f"limit=2&cursor={cursor}")) == ["c2", "c3"]

    def test_serves_a_commit_created_after_the_cursor_was_issued(
        self, api_client: TestClient, create: Callable[..., Any]
    ) -> None:
        cursor = page(api_client, "limit=4").json()["cursor"]["next"]
        create("c5", ordinal=5)

        assert values_in(page(api_client, f"limit=4&cursor={cursor}")) == ["c4", "c5"]

    def test_the_cursor_is_opaque_and_survives_a_query_string(self, api_client: TestClient) -> None:
        # R2: clients must not parse a cursor, and it travels as a query parameter, so it must
        # need no escaping. What it is *made* of is `test_querying.py`'s business.
        cursor = page(api_client, "limit=2").json()["cursor"]["next"]

        assert cursor not in ("c1", "2", "40")
        assert all(character.isalnum() or character in "-_" for character in cursor)

    @pytest.mark.parametrize(
        ("query", "reason"),
        [
            ("limit=2&cursor=nonsense", "not a cursor at all"),
            ("limit=2&sort=ordinal&cursor={cursor}", "issued for a different sort order"),
        ],
    )
    def test_refuses_a_cursor_it_did_not_issue(
        self, api_client: TestClient, query: str, reason: str
    ) -> None:
        cursor = page(api_client, "limit=2").json()["cursor"]["next"]

        response = page(api_client, query.format(cursor=cursor))

        assert response.status_code == 400, reason
        assert code_of(response) == "invalid_request"

    def test_refuses_a_cursor_issued_by_another_suite(
        self, api_client: TestClient, manage: dict[str, str]
    ) -> None:
        api_client.post(SUITES_PATH, json={**NTS, "name": "compile"}, headers=manage)
        cursor = page(api_client, "limit=2").json()["cursor"]["next"]

        elsewhere = api_client.get(
            f"{COMMITS_PATH.format(testsuite='compile')}?limit=2&cursor={cursor}"
        )

        assert elsewhere.status_code == 400

    @pytest.mark.parametrize("query", ["limit=0", "limit=10001"])
    def test_refuses_a_page_it_cannot_serve(self, api_client: TestClient, query: str) -> None:
        assert page(api_client, query).status_code == 400


class TestCreate:
    def test_returns_the_created_commit_and_where_to_find_it(
        self, api_client: TestClient, create: Callable[..., Any]
    ) -> None:
        response = create("abc")

        assert response.status_code == 201
        assert response.headers["Location"] == f"{COMMITS}/abc"
        assert api_client.get(response.headers["Location"]).json() == response.json()

    def test_defaults_to_unordered_untagged_and_empty(self, create: Callable[..., Any]) -> None:
        assert create("abc").json() == {
            "value": "abc",
            "ordinal": None,
            "tag": None,
            "fields": EVERY_FIELD,
            "previous": None,
            "next": None,
        }

    def test_accepts_an_ordinal(self, create: Callable[..., Any]) -> None:
        assert create("abc", ordinal=42).json()["ordinal"] == 42

    def test_stores_declared_fields(self, create: Callable[..., Any]) -> None:
        response = create(
            "abc",
            fields={
                "git_sha": "abc123",
                "author": "Jane",
                "commit_timestamp": "2026-04-15T16:30:00+02:00",
            },
        )

        assert response.json()["fields"] == {
            "git_sha": "abc123",
            "author": "Jane",
            "commit_message": None,
            # D5: stored as UTC and serialized with a `Z` suffix, whatever offset it arrived in.
            "commit_timestamp": "2026-04-15T14:30:00Z",
        }

    def test_refuses_a_value_already_taken(self, create: Callable[..., Any]) -> None:
        create("abc")

        response = create("abc")

        assert response.status_code == 409
        assert code_of(response) == "duplicate"

    def test_refuses_an_ordinal_another_commit_holds(self, create: Callable[..., Any]) -> None:
        # R4 splits this from `duplicate` deliberately: a submitting bot retries a duplicate with a
        # fresh value, whereas this means its view of the commit order is wrong.
        create("abc", ordinal=7)

        response = create("def", ordinal=7)

        assert response.status_code == 409
        assert code_of(response) == "ordinal_conflict"

    @pytest.mark.parametrize(
        ("ordinal", "reason"),
        [
            ("5", "a stringified integer"),
            (True, "a boolean, which Python would otherwise read as 1"),
            (5.5, "a number with a fractional part"),
            (2**31, "beyond what D5's INTEGER column can hold"),
            (-(2**31) - 1, "below what D5's INTEGER column can hold"),
        ],
    )
    def test_refuses_an_ordinal_that_is_not_one(
        self, create: Callable[..., Any], ordinal: Any, reason: str
    ) -> None:
        # D3's typing applies to the built-in attributes beside `fields`, not only to the declared
        # ones (D7). The out-of-range cases matter twice over: unchecked, the column's own range
        # error is a `DataError` rather than an integrity failure, so nothing would attribute it
        # and the caller would get a 500 for a value it supplied.
        response = create("abc", ordinal=ordinal)

        assert response.status_code == 400, reason
        assert code_of(response) == "invalid_request"

    def test_reads_an_ordinal_serialized_through_a_float(self, create: Callable[..., Any]) -> None:
        # D3: a producer that serializes through a float writes an integer as `42.0`, and reading
        # it as 42 loses nothing.
        assert create("abc", ordinal=42.0).json()["ordinal"] == 42

    def test_refuses_a_tag(self, create: Callable[..., Any]) -> None:
        # D7: a tag is editorial and applied after the fact, so PATCH is the only way to set one.
        response = create("abc", tag="release-18.1")

        assert response.status_code == 400
        assert code_of(response) == "invalid_request"

    def test_refuses_an_undeclared_field(self, create: Callable[..., Any]) -> None:
        response = create("abc", fields={"branch": "main"})

        assert response.status_code == 400
        assert code_of(response) == "invalid_request"

    def test_refuses_a_field_value_that_is_not_the_declared_type(
        self, create: Callable[..., Any]
    ) -> None:
        assert create("abc", fields={"commit_timestamp": 1776000000}).status_code == 400

    @pytest.mark.parametrize("value", ["a/b", ".", ".."])
    def test_refuses_a_value_no_url_could_address(
        self, create: Callable[..., Any], value: str
    ) -> None:
        # R1: accepting one would create a commit no URL can reach, and hand back a `Location`
        # header that answers 404.
        response = create(value)

        assert response.status_code == 400
        assert code_of(response) == "invalid_request"

    def test_the_location_it_reports_is_encoded_and_resolves(
        self, api_client: TestClient, create: Callable[..., Any]
    ) -> None:
        response = create("release 18.1")

        assert response.headers["Location"] == f"{COMMITS}/release%2018.1"
        assert api_client.get(response.headers["Location"]).json() == response.json()

    @pytest.mark.parametrize("body", [{}, {"value": ""}, {"value": "x", "nonsense": 1}])
    def test_refuses_a_body_that_does_not_validate(
        self, api_client: TestClient, manage: dict[str, str], suite: SuiteTables, body: Any
    ) -> None:
        assert api_client.post(COMMITS, json=body, headers=manage).status_code == 400

    def test_is_404_for_a_suite_that_is_not_there(
        self, api_client: TestClient, manage: dict[str, str]
    ) -> None:
        response = api_client.post(
            f"{SUITES_PATH}/nope/commits", json={"value": "abc"}, headers=manage
        )

        assert response.status_code == 404


class TestNeighbours:
    """`previous` and `next`, which D11 computes by asking for the nearest ordinal."""

    @pytest.fixture(autouse=True)
    def commits(self, create: Callable[..., Any]) -> None:
        create("first", ordinal=10)
        create("middle", ordinal=20)
        create("last", ordinal=30)
        create("floating")

    def detail(self, api_client: TestClient, value: str) -> Any:
        return api_client.get(f"{COMMITS}/{value}").json()

    def test_names_the_commits_either_side(self, api_client: TestClient) -> None:
        body = self.detail(api_client, "middle")

        assert body["previous"]["value"] == "first"
        assert body["next"]["value"] == "last"

    def test_a_neighbour_is_a_commit_without_neighbours_of_its_own(
        self, api_client: TestClient
    ) -> None:
        # endpoints.md: each is a commit object without its own previous/next, so the chain stops
        # after one step.
        neighbour = self.detail(api_client, "middle")["previous"]

        assert set(neighbour) == {"value", "ordinal", "tag", "fields"}
        assert neighbour["ordinal"] == 10

    def test_both_ends_of_the_range_have_one_neighbour(self, api_client: TestClient) -> None:
        assert self.detail(api_client, "first")["previous"] is None
        assert self.detail(api_client, "first")["next"]["value"] == "middle"
        assert self.detail(api_client, "last")["next"] is None

    def test_a_commit_with_no_ordinal_has_no_neighbours(self, api_client: TestClient) -> None:
        body = self.detail(api_client, "floating")

        assert body["previous"] is None and body["next"] is None

    def test_commits_with_no_ordinal_are_skipped_as_neighbours(
        self, api_client: TestClient
    ) -> None:
        # `floating` sits between `first` and `middle` by insertion order and nowhere at all by
        # ordinal, so it must not appear as anyone's neighbour.
        assert self.detail(api_client, "first")["next"]["value"] == "middle"

    def test_the_nearest_ordinal_wins_rather_than_the_adjacent_one(
        self, api_client: TestClient, create: Callable[..., Any]
    ) -> None:
        create("inserted", ordinal=25)

        assert self.detail(api_client, "last")["previous"]["value"] == "inserted"

    def test_follows_an_ordinal_change_with_no_relinking(
        self, api_client: TestClient, patch: Callable[..., Any]
    ) -> None:
        # D11 computes neighbours by query rather than by a linked list, so moving a commit needs
        # nothing else updated.
        patch("last", {"ordinal": 5})

        assert self.detail(api_client, "first")["previous"]["value"] == "last"
        assert self.detail(api_client, "first")["next"]["value"] == "middle"


class TestDetail:
    def test_is_404_for_a_commit_that_is_not_there(
        self, api_client: TestClient, suite: SuiteTables
    ) -> None:
        response = api_client.get(f"{COMMITS}/nope")

        assert response.status_code == 404
        assert code_of(response) == "not_found"

    def test_is_404_for_a_suite_that_is_not_there(self, api_client: TestClient) -> None:
        assert api_client.get(f"{SUITES_PATH}/nope/commits/abc").status_code == 404

    def test_is_not_shadowed_by_the_spa_catch_all(
        self, api_client: TestClient, create: Callable[..., Any]
    ) -> None:
        create("abc")

        assert "<title>LNT</title>" not in api_client.get(f"{COMMITS}/abc").text


class TestUpdate:
    def test_sets_an_ordinal(self, create: Callable[..., Any], patch: Callable[..., Any]) -> None:
        create("abc")

        response = patch("abc", {"ordinal": 42})

        assert response.status_code == 200
        assert response.json()["ordinal"] == 42

    def test_changes_an_ordinal_that_is_already_set(
        self, create: Callable[..., Any], patch: Callable[..., Any]
    ) -> None:
        # D11: PATCH is the only way to change one once set.
        create("abc", ordinal=1)

        assert patch("abc", {"ordinal": 2}).json()["ordinal"] == 2

    def test_sets_a_tag(self, create: Callable[..., Any], patch: Callable[..., Any]) -> None:
        create("abc")

        assert patch("abc", {"tag": "release-18.1"}).json()["tag"] == "release-18.1"

    def test_several_commits_may_share_a_tag(
        self, create: Callable[..., Any], patch: Callable[..., Any]
    ) -> None:
        create("abc")
        create("def")
        patch("abc", {"tag": "release-18.1"})

        assert patch("def", {"tag": "release-18.1"}).status_code == 200

    def test_refuses_a_tag_carrying_a_nul_character(
        self, create: Callable[..., Any], patch: Callable[..., Any]
    ) -> None:
        # D3: PostgreSQL stores no `text` value holding one, and reports that as a `DataError` --
        # neither an integrity failure nor a missing relation, so nothing attributes it and the
        # caller would read a 500 for a value it supplied. A tag is the one caller-supplied string
        # only PATCH can set, so this is the only path that can carry one here.
        create("abc")

        response = patch("abc", {"tag": "release\x0018.1"})

        assert response.status_code == 400
        assert code_of(response) == "invalid_request"

    @pytest.mark.parametrize("key", ["ordinal", "tag"])
    def test_an_explicit_null_clears_a_stored_value(
        self, create: Callable[..., Any], patch: Callable[..., Any], key: str
    ) -> None:
        create("abc", ordinal=1)
        patch("abc", {"tag": "release-18.1"})

        assert patch("abc", {key: None}).json()[key] is None

    def test_leaves_every_key_the_request_omits_unchanged(
        self, create: Callable[..., Any], patch: Callable[..., Any]
    ) -> None:
        create("abc", ordinal=1, fields={"git_sha": "abc123", "author": "Jane"})
        patch("abc", {"tag": "release-18.1"})

        body = patch("abc", {"fields": {"author": "Ashok"}}).json()

        assert body == {
            "value": "abc",
            "ordinal": 1,
            "tag": "release-18.1",
            "fields": {**EVERY_FIELD, "git_sha": "abc123", "author": "Ashok"},
            "previous": None,
            "next": None,
        }

    def test_clears_a_field_sent_as_null(
        self, create: Callable[..., Any], patch: Callable[..., Any]
    ) -> None:
        create("abc", fields={"git_sha": "abc123", "author": "Jane"})

        body = patch("abc", {"fields": {"git_sha": None}}).json()

        assert body["fields"]["git_sha"] is None
        assert body["fields"]["author"] == "Jane"

    def test_an_empty_body_changes_nothing(
        self, create: Callable[..., Any], patch: Callable[..., Any]
    ) -> None:
        created = create("abc", ordinal=1).json()

        assert patch("abc", {}).json() == created

    def test_refuses_to_rename_a_commit(
        self, create: Callable[..., Any], patch: Callable[..., Any]
    ) -> None:
        # endpoints.md: `value` is immutable, so it is not a key this body has at all.
        create("abc")

        response = patch("abc", {"value": "def"})

        assert response.status_code == 400
        assert code_of(response) == "invalid_request"

    @pytest.mark.parametrize("ordinal", ["5", True, 2**31])
    def test_refuses_an_ordinal_that_is_not_one(
        self, create: Callable[..., Any], patch: Callable[..., Any], ordinal: Any
    ) -> None:
        create("abc")

        response = patch("abc", {"ordinal": ordinal})

        assert response.status_code == 400
        assert code_of(response) == "invalid_request"

    def test_refuses_an_ordinal_another_commit_holds(
        self, create: Callable[..., Any], patch: Callable[..., Any]
    ) -> None:
        create("abc", ordinal=7)
        create("def")

        response = patch("def", {"ordinal": 7})

        assert response.status_code == 409
        assert code_of(response) == "ordinal_conflict"

    def test_keeping_a_commits_own_ordinal_is_not_a_conflict(
        self, create: Callable[..., Any], patch: Callable[..., Any]
    ) -> None:
        create("abc", ordinal=7)

        assert patch("abc", {"ordinal": 7}).status_code == 200

    def test_refuses_an_undeclared_field(
        self, create: Callable[..., Any], patch: Callable[..., Any]
    ) -> None:
        create("abc")

        assert patch("abc", {"fields": {"branch": "main"}}).status_code == 400

    @pytest.mark.parametrize("body", [{"ordinal": 1}, {}])
    def test_is_404_for_a_commit_that_is_not_there(
        self, suite: SuiteTables, patch: Callable[..., Any], body: dict[str, Any]
    ) -> None:
        # Including with nothing to change: an UPDATE with no values matches no rows either way,
        # so this is the case an implementation that skips the lookup answers 200 for.
        response = patch("nope", body)

        assert response.status_code == 404
        assert code_of(response) == "not_found"


class TestDelete:
    def test_removes_the_commit(
        self,
        api_client: TestClient,
        manage: dict[str, str],
        create: Callable[..., Any],
    ) -> None:
        create("abc")

        response = api_client.delete(f"{COMMITS}/abc", headers=manage)

        assert response.status_code == 204
        assert response.content == b""
        assert api_client.get(f"{COMMITS}/abc").status_code == 404

    def test_deletes_an_ordered_commit_too(
        self, api_client: TestClient, manage: dict[str, str], create: Callable[..., Any]
    ) -> None:
        # D1: any commit is deletable, ordered or not.
        create("abc", ordinal=1)

        assert api_client.delete(f"{COMMITS}/abc", headers=manage).status_code == 204

    def test_cascades_to_its_runs_samples_and_profiles(
        self,
        api_client: TestClient,
        manage: dict[str, str],
        db_engine: Engine,
        suite: SuiteTables,
        create: Callable[..., Any],
        add_run: Callable[..., str],
    ) -> None:
        create("doomed")
        create("bystander")
        add_run("doomed", "linux", profile=True)
        add_run("bystander", "linux")

        api_client.delete(f"{COMMITS}/doomed", headers=manage)

        assert row_count(db_engine, select(suite.profile.c.id)) == 0
        # The bystander's run and sample are untouched, so this is a cascade rather than a
        # table-wide delete.
        assert row_count(db_engine, select(suite.run.c.id)) == 1
        assert row_count(db_engine, select(suite.sample.c.id)) == 1
        # D5: nothing deletes a test, so the cascade stops at the sample.
        assert row_count(db_engine, select(suite.test.c.id)) == 1

    def test_refuses_a_commit_a_regression_references(
        self,
        api_client: TestClient,
        manage: dict[str, str],
        db_engine: Engine,
        suite: SuiteTables,
        create: Callable[..., Any],
    ) -> None:
        # D5 and R4: `in_use` rather than the generic conflict, because the caller has to detach
        # the regression rather than retry.
        create("abc")
        with db_engine.begin() as connection:
            commit_id = connection.execute(
                select(suite.commit.c.id).where(suite.commit.c.commit == "abc")
            ).scalar_one()
            connection.execute(
                insert(suite.regression).values(uuid=str(uuid4()), state=0, commit_id=commit_id)
            )

        response = api_client.delete(f"{COMMITS}/abc", headers=manage)

        assert response.status_code == 409
        assert code_of(response) == "in_use"
        assert api_client.get(f"{COMMITS}/abc").status_code == 200

    def test_needs_no_confirmation(
        self, api_client: TestClient, manage: dict[str, str], create: Callable[..., Any]
    ) -> None:
        create("abc")

        assert api_client.delete(f"{COMMITS}/abc", headers=manage).status_code == 204

    def test_is_404_for_a_commit_that_is_not_there(
        self, api_client: TestClient, manage: dict[str, str], suite: SuiteTables
    ) -> None:
        response = api_client.delete(f"{COMMITS}/nope", headers=manage)

        assert response.status_code == 404
        assert code_of(response) == "not_found"


class TestResolve:
    @pytest.fixture
    def resolve(self, api_client: TestClient) -> Callable[..., Any]:
        def post(commits: list[str]) -> Any:
            return api_client.post(f"{COMMITS}/resolve", json={"commits": commits})

        return post

    def test_returns_a_table_keyed_by_commit_value(
        self, create: Callable[..., Any], resolve: Callable[..., Any]
    ) -> None:
        # R2: not one of the list envelopes -- a lookup table, which is what makes it useful.
        create("abc", ordinal=42, fields={"git_sha": "abc123"})

        body = resolve(["abc", "unknown"]).json()

        assert body == {
            "results": {
                "abc": {
                    "value": "abc",
                    "ordinal": 42,
                    "tag": None,
                    "fields": {**EVERY_FIELD, "git_sha": "abc123"},
                }
            },
            "not_found": ["unknown"],
        }

    def test_carries_no_neighbours(
        self, create: Callable[..., Any], resolve: Callable[..., Any]
    ) -> None:
        create("abc", ordinal=1)
        create("def", ordinal=2)

        assert set(resolve(["abc"]).json()["results"]["abc"]) == {
            "value",
            "ordinal",
            "tag",
            "fields",
        }

    def test_deduplicates_the_request(
        self, create: Callable[..., Any], resolve: Callable[..., Any]
    ) -> None:
        create("abc")

        body = resolve(["abc", "abc", "nope", "nope"]).json()

        assert list(body["results"]) == ["abc"]
        assert body["not_found"] == ["nope"]

    def test_resolves_nothing_rather_than_failing(
        self, suite: SuiteTables, resolve: Callable[..., Any]
    ) -> None:
        assert resolve(["nope"]).json() == {"results": {}, "not_found": ["nope"]}

    def test_reports_a_value_no_commit_could_have_as_not_found(
        self, suite: SuiteTables, resolve: Callable[..., Any]
    ) -> None:
        # Longer than the column can hold, so it is certainly not a commit in this suite -- which
        # is what `not_found` is for. Failing the whole lookup would contradict the endpoint's own
        # contract, and would make a client sanitize values it got from the server.
        body = resolve(["x" * 500]).json()

        assert body == {"results": {}, "not_found": ["x" * 500]}

    def test_refuses_more_values_than_a_page_may_hold(
        self, suite: SuiteTables, resolve: Callable[..., Any]
    ) -> None:
        # Unbounded, one request would expand into a statement with more bind parameters than the
        # protocol carries -- a 500 for something that should be a 400.
        response = resolve([f"c{index}" for index in range(MAX_LIMIT + 1)])

        assert response.status_code == 400
        assert code_of(response) == "invalid_request"

    def test_needs_at_least_one_commit(
        self, suite: SuiteTables, resolve: Callable[..., Any]
    ) -> None:
        response = resolve([])

        assert response.status_code == 400
        assert code_of(response) == "invalid_request"

    def test_is_404_for_a_suite_that_is_not_there(self, api_client: TestClient) -> None:
        response = api_client.post(f"{SUITES_PATH}/nope/commits/resolve", json={"commits": ["abc"]})

        assert response.status_code == 404

    def test_is_not_mistaken_for_a_commit_named_resolve(
        self, api_client: TestClient, create: Callable[..., Any], resolve: Callable[..., Any]
    ) -> None:
        # `/commits/resolve` is a POST and `/commits/{value}` has no POST, so a commit may legally
        # be called `resolve` and still be addressable.
        create("resolve", ordinal=1)

        assert api_client.get(f"{COMMITS}/resolve").json()["ordinal"] == 1
        assert list(resolve(["resolve"]).json()["results"]) == ["resolve"]


class TestSchemaChangedUnderneath:
    """D2's stale reader: answered with a conflict, never silently wrong and never a 500."""

    @pytest.fixture
    def column_dropped_behind_the_registry(
        self, db_engine: Engine, create: Callable[..., Any]
    ) -> None:
        create("abc")
        with db_engine.begin() as connection:
            connection.execute(text("ALTER TABLE nts.commit DROP COLUMN git_sha"))

    @pytest.mark.usefixtures("column_dropped_behind_the_registry")
    def test_a_read_is_a_retryable_conflict(self, api_client: TestClient) -> None:
        response = page(api_client)

        assert response.status_code == 409
        assert code_of(response) == "conflict"

    @pytest.mark.usefixtures("column_dropped_behind_the_registry")
    def test_a_write_is_a_retryable_conflict(
        self, api_client: TestClient, manage: dict[str, str]
    ) -> None:
        response = api_client.post(COMMITS, json={"value": "def"}, headers=manage)

        assert response.status_code == 409
        assert code_of(response) == "conflict"


class TestAuthorization:
    def test_reading_needs_no_credential(
        self, api_client: TestClient, create: Callable[..., Any]
    ) -> None:
        create("abc")

        assert api_client.get(COMMITS).status_code == 200
        assert api_client.get(f"{COMMITS}/abc").status_code == 200

    def test_resolving_needs_no_credential(
        self, api_client: TestClient, create: Callable[..., Any]
    ) -> None:
        # R5: a read-only POST, scoped `read` despite the method.
        create("abc")

        assert api_client.post(f"{COMMITS}/resolve", json={"commits": ["abc"]}).status_code == 200

    @pytest.mark.parametrize(("method", "path", "body"), [write[:3] for write in WRITES])
    def test_a_write_needs_a_credential(
        self,
        api_client: TestClient,
        create: Callable[..., Any],
        method: str,
        path: str,
        body: Any,
    ) -> None:
        create("abc")

        response = api_client.request(method.upper(), path, json=body)

        assert response.status_code == 401
        assert code_of(response) == "unauthorized"

    @pytest.mark.parametrize(("method", "path", "body"), [write[:3] for write in WRITES])
    def test_a_write_needs_more_than_read(
        self,
        api_client: TestClient,
        create: Callable[..., Any],
        make_key: Callable[..., str],
        bearer: Callable[[str], dict[str, str]],
        method: str,
        path: str,
        body: Any,
    ) -> None:
        create("abc")

        response = api_client.request(
            method.upper(), path, json=body, headers=bearer(make_key(Scope.READ))
        )

        assert response.status_code == 403
        assert code_of(response) == "forbidden"

    @pytest.mark.parametrize(("method", "path", "body", "scope"), WRITES)
    def test_each_write_accepts_exactly_the_scope_endpoints_md_gives_it(
        self,
        api_client: TestClient,
        create: Callable[..., Any],
        make_key: Callable[..., str],
        bearer: Callable[[str], dict[str, str]],
        method: str,
        path: str,
        body: Any,
        scope: Scope,
    ) -> None:
        # This is the first family where POST and PATCH need different scopes: creating a commit is
        # `submit`, because a submitting bot does it, while changing one is `manage`.
        create("abc")

        response = api_client.request(
            method.upper(), path, json=body, headers=bearer(make_key(scope))
        )

        assert response.status_code < 300, response.text

    @pytest.mark.parametrize("method", ["patch", "delete"])
    def test_changing_a_commit_needs_more_than_submit(
        self,
        api_client: TestClient,
        create: Callable[..., Any],
        make_key: Callable[..., str],
        bearer: Callable[[str], dict[str, str]],
        method: str,
    ) -> None:
        create("abc")

        response = api_client.request(
            method.upper(),
            f"{COMMITS}/abc",
            json={"ordinal": 1},
            headers=bearer(make_key(Scope.SUBMIT)),
        )

        assert response.status_code == 403
        assert code_of(response) == "forbidden"

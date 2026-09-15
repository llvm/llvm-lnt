"""The machine endpoints (endpoints.md, Machines).

Driven over the real application and a real database. Most of what is interesting here is what
PostgreSQL ends up doing: a `last_run_at` that is an index probe rather than a column, cascades that
reach three tables through two foreign keys, and the case-insensitive substring match D9 specifies.
"""

from __future__ import annotations

from collections.abc import Callable
from datetime import UTC, datetime
from typing import Any
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import Engine, insert, select, text

from conftest import code_of
from introspection import row_count, sql_type_of
from lnt_v5.routes.machines import Machines
from lnt_v5.routes.suites import SUITES_PATH
from lnt_v5.scopes import Scope
from lnt_v5.suites.entities import _ADAPTERS
from lnt_v5.suites.registry import Suite
from lnt_v5.suites.schema import AttributeType, SuiteSchema
from lnt_v5.suites.tables import SuiteTables, build

MACHINES = f"{SUITES_PATH}/nts/machines"

NTS: dict[str, Any] = {
    "name": "nts",
    "metrics": [{"name": "execution_time", "type": "real"}],
    "machine_fields": [
        {"name": "hardware", "type": "text", "searchable": True},
        {"name": "os", "type": "text", "searchable": True},
        # Deliberately not searchable, and deliberately not text: D9 covers neither.
        {"name": "notes", "type": "text"},
        {"name": "core_count", "type": "integer"},
        {"name": "clock_ghz", "type": "real"},
        {"name": "commissioned_at", "type": "datetime"},
    ],
}

EVERY_FIELD = {field["name"]: None for field in NTS["machine_fields"]}

# The three operations endpoints.md scopes `manage`, with a body each accepts.
WRITES = [
    ("post", MACHINES, {"name": "linux"}),
    ("patch", f"{MACHINES}/linux", {"tracked": False}),
    ("delete", f"{MACHINES}/linux", None),
]


@pytest.fixture
def suite(make_api_suite: Callable[[dict[str, Any]], SuiteTables]) -> SuiteTables:
    """The `nts` suite, created through the API, with its tables for reading the database back."""
    return make_api_suite(NTS)


@pytest.fixture
def create(
    api_client: TestClient, manage: dict[str, str], suite: SuiteTables
) -> Callable[..., Any]:
    """POST a machine. Named keys go straight into the entity object."""

    def post(name: str = "linux", **body: Any) -> Any:
        return api_client.post(MACHINES, json={"name": name, **body}, headers=manage)

    return post


@pytest.fixture
def add_run(db_engine: Engine, suite: SuiteTables) -> Callable[..., str]:
    """Attach a run to an existing machine, submitted at a given time."""

    def add(machine: str, submitted_at: datetime, commit: str = "abc") -> str:
        with db_engine.begin() as connection:
            machine_id = connection.execute(
                select(suite.machine.c.id).where(suite.machine.c.name == machine)
            ).scalar_one()
            commit_id = connection.execute(
                select(suite.commit.c.id).where(suite.commit.c.commit == commit)
            ).scalar_one_or_none()
            if commit_id is None:
                commit_id = connection.execute(
                    insert(suite.commit).values(commit=commit).returning(suite.commit.c.id)
                ).scalar_one()
            run = str(uuid4())
            connection.execute(
                insert(suite.run).values(
                    uuid=run,
                    machine_id=machine_id,
                    commit_id=commit_id,
                    submitted_at=submitted_at,
                )
            )
        return run

    return add


def at(day: int) -> datetime:
    return datetime(2026, 4, day, 12, 0, tzinfo=UTC)


def names_in(response: Any) -> list[str]:
    return [item["name"] for item in response.json()["items"]]


class TestList:
    def test_is_an_offset_envelope_even_when_nothing_matches(
        self, api_client: TestClient, suite: SuiteTables
    ) -> None:
        response = api_client.get(MACHINES)

        assert response.status_code == 200
        # R2: `items` present and empty, and a `total` rather than a `cursor` -- this list is
        # bounded, so it is offset-paginated.
        assert sorted(response.json()) == ["items", "total"]
        assert response.json() == {"items": [], "total": 0}

    def test_is_ordered_by_name_by_default(
        self, api_client: TestClient, create: Callable[..., Any]
    ) -> None:
        for name in ("zebra", "alpha", "middle"):
            create(name)

        assert names_in(api_client.get(MACHINES)) == ["alpha", "middle", "zebra"]

    def test_sorts_by_name_descending(
        self, api_client: TestClient, create: Callable[..., Any]
    ) -> None:
        for name in ("alpha", "zebra"):
            create(name)

        assert names_in(api_client.get(f"{MACHINES}?sort=-name")) == ["zebra", "alpha"]

    def test_refuses_a_sort_field_it_does_not_offer(
        self, api_client: TestClient, suite: SuiteTables
    ) -> None:
        response = api_client.get(f"{MACHINES}?sort=hardware")

        assert response.status_code == 400
        assert code_of(response) == "invalid_request"

    def test_carries_the_same_object_the_detail_does(
        self, api_client: TestClient, create: Callable[..., Any]
    ) -> None:
        create("linux", fields={"hardware": "x86_64"})

        assert api_client.get(MACHINES).json()["items"] == [
            api_client.get(f"{MACHINES}/linux").json()
        ]

    def test_is_404_for_a_suite_that_is_not_there(self, api_client: TestClient) -> None:
        response = api_client.get(f"{SUITES_PATH}/nope/machines")

        assert response.status_code == 404
        assert code_of(response) == "not_found"


class TestListPagination:
    @pytest.fixture(autouse=True)
    def machines(self, create: Callable[..., Any]) -> None:
        for index in range(5):
            create(f"m{index}")

    def test_returns_the_requested_window(self, api_client: TestClient) -> None:
        assert names_in(api_client.get(f"{MACHINES}?limit=2&offset=1")) == ["m1", "m2"]

    def test_total_ignores_limit_and_offset(self, api_client: TestClient) -> None:
        # R2: `total` is what matches the filters, so a client can render "1-2 of 5".
        assert api_client.get(f"{MACHINES}?limit=2&offset=1").json()["total"] == 5

    def test_total_respects_the_filters(self, api_client: TestClient) -> None:
        assert api_client.get(f"{MACHINES}?search=m3").json()["total"] == 1

    @pytest.mark.parametrize("query", ["limit=0", "limit=10001", "offset=-1"])
    def test_refuses_a_page_it_cannot_serve(self, api_client: TestClient, query: str) -> None:
        response = api_client.get(f"{MACHINES}?{query}")

        assert response.status_code == 400
        assert code_of(response) == "invalid_request"


class TestListSearch:
    @pytest.fixture(autouse=True)
    def machines(self, create: Callable[..., Any]) -> None:
        create("linux-x86", fields={"hardware": "Xeon", "os": "linux", "notes": "spare"})
        create("darwin-arm", fields={"hardware": "M3", "os": "darwin", "notes": "Xeon-like"})

    def test_matches_the_name(self, api_client: TestClient) -> None:
        assert names_in(api_client.get(f"{MACHINES}?search=x86")) == ["linux-x86"]

    def test_matches_a_searchable_field(self, api_client: TestClient) -> None:
        assert names_in(api_client.get(f"{MACHINES}?search=M3")) == ["darwin-arm"]

    def test_is_case_insensitive(self, api_client: TestClient) -> None:
        assert names_in(api_client.get(f"{MACHINES}?search=xEoN")) == ["linux-x86"]

    def test_is_a_substring_match_rather_than_a_prefix(self, api_client: TestClient) -> None:
        assert names_in(api_client.get(f"{MACHINES}?search=arm")) == ["darwin-arm"]

    def test_ors_the_name_and_every_searchable_field(self, api_client: TestClient) -> None:
        # D9's OR semantics: `linux` is one machine's name and the other's... nothing, but it is
        # the first machine's `os` too, so the match must not require both to agree.
        assert names_in(api_client.get(f"{MACHINES}?search=linux")) == ["linux-x86"]
        assert names_in(api_client.get(f"{MACHINES}?search=darwin")) == ["darwin-arm"]

    def test_ignores_a_field_that_is_not_searchable(self, api_client: TestClient) -> None:
        # `notes` is declared but not searchable, and `Xeon-like` is only in it -- a match here
        # would mean the filter reads every text field rather than the declared ones.
        assert names_in(api_client.get(f"{MACHINES}?search=Xeon")) == ["linux-x86"]

    def test_treats_a_wildcard_in_the_term_literally(
        self, api_client: TestClient, create: Callable[..., Any]
    ) -> None:
        # Unescaped, `%` and `_` are LIKE wildcards, so this term would match every machine.
        create("a%b")
        create("axb")

        assert names_in(api_client.get(MACHINES, params={"search": "a%b"})) == ["a%b"]

    def test_matches_nothing_rather_than_failing(self, api_client: TestClient) -> None:
        assert api_client.get(f"{MACHINES}?search=nope").json() == {"items": [], "total": 0}


class TestListTrackedFilter:
    @pytest.fixture(autouse=True)
    def machines(self, create: Callable[..., Any]) -> None:
        create("watched")
        create("retired", tracked=False)

    def test_omitting_it_returns_both(self, api_client: TestClient) -> None:
        assert names_in(api_client.get(MACHINES)) == ["retired", "watched"]

    def test_keeps_only_tracked_machines(self, api_client: TestClient) -> None:
        assert names_in(api_client.get(f"{MACHINES}?tracked=true")) == ["watched"]

    def test_keeps_only_untracked_machines(self, api_client: TestClient) -> None:
        assert names_in(api_client.get(f"{MACHINES}?tracked=false")) == ["retired"]

    def test_refuses_a_value_that_is_not_a_boolean(self, api_client: TestClient) -> None:
        assert api_client.get(f"{MACHINES}?tracked=maybe").status_code == 400


class TestLastRunAt:
    @pytest.fixture(autouse=True)
    def machines(self, create: Callable[..., Any], add_run: Callable[..., str]) -> None:
        create("older")
        create("newer")
        create("never")
        add_run("older", at(1))
        add_run("newer", at(2))
        # The most recent run is what counts, not the last one inserted.
        add_run("older", at(3), commit="def")
        add_run("newer", at(2), commit="def")

    def test_is_the_most_recent_submission(self, api_client: TestClient) -> None:
        assert api_client.get(f"{MACHINES}/older").json()["last_run_at"] == "2026-04-03T12:00:00Z"

    def test_is_null_for_a_machine_with_no_runs(self, api_client: TestClient) -> None:
        assert api_client.get(f"{MACHINES}/never").json()["last_run_at"] is None

    def test_sorts_ascending_with_the_runless_machines_last(self, api_client: TestClient) -> None:
        assert names_in(api_client.get(f"{MACHINES}?sort=last_run_at")) == [
            "newer",
            "older",
            "never",
        ]

    def test_sorts_descending_with_the_runless_machines_still_last(
        self, api_client: TestClient
    ) -> None:
        # endpoints.md: after every machine that has one, *in both directions*. PostgreSQL's own
        # default would put them first here.
        assert names_in(api_client.get(f"{MACHINES}?sort=-last_run_at")) == [
            "older",
            "newer",
            "never",
        ]

    def test_orders_ties_deterministically(
        self, api_client: TestClient, create: Callable[..., Any], add_run: Callable[..., str]
    ) -> None:
        # Two machines sharing a `last_run_at` must not be able to swap places between pages.
        create("tie-b")
        create("tie-a")
        add_run("tie-b", at(9))
        add_run("tie-a", at(9))

        ordered = names_in(api_client.get(f"{MACHINES}?sort=-last_run_at"))

        assert ordered[:2] == ["tie-a", "tie-b"]

    def test_is_derived_by_an_index_probe_rather_than_an_aggregate(self) -> None:
        """D5 is explicit about the shape, and the shape is only visible in the statement.

        An aggregate over the whole run table answers the same question and would pass every test
        above, while reading every run in the suite to do it.
        """
        schema = SuiteSchema.model_validate(NTS)
        suite = Suite(schema=schema, tables=build(schema), schema_json="")

        statement = Machines(suite).select()
        sql = str(statement.compile(compile_kwargs={"literal_binds": True})).upper()
        assert "LATERAL" in sql and "LIMIT 1" in sql
        assert "GROUP BY" not in sql and "MAX(" not in sql


class TestCreate:
    def test_every_declared_type_has_a_json_representation(self) -> None:
        # D3's table is the authority, and `entities.py` restates it as validators. A fifth type
        # added without one would be a KeyError on the first write that used it rather than a
        # failure here. Machines are currently the only entity exercising these.
        assert set(_ADAPTERS) == set(AttributeType)

    def test_returns_the_created_machine_and_where_to_find_it(
        self, api_client: TestClient, create: Callable[..., Any]
    ) -> None:
        response = create("linux")

        assert response.status_code == 201
        assert response.headers["Location"] == f"{MACHINES}/linux"
        assert api_client.get(response.headers["Location"]).json() == response.json()

    def test_defaults_to_tracked_with_no_fields_and_no_runs(
        self, create: Callable[..., Any]
    ) -> None:
        assert create("linux").json() == {
            "name": "linux",
            "tracked": True,
            "fields": EVERY_FIELD,
            "last_run_at": None,
        }

    def test_accepts_an_untracked_machine(self, create: Callable[..., Any]) -> None:
        assert create("retired", tracked=False).json()["tracked"] is False

    @pytest.mark.parametrize("tracked", ["true", 1])
    def test_refuses_a_tracked_that_is_not_a_boolean(
        self, create: Callable[..., Any], tracked: Any
    ) -> None:
        # D3's typing applies to the built-in attributes beside `fields` too (D7), so `tracked` is
        # no more willing to read `"true"` than a declared `text` field is to read a number.
        response = create("linux", tracked=tracked)

        assert response.status_code == 400
        assert code_of(response) == "invalid_request"

    def test_refuses_a_declared_integer_beyond_its_column(self, create: Callable[..., Any]) -> None:
        # D3 maps `integer` to a 32-bit column; unchecked, the database's range error is a
        # `DataError` nothing attributes, and the caller gets a 500 for a value it supplied.
        response = create("linux", fields={"core_count": 2**31})

        assert response.status_code == 400
        assert code_of(response) == "invalid_request"

    def test_stores_declared_fields_with_the_types_d3_gives_them(
        self, db_engine: Engine, create: Callable[..., Any]
    ) -> None:
        response = create(
            "linux",
            fields={
                "hardware": "x86_64",
                "core_count": 8,
                "clock_ghz": 3.5,
                "commissioned_at": "2026-04-15T14:30:00Z",
            },
        )

        # R4: typed per D3 and never stringified, on the way back out as well as in.
        assert response.json()["fields"] == {
            "hardware": "x86_64",
            "os": None,
            "notes": None,
            "core_count": 8,
            "clock_ghz": 3.5,
            "commissioned_at": "2026-04-15T14:30:00Z",
        }
        assert sql_type_of(db_engine, "nts", "machine", "core_count") == "INTEGER"
        assert sql_type_of(db_engine, "nts", "machine", "clock_ghz") == "DOUBLE PRECISION"

    def test_converts_a_timestamp_to_utc(self, create: Callable[..., Any]) -> None:
        # D5: stored as UTC, and serialized with a `Z` suffix rather than the offset it arrived in.
        response = create("linux", fields={"commissioned_at": "2026-04-15T16:30:00+02:00"})

        assert response.json()["fields"]["commissioned_at"] == "2026-04-15T14:30:00Z"

    def test_reports_every_declared_field_even_when_unset(self, create: Callable[..., Any]) -> None:
        # R4: a documented key is present and null when it has no value, so a client rendering one
        # column per declared field does not have to discover which keys a row happens to carry.
        assert create("linux").json()["fields"] == EVERY_FIELD

    def test_refuses_a_name_already_taken(self, create: Callable[..., Any]) -> None:
        create("linux")

        response = create("linux")

        assert response.status_code == 409
        assert code_of(response) == "duplicate"

    def test_refuses_an_undeclared_field(self, create: Callable[..., Any]) -> None:
        # D7: neither entity has a catch-all blob, so declaring a field is a schema change.
        response = create("linux", fields={"kernel": "6.8"})

        assert response.status_code == 400
        assert code_of(response) == "invalid_request"

    @pytest.mark.parametrize(
        ("value", "reason"),
        [
            ({"core_count": "8"}, "a stringified integer"),
            ({"core_count": 8.5}, "a real where an integer is declared"),
            ({"clock_ghz": "3.5"}, "a stringified real"),
            ({"hardware": 64}, "a number where text is declared"),
            ({"commissioned_at": "not a date"}, "an unparseable timestamp"),
            ({"commissioned_at": 1776000000}, "a timestamp as a number"),
            # The same mistake one step removed: read as a Unix epoch this would be a date in
            # 1970 rather than the 400 D3 asks for, which is the whole reason D3 spells out that
            # a `datetime` is an ISO 8601 string and nothing else.
            ({"commissioned_at": "1776000000"}, "a timestamp as a string holding a number"),
            ({"commissioned_at": "3"}, "a timestamp as a string holding a small number"),
            ({"core_count": True}, "a boolean"),
            ({"hardware": ["x86_64"]}, "a list"),
        ],
    )
    def test_refuses_a_value_that_is_not_the_declared_type(
        self, create: Callable[..., Any], value: dict[str, Any], reason: str
    ) -> None:
        response = create("linux", fields=value)

        assert response.status_code == 400, reason
        assert code_of(response) == "invalid_request"

    def test_says_which_field_was_wrong_and_why(self, create: Callable[..., Any]) -> None:
        # R4 leaves `message` to humans, but a validation failure at the root of a bare value has
        # no location, so the reason must not arrive after an empty prefix and a stray colon.
        message = create("linux", fields={"core_count": "8"}).json()["error"]["message"]

        assert ": :" not in message
        assert "core_count" in message and "integer" in message

    @pytest.mark.parametrize(
        ("value", "stored", "reason"),
        [
            ({"clock_ghz": 3}, 3.0, "an integer where a real is declared loses nothing"),
            ({"core_count": 8.0}, 8, "a producer serializing an integer through a float"),
        ],
    )
    def test_reads_a_number_leniently_where_nothing_is_lost(
        self, create: Callable[..., Any], value: dict[str, Any], stored: Any, reason: str
    ) -> None:
        # D3: JSON has a single number type, so the two numeric types are read from it in both
        # directions wherever no information is dropped.
        key = next(iter(value))

        assert create("linux", fields=value).json()["fields"][key] == stored, reason

    def test_accepts_an_explicitly_null_field(self, create: Callable[..., Any]) -> None:
        assert create("linux", fields={"hardware": None}).json()["fields"]["hardware"] is None

    @pytest.mark.parametrize(
        ("name", "reason"),
        [
            ("a/b", "a separator, which routing would never deliver"),
            (".", "a relative segment, normalized away before the request arrives"),
            ("..", "a parent segment, likewise"),
        ],
    )
    def test_refuses_a_name_no_url_could_address(
        self, create: Callable[..., Any], name: str, reason: str
    ) -> None:
        # R1: accepting one would create a machine no URL can reach, and hand back a `Location`
        # header that answers 404.
        response = create(name)

        assert response.status_code == 400, reason
        assert code_of(response) == "invalid_request"

    def test_refuses_a_rename_onto_a_name_no_url_could_address(
        self, api_client: TestClient, manage: dict[str, str], create: Callable[..., Any]
    ) -> None:
        create("linux")

        assert (
            api_client.patch(f"{MACHINES}/linux", json={"name": "a/b"}, headers=manage).status_code
            == 400
        )

    def test_the_location_it_reports_is_encoded_and_resolves(
        self, api_client: TestClient, create: Callable[..., Any]
    ) -> None:
        # R1: the machine is addressed by its name, so a name needing encoding has to be encoded
        # in the `Location` -- and the encoded form has to route back to the same machine.
        response = create("linux x86")

        assert response.status_code == 201
        assert response.headers["Location"] == f"{MACHINES}/linux%20x86"
        assert api_client.get(response.headers["Location"]).json() == response.json()

    @pytest.mark.parametrize("body", [{}, {"name": ""}, {"name": "x", "nonsense": 1}])
    def test_refuses_a_body_that_does_not_validate(
        self, api_client: TestClient, manage: dict[str, str], suite: SuiteTables, body: Any
    ) -> None:
        response = api_client.post(MACHINES, json=body, headers=manage)

        assert response.status_code == 400
        assert code_of(response) == "invalid_request"

    def test_is_404_for_a_suite_that_is_not_there(
        self, api_client: TestClient, manage: dict[str, str]
    ) -> None:
        response = api_client.post(
            f"{SUITES_PATH}/nope/machines", json={"name": "linux"}, headers=manage
        )

        assert response.status_code == 404
        assert code_of(response) == "not_found"


class TestDetail:
    def test_round_trips_what_create_accepted(
        self, api_client: TestClient, create: Callable[..., Any]
    ) -> None:
        created = create("linux", fields={"hardware": "x86_64"}).json()

        assert api_client.get(f"{MACHINES}/linux").json() == created

    def test_is_404_for_a_machine_that_is_not_there(
        self, api_client: TestClient, suite: SuiteTables
    ) -> None:
        response = api_client.get(f"{MACHINES}/nope")

        assert response.status_code == 404
        assert code_of(response) == "not_found"

    def test_is_404_for_a_suite_that_is_not_there(self, api_client: TestClient) -> None:
        assert api_client.get(f"{SUITES_PATH}/nope/machines/linux").status_code == 404

    def test_is_not_shadowed_by_the_spa_catch_all(
        self, api_client: TestClient, create: Callable[..., Any]
    ) -> None:
        create("linux")

        assert "<title>LNT</title>" not in api_client.get(f"{MACHINES}/linux").text


class TestUpdate:
    @pytest.fixture
    def patch(self, api_client: TestClient, manage: dict[str, str]) -> Callable[..., Any]:
        def send(name: str, body: dict[str, Any]) -> Any:
            return api_client.patch(f"{MACHINES}/{name}", json=body, headers=manage)

        return send

    def test_renames_a_machine(
        self, api_client: TestClient, create: Callable[..., Any], patch: Callable[..., Any]
    ) -> None:
        create("linux", fields={"hardware": "x86_64"})

        response = patch("linux", {"name": "linux-x86"})

        assert response.status_code == 200
        assert response.json()["name"] == "linux-x86"
        assert api_client.get(f"{MACHINES}/linux").status_code == 404
        # And the rename carried everything else with it.
        assert api_client.get(f"{MACHINES}/linux-x86").json()["fields"]["hardware"] == "x86_64"

    def test_keeps_a_renamed_machines_runs(
        self,
        api_client: TestClient,
        create: Callable[..., Any],
        add_run: Callable[..., str],
        patch: Callable[..., Any],
    ) -> None:
        create("linux")
        add_run("linux", at(1))

        patch("linux", {"name": "linux-x86"})

        assert (
            api_client.get(f"{MACHINES}/linux-x86").json()["last_run_at"] == "2026-04-01T12:00:00Z"
        )

    def test_refuses_a_rename_onto_a_name_already_taken(
        self, create: Callable[..., Any], patch: Callable[..., Any]
    ) -> None:
        create("linux")
        create("darwin")

        response = patch("linux", {"name": "darwin"})

        assert response.status_code == 409
        assert code_of(response) == "duplicate"

    def test_renaming_a_machine_to_its_own_name_is_allowed(
        self, create: Callable[..., Any], patch: Callable[..., Any]
    ) -> None:
        create("linux")

        assert patch("linux", {"name": "linux"}).status_code == 200

    def test_flips_tracked(self, create: Callable[..., Any], patch: Callable[..., Any]) -> None:
        create("linux")

        assert patch("linux", {"tracked": False}).json()["tracked"] is False

    def test_leaves_every_key_the_request_omits_unchanged(
        self, create: Callable[..., Any], patch: Callable[..., Any]
    ) -> None:
        create("linux", tracked=False, fields={"hardware": "x86_64", "os": "linux"})

        body = patch("linux", {"fields": {"os": "debian"}}).json()

        assert body == {
            "name": "linux",
            "tracked": False,
            "fields": {**EVERY_FIELD, "hardware": "x86_64", "os": "debian"},
            "last_run_at": None,
        }

    def test_clears_a_field_sent_as_null(
        self, create: Callable[..., Any], patch: Callable[..., Any]
    ) -> None:
        create("linux", fields={"hardware": "x86_64", "os": "linux"})

        body = patch("linux", {"fields": {"hardware": None}}).json()

        assert body["fields"]["hardware"] is None
        assert body["fields"]["os"] == "linux"

    def test_an_empty_body_changes_nothing(
        self, api_client: TestClient, create: Callable[..., Any], patch: Callable[..., Any]
    ) -> None:
        created = create("linux", fields={"hardware": "x86_64"}).json()

        assert patch("linux", {}).json() == created

    @pytest.mark.parametrize("body", [{"name": None}, {"tracked": None}, {"fields": None}])
    def test_refuses_clearing_a_key_that_is_not_nullable(
        self, create: Callable[..., Any], patch: Callable[..., Any], body: dict[str, Any]
    ) -> None:
        create("linux")

        response = patch("linux", body)

        assert response.status_code == 400
        assert code_of(response) == "invalid_request"

    def test_refuses_an_undeclared_field(
        self, create: Callable[..., Any], patch: Callable[..., Any]
    ) -> None:
        create("linux")

        assert patch("linux", {"fields": {"kernel": "6.8"}}).status_code == 400

    def test_refuses_an_unknown_key(
        self, create: Callable[..., Any], patch: Callable[..., Any]
    ) -> None:
        create("linux")

        assert patch("linux", {"last_run_at": "2026-04-01T12:00:00Z"}).status_code == 400

    def test_is_404_for_a_machine_that_is_not_there(
        self, suite: SuiteTables, patch: Callable[..., Any]
    ) -> None:
        response = patch("nope", {"tracked": False})

        assert response.status_code == 404
        assert code_of(response) == "not_found"

    def test_is_404_for_a_machine_that_is_not_there_even_with_nothing_to_change(
        self, suite: SuiteTables, patch: Callable[..., Any]
    ) -> None:
        # An UPDATE with no values matches no rows either way, so this is the case an
        # implementation that skips the lookup answers 200 for.
        assert patch("nope", {}).status_code == 404


class TestDelete:
    @pytest.fixture
    def populated(
        self, db_engine: Engine, suite: SuiteTables, create: Callable[..., Any], add_run: Any
    ) -> SuiteTables:
        """A machine with a run, a sample, a profile, and a regression indicator naming it.

        Plus a second machine with its own run, to prove the cascade is scoped to the first.
        """
        create("doomed")
        create("bystander")
        run = add_run("doomed", at(1))
        add_run("bystander", at(1))
        with db_engine.begin() as connection:
            run_id = connection.execute(
                select(suite.run.c.id).where(suite.run.c.uuid == run)
            ).scalar_one()
            machine_id = connection.execute(
                select(suite.machine.c.id).where(suite.machine.c.name == "doomed")
            ).scalar_one()
            test_id = connection.execute(
                insert(suite.test).values(name="t").returning(suite.test.c.id)
            ).scalar_one()
            connection.execute(
                insert(suite.sample).values(run_id=run_id, test_id=test_id, execution_time=1.5)
            )
            connection.execute(
                insert(suite.profile).values(
                    uuid=str(uuid4()), run_id=run_id, test_id=test_id, data=b"\x02"
                )
            )
            regression = connection.execute(
                insert(suite.regression)
                .values(uuid=str(uuid4()), title="a regression", state=0)
                .returning(suite.regression.c.id)
            ).scalar_one()
            connection.execute(
                insert(suite.regression_indicator).values(
                    uuid=str(uuid4()),
                    regression_id=regression,
                    machine_id=machine_id,
                    test_id=test_id,
                    metric="execution_time",
                )
            )
        return suite

    def test_removes_the_machine(
        self, api_client: TestClient, manage: dict[str, str], populated: SuiteTables
    ) -> None:
        response = api_client.delete(f"{MACHINES}/doomed", headers=manage)

        assert response.status_code == 204
        assert response.content == b""
        assert api_client.get(f"{MACHINES}/doomed").status_code == 404

    def test_needs_no_confirmation(
        self, api_client: TestClient, manage: dict[str, str], populated: SuiteTables
    ) -> None:
        # Unlike the destructive suite operations: endpoints.md requires `?confirm=true` there and
        # says nothing about it here.
        assert api_client.delete(f"{MACHINES}/doomed", headers=manage).status_code == 204

    def test_cascades_to_its_runs_samples_and_profiles(
        self,
        api_client: TestClient,
        manage: dict[str, str],
        db_engine: Engine,
        populated: SuiteTables,
    ) -> None:
        api_client.delete(f"{MACHINES}/doomed", headers=manage)

        assert row_count(db_engine, select(populated.sample.c.id)) == 0
        assert row_count(db_engine, select(populated.profile.c.id)) == 0
        # The bystander's run is untouched, so this is a cascade rather than a table-wide delete.
        assert row_count(db_engine, select(populated.run.c.id)) == 1

    def test_cascades_to_every_regression_indicator_naming_it(
        self,
        api_client: TestClient,
        manage: dict[str, str],
        db_engine: Engine,
        populated: SuiteTables,
    ) -> None:
        api_client.delete(f"{MACHINES}/doomed", headers=manage)

        assert row_count(db_engine, select(populated.regression_indicator.c.id)) == 0

    def test_keeps_a_regression_left_with_no_indicators(
        self,
        api_client: TestClient,
        manage: dict[str, str],
        db_engine: Engine,
        populated: SuiteTables,
    ) -> None:
        # D5: an empty indicator set is a legal state, and the regression keeps its title, bug,
        # notes and commit.
        api_client.delete(f"{MACHINES}/doomed", headers=manage)

        with db_engine.connect() as connection:
            assert (
                connection.execute(select(populated.regression.c.title)).scalar_one()
                == "a regression"
            )

    def test_keeps_the_tests_its_samples_referenced(
        self,
        api_client: TestClient,
        manage: dict[str, str],
        db_engine: Engine,
        populated: SuiteTables,
    ) -> None:
        # D5: nothing deletes a test, so the cascade must stop at the sample.
        api_client.delete(f"{MACHINES}/doomed", headers=manage)

        assert row_count(db_engine, select(populated.test.c.id)) == 1

    def test_is_404_for_a_machine_that_is_not_there(
        self, api_client: TestClient, manage: dict[str, str], suite: SuiteTables
    ) -> None:
        response = api_client.delete(f"{MACHINES}/nope", headers=manage)

        assert response.status_code == 404
        assert code_of(response) == "not_found"


class TestSchemaChangedUnderneath:
    """D2's stale reader: answered with a conflict, never silently wrong and never a 500.

    A worker checks the version counter, then queries. Another worker can remove a field in
    between, so the query reaches a column that is no longer there. Simulated by dropping the
    column *without* bumping the counter, which is exactly the state the racing reader is in.
    """

    @pytest.fixture
    def column_dropped_behind_the_registry(
        self, api_client: TestClient, db_engine: Engine, create: Callable[..., Any]
    ) -> None:
        create("linux")
        with db_engine.begin() as connection:
            connection.execute(text("ALTER TABLE nts.machine DROP COLUMN hardware"))

    @pytest.mark.usefixtures("column_dropped_behind_the_registry")
    def test_a_read_is_a_retryable_conflict(self, api_client: TestClient) -> None:
        response = api_client.get(MACHINES)

        assert response.status_code == 409
        assert code_of(response) == "conflict"

    @pytest.mark.usefixtures("column_dropped_behind_the_registry")
    def test_a_write_is_a_retryable_conflict(
        self, api_client: TestClient, manage: dict[str, str]
    ) -> None:
        response = api_client.post(MACHINES, json={"name": "darwin"}, headers=manage)

        assert response.status_code == 409
        assert code_of(response) == "conflict"

    def test_a_dropped_suite_is_a_retryable_conflict(
        self, api_client: TestClient, db_engine: Engine, create: Callable[..., Any]
    ) -> None:
        # The whole namespace, rather than one column: same race, same answer.
        create("linux")
        with db_engine.begin() as connection:
            connection.execute(text("DROP TABLE nts.machine CASCADE"))

        assert api_client.get(MACHINES).status_code == 409


class TestAuthorization:
    def test_reading_needs_no_credential(
        self, api_client: TestClient, create: Callable[..., Any]
    ) -> None:
        create("linux")

        assert api_client.get(MACHINES).status_code == 200
        assert api_client.get(f"{MACHINES}/linux").status_code == 200

    @pytest.mark.parametrize(("method", "path", "body"), WRITES)
    def test_a_write_needs_a_credential(
        self,
        api_client: TestClient,
        create: Callable[..., Any],
        method: str,
        path: str,
        body: Any,
    ) -> None:
        create("linux")

        response = api_client.request(method.upper(), path, json=body)

        assert response.status_code == 401
        assert code_of(response) == "unauthorized"

    @pytest.mark.parametrize(("method", "path", "body"), WRITES)
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
        create("linux")

        response = api_client.request(
            method.upper(), path, json=body, headers=bearer(make_key(Scope.READ))
        )

        assert response.status_code == 403
        assert code_of(response) == "forbidden"

    @pytest.mark.parametrize(
        "path",
        [
            # An unknown suite, and a known suite with an unknown machine: neither may be
            # distinguishable from the other by someone who is not allowed to write.
            f"{SUITES_PATH}/nope/machines/nope",
            f"{SUITES_PATH}/nts/machines/nope",
        ],
    )
    def test_scope_is_checked_before_anything_is_resolved(
        self,
        api_client: TestClient,
        suite: SuiteTables,
        make_key: Callable[..., str],
        bearer: Callable[[str], dict[str, str]],
        path: str,
    ) -> None:
        # R5: resolving first and answering 404 would let an under-scoped caller enumerate which
        # suites and machines exist.
        response = api_client.delete(path, headers=bearer(make_key(Scope.READ)))

        assert response.status_code == 403

    def test_a_missing_credential_outranks_an_unknown_suite(self, api_client: TestClient) -> None:
        assert api_client.delete(f"{SUITES_PATH}/nope/machines/nope").status_code == 401

    def test_a_higher_scope_may_write(
        self,
        api_client: TestClient,
        suite: SuiteTables,
        make_key: Callable[..., str],
        bearer: Callable[[str], dict[str, str]],
    ) -> None:
        response = api_client.post(
            MACHINES, json={"name": "linux"}, headers=bearer(make_key(Scope.ADMIN))
        )

        assert response.status_code == 201

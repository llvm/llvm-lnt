"""The test suite endpoints (endpoints.md, Test Suites).

Driven over the real application and a real database, because most of what matters here is what
PostgreSQL ends up holding: the namespace, its columns, and the stored normalized schema.
"""

from __future__ import annotations

import json
import threading
from collections.abc import Callable
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import Engine, insert, inspect, select, text
from sqlalchemy.exc import ProgrammingError

from conftest import code_of
from introspection import column_names, schema_version_of
from lnt_v5.errors import ApiError, ErrorCode
from lnt_v5.routes.suites import SUITES_PATH, delete_suite, patch_schema
from lnt_v5.scopes import Scope
from lnt_v5.suites.evolve import SchemaPatch
from lnt_v5.suites.schema import SuiteSchema
from lnt_v5.suites.tables import build
from lnt_v5.tables import IDENTIFIER_MAX_LENGTH
from lnt_v5.tables import schema as schema_table

SUITES = SUITES_PATH

# The schema from D4, trimmed to what these tests need to see move.
NTS: dict[str, Any] = {
    "name": "nts",
    "metrics": [
        {
            "name": "compile_time",
            "type": "real",
            "display_name": "Compile Time",
            "unit": "seconds",
            "unit_abbrev": "s",
            "bigger_is_better": False,
        },
        {"name": "execution_time", "type": "real"},
    ],
    "commit_fields": [{"name": "git_sha", "type": "text", "searchable": True, "display": True}],
    "machine_fields": [{"name": "hardware", "type": "text", "searchable": True}],
}


@pytest.fixture
def create(api_client: TestClient, manage: dict[str, str]) -> Callable[..., Any]:
    def post(body: dict[str, Any] | None = None, **overrides: Any) -> Any:
        return api_client.post(SUITES, json={**(body or NTS), **overrides}, headers=manage)

    return post


def stored_schema(engine: Engine, name: str) -> dict[str, Any]:
    with engine.connect() as connection:
        row = connection.execute(
            select(schema_table.c.schema_json).where(schema_table.c.name == name)
        ).scalar_one()
    return dict(json.loads(row))


def patch_request(
    api_client: TestClient,
    manage: dict[str, str],
    body: dict[str, Any],
    *,
    confirm: bool | None = None,
    name: str = "nts",
) -> Any:
    """PATCH a suite's schema. `confirm` omitted means the query parameter is absent entirely."""
    path = f"{SUITES}/{name}/schema"
    if confirm is not None:
        path += f"?confirm={'true' if confirm else 'false'}"
    return api_client.patch(path, json=body, headers=manage)


class TestList:
    def test_is_an_empty_envelope_when_nothing_is_defined(self, api_client: TestClient) -> None:
        response = api_client.get(SUITES)

        assert response.status_code == 200
        # R2: `items` present and empty rather than absent, and nothing else -- no `total`, which
        # would claim this list is offset-paginated.
        assert list(response.json()) == ["items"]
        assert response.json()["items"] == []

    def test_carries_every_suite_with_its_full_schema(
        self, api_client: TestClient, create: Callable[..., Any]
    ) -> None:
        # endpoints.md: schemas included rather than names alone, because parts of the client need
        # every suite's metric list up front.
        create()

        items = api_client.get(SUITES).json()["items"]

        assert items == [api_client.get(f"{SUITES}/nts").json()]

    def test_is_ordered_by_name(self, api_client: TestClient, create: Callable[..., Any]) -> None:
        for name in ("zebra", "alpha", "middle"):
            create(name=name)

        names = [item["name"] for item in api_client.get(SUITES).json()["items"]]

        assert names == ["alpha", "middle", "zebra"]

    def test_needs_no_credential(self, api_client: TestClient, create: Callable[..., Any]) -> None:
        create()

        assert api_client.get(SUITES).status_code == 200


class TestCreate:
    def test_returns_the_created_suite_and_where_to_find_it(
        self, api_client: TestClient, create: Callable[..., Any]
    ) -> None:
        response = create()

        assert response.status_code == 201
        assert response.headers["Location"] == f"{SUITES}/nts"
        # The Location has to actually resolve, and to the same document.
        assert api_client.get(response.headers["Location"]).json() == response.json()

    def test_normalizes_what_it_returns(self, create: Callable[..., Any]) -> None:
        # D4: every optional key present and explicit, so the response is postable verbatim.
        metric = create(metrics=[{"name": "execution_time", "type": "real"}]).json()["metrics"][0]

        assert metric == {
            "name": "execution_time",
            "type": "real",
            "display_name": None,
            "unit": None,
            "unit_abbrev": None,
            "bigger_is_better": False,
        }

    def test_stores_the_normalized_schema_rather_than_the_request_body(
        self, api_client: TestClient, db_engine: Engine, create: Callable[..., Any]
    ) -> None:
        # D5: `schema_json` holds the same content `GET /api/suites/{name}` returns.
        create(metrics=[{"name": "execution_time", "type": "real"}])

        assert stored_schema(db_engine, "nts") == api_client.get(f"{SUITES}/nts").json()

    def test_what_it_returns_is_still_valid_input(
        self, api_client: TestClient, create: Callable[..., Any], manage: dict[str, str]
    ) -> None:
        # The property endpoints.md rests on: a suite fetched from one instance can be posted
        # verbatim to another. Here that shows up as a `duplicate`, not a validation failure.
        normalized = create().json()

        again = api_client.post(SUITES, json=normalized, headers=manage)

        assert code_of(again) == "duplicate"

    def test_creates_the_tables_the_schema_describes(
        self, db_engine: Engine, create: Callable[..., Any]
    ) -> None:
        create()

        assert "execution_time" in column_names(db_engine, "nts", "sample")
        assert "git_sha" in column_names(db_engine, "nts", "commit")
        assert "hardware" in column_names(db_engine, "nts", "machine")

    def test_refuses_a_name_already_taken(self, create: Callable[..., Any]) -> None:
        create()

        response = create()

        assert response.status_code == 409
        assert code_of(response) == "duplicate"

    @pytest.mark.parametrize(
        ("body", "reason"),
        [
            # One case per class of rule; the rules themselves are exercised at the model level in
            # `test_suite_schema.py`. What this proves is that a model failure surfaces as R4's 400
            # rather than as the framework's own 422.
            ({"name": "NTS"}, "a name rule"),
            ({"name": "nts", "metrics": [{"name": "m", "type": "status"}]}, "a type rule"),
            ({"name": "nts", "format_version": "5"}, "an unknown top-level key"),
        ],
    )
    def test_refuses_a_schema_that_does_not_validate(
        self,
        api_client: TestClient,
        manage: dict[str, str],
        body: dict[str, Any],
        reason: str,
    ) -> None:
        response = api_client.post(SUITES, json=body, headers=manage)

        assert response.status_code == 400, reason
        assert code_of(response) == "invalid_request"

    def test_reserves_no_name_for_routing(
        self, api_client: TestClient, create: Callable[..., Any]
    ) -> None:
        # R1: suite-scoped resources live one level below the suite collection, so routing reserves
        # nothing -- a suite may legally be named `admin` or `suites`.
        for name in ("admin", "suites"):
            assert create(name=name).status_code == 201
            assert api_client.get(f"{SUITES}/{name}").status_code == 200

    def test_accepts_a_name_at_the_identifier_limit(
        self, api_client: TestClient, db_engine: Engine, create: Callable[..., Any]
    ) -> None:
        # The name is a PostgreSQL namespace name, and the limit is exactly where PostgreSQL starts
        # truncating -- so a suite at the limit must still be addressable at that exact path.
        name = "a" * IDENTIFIER_MAX_LENGTH

        assert create(name=name).status_code == 201
        assert api_client.get(f"{SUITES}/{name}").status_code == 200
        assert name in inspect(db_engine).get_schema_names()

    def test_accepts_an_entry_name_at_the_identifier_limit(
        self, db_engine: Engine, create: Callable[..., Any]
    ) -> None:
        metric = "m" * IDENTIFIER_MAX_LENGTH

        assert create(metrics=[{"name": metric, "type": "real"}]).status_code == 201
        assert metric in column_names(db_engine, "nts", "sample")


class TestDetail:
    def test_round_trips_what_create_accepted(
        self, api_client: TestClient, create: Callable[..., Any]
    ) -> None:
        created = create().json()

        assert api_client.get(f"{SUITES}/nts").json() == created

    def test_is_404_for_a_name_that_is_not_there(self, api_client: TestClient) -> None:
        response = api_client.get(f"{SUITES}/nope")

        assert response.status_code == 404
        assert code_of(response) == "not_found"

    def test_the_schema_sub_path_is_not_a_readable_route(
        self, api_client: TestClient, create: Callable[..., Any]
    ) -> None:
        # `/{name}/schema` exists for PATCH alone. R4 has no 405, so a GET of it collapses to
        # "nothing here" (see errors.py).
        create()

        response = api_client.get(f"{SUITES}/nts/schema")

        assert response.status_code == 404
        assert code_of(response) == "not_found"

    def test_is_not_shadowed_by_the_spa_catch_all(
        self, api_client: TestClient, create: Callable[..., Any]
    ) -> None:
        create()

        assert "<title>LNT</title>" not in api_client.get(f"{SUITES}/nts").text

    def test_an_unimplemented_suite_scoped_path_is_a_json_404(
        self, api_client: TestClient, create: Callable[..., Any]
    ) -> None:
        # Not yet a route, and it must not fall through to index.html: an unmatched `/api/...` is a
        # genuine 404 carrying the error envelope (client/architecture.md).
        create()

        response = api_client.get(f"{SUITES}/nts/runs")

        assert response.status_code == 404
        assert code_of(response) == "not_found"


class TestEvolve:
    def test_adds_an_entry_and_its_column(
        self,
        api_client: TestClient,
        db_engine: Engine,
        create: Callable[..., Any],
        manage: dict[str, str],
    ) -> None:
        create()

        response = patch_request(
            api_client, manage, {"metrics": {"add": [{"name": "code_size", "type": "integer"}]}}
        )

        assert response.status_code == 200
        assert [m["name"] for m in response.json()["metrics"]] == [
            "compile_time",
            "execution_time",
            "code_size",
        ]
        assert "code_size" in column_names(db_engine, "nts", "sample")

    def test_appends_rather_than_reordering(
        self, api_client: TestClient, create: Callable[..., Any], manage: dict[str, str]
    ) -> None:
        # Entry order decides the suite's column order (D5) and is visible to clients.
        create()

        body = patch_request(
            api_client, manage, {"metrics": {"add": [{"name": "aaa", "type": "real"}]}}
        ).json()

        assert [m["name"] for m in body["metrics"]][-1] == "aaa"

    def test_updates_only_the_keys_it_is_given(
        self, api_client: TestClient, create: Callable[..., Any], manage: dict[str, str]
    ) -> None:
        create()

        body = patch_request(
            api_client, manage, {"metrics": {"update": [{"name": "compile_time", "unit": "ms"}]}}
        ).json()

        changed = next(m for m in body["metrics"] if m["name"] == "compile_time")
        assert changed["unit"] == "ms"
        # Everything the request did not mention is left alone.
        assert changed["display_name"] == "Compile Time"
        assert changed["unit_abbrev"] == "s"

    def test_clears_a_nullable_key_sent_as_null(
        self, api_client: TestClient, create: Callable[..., Any], manage: dict[str, str]
    ) -> None:
        create()

        body = patch_request(
            api_client,
            manage,
            {"metrics": {"update": [{"name": "compile_time", "display_name": None}]}},
        ).json()

        assert (
            next(m for m in body["metrics"] if m["name"] == "compile_time")["display_name"] is None
        )

    def test_refuses_a_boolean_key_sent_as_null(
        self, api_client: TestClient, create: Callable[..., Any], manage: dict[str, str]
    ) -> None:
        # D4 defaults these to false, so there is no unset state for a null to mean.
        create()

        response = patch_request(
            api_client,
            manage,
            {"machine_fields": {"update": [{"name": "hardware", "searchable": None}]}},
        )

        assert response.status_code == 400
        assert code_of(response) == "invalid_request"

    def test_updates_no_column(
        self,
        api_client: TestClient,
        db_engine: Engine,
        create: Callable[..., Any],
        manage: dict[str, str],
    ) -> None:
        create()
        before = column_names(db_engine, "nts", "sample")

        patch_request(
            api_client,
            manage,
            {"metrics": {"update": [{"name": "compile_time", "display_name": "CT"}]}},
        )

        assert column_names(db_engine, "nts", "sample") == before

    def test_removes_an_entry_and_its_column(
        self,
        api_client: TestClient,
        db_engine: Engine,
        create: Callable[..., Any],
        manage: dict[str, str],
    ) -> None:
        create()

        response = patch_request(
            api_client, manage, {"metrics": {"remove": ["compile_time"]}}, confirm=True
        )

        assert response.status_code == 200
        assert [m["name"] for m in response.json()["metrics"]] == ["execution_time"]
        assert "compile_time" not in column_names(db_engine, "nts", "sample")

    def test_moves_the_display_field_in_one_request(
        self, api_client: TestClient, create: Callable[..., Any], manage: dict[str, str]
    ) -> None:
        """The case only whole-schema revalidation can allow (D2).

        Checked incrementally, setting `display` on the second field would look like a second
        display field and be refused; validated as a whole, the request is legal.
        """
        create(
            commit_fields=[
                {"name": "a", "type": "text", "display": True},
                {"name": "b", "type": "text"},
            ]
        )

        response = patch_request(
            api_client,
            manage,
            {
                "commit_fields": {
                    "update": [{"name": "a", "display": False}, {"name": "b", "display": True}]
                }
            },
        )

        assert response.status_code == 200
        assert [f["display"] for f in response.json()["commit_fields"]] == [False, True]

    def test_refuses_an_update_that_would_break_the_whole_schema(
        self, api_client: TestClient, create: Callable[..., Any], manage: dict[str, str]
    ) -> None:
        # Only full revalidation catches this: the update model cannot see the entry's type.
        create(commit_fields=[{"name": "when", "type": "datetime"}])

        response = patch_request(
            api_client,
            manage,
            {"commit_fields": {"update": [{"name": "when", "searchable": True}]}},
        )

        assert response.status_code == 400
        assert code_of(response) == "invalid_request"

    def test_refuses_a_type_change(
        self, api_client: TestClient, create: Callable[..., Any], manage: dict[str, str]
    ) -> None:
        create()

        response = patch_request(
            api_client,
            manage,
            {"metrics": {"update": [{"name": "compile_time", "type": "integer"}]}},
        )

        assert response.status_code == 400
        assert code_of(response) == "invalid_request"

    def test_refuses_adding_an_entry_that_is_already_there(
        self, api_client: TestClient, create: Callable[..., Any], manage: dict[str, str]
    ) -> None:
        create()

        response = patch_request(
            api_client, manage, {"metrics": {"add": [{"name": "compile_time", "type": "real"}]}}
        )

        assert response.status_code == 409
        assert code_of(response) == "duplicate"

    @pytest.mark.parametrize(
        "body",
        [
            {"metrics": {"update": [{"name": "nope"}]}},
            {"metrics": {"remove": ["nope"]}},
        ],
    )
    def test_is_404_for_an_entry_that_is_not_in_that_list(
        self,
        api_client: TestClient,
        create: Callable[..., Any],
        manage: dict[str, str],
        body: dict[str, Any],
    ) -> None:
        create()

        response = patch_request(api_client, manage, body, confirm=True)

        assert response.status_code == 404
        assert code_of(response) == "not_found"

    def test_is_404_for_a_suite_that_is_not_there(
        self, api_client: TestClient, manage: dict[str, str]
    ) -> None:
        response = patch_request(
            api_client, manage, {"metrics": {"add": [{"name": "m", "type": "real"}]}}, name="nope"
        )

        assert response.status_code == 404

    @pytest.mark.parametrize(
        "body",
        [
            {"metrics": {"add": [{"name": "m", "type": "real"}], "remove": ["m"]}},
            {"metrics": {"remove": ["compile_time", "compile_time"]}},
            {"metrics": {"update": [{"name": "compile_time"}], "remove": ["compile_time"]}},
        ],
    )
    def test_refuses_touching_one_name_twice(
        self,
        api_client: TestClient,
        create: Callable[..., Any],
        manage: dict[str, str],
        body: dict[str, Any],
    ) -> None:
        # D2, counted with multiplicity: a name repeated inside one list would otherwise reach a
        # second DROP COLUMN and fail there rather than as a 400.
        create()

        response = patch_request(api_client, manage, body, confirm=True)

        assert response.status_code == 400
        assert code_of(response) == "invalid_request"

    def test_refuses_a_key_that_belongs_to_another_list(
        self, api_client: TestClient, create: Callable[..., Any], manage: dict[str, str]
    ) -> None:
        # The reason there are three update models rather than one carrying the union (D4).
        create()

        response = patch_request(
            api_client,
            manage,
            {"metrics": {"update": [{"name": "compile_time", "searchable": True}]}},
        )

        assert response.status_code == 400

    @pytest.mark.parametrize(
        "body",
        [
            {"metrics": {"ad": [{"name": "m", "type": "real"}]}},
            {"metricz": {"add": [{"name": "m", "type": "real"}]}},
            {"metrics": {"update": [{"name": "compile_time", "nonsense": 1}]}},
        ],
    )
    def test_refuses_an_unknown_key_at_any_level(
        self,
        api_client: TestClient,
        create: Callable[..., Any],
        manage: dict[str, str],
        body: dict[str, Any],
    ) -> None:
        # Without `extra="forbid"` at every level, a typo would be a silent no-op.
        create()

        assert patch_request(api_client, manage, body).status_code == 400


class TestEvolveConfirmation:
    def test_a_removal_needs_confirming(
        self,
        api_client: TestClient,
        db_engine: Engine,
        create: Callable[..., Any],
        manage: dict[str, str],
    ) -> None:
        create()

        response = patch_request(api_client, manage, {"metrics": {"remove": ["compile_time"]}})

        assert response.status_code == 400
        assert code_of(response) == "invalid_request"
        # And nothing happened.
        assert "compile_time" in column_names(db_engine, "nts", "sample")

    def test_confirm_false_is_not_a_confirmation(
        self, api_client: TestClient, create: Callable[..., Any], manage: dict[str, str]
    ) -> None:
        create()

        response = patch_request(
            api_client, manage, {"metrics": {"remove": ["compile_time"]}}, confirm=False
        )

        assert response.status_code == 400

    def test_a_value_that_is_not_a_boolean_is_refused(
        self, api_client: TestClient, create: Callable[..., Any], manage: dict[str, str]
    ) -> None:
        create()

        response = api_client.patch(
            f"{SUITES}/nts/schema?confirm=garbage",
            json={"metrics": {"remove": ["compile_time"]}},
            headers=manage,
        )

        assert response.status_code == 400

    def test_an_empty_removal_list_needs_no_confirmation(
        self, api_client: TestClient, create: Callable[..., Any], manage: dict[str, str]
    ) -> None:
        # The rule is *non-empty*; an implementation that checks presence instead gets this wrong.
        create()

        response = patch_request(
            api_client, manage, {"metrics": {"add": [{"name": "m", "type": "real"}], "remove": []}}
        )

        assert response.status_code == 200

    def test_an_add_alone_needs_no_confirmation(
        self, api_client: TestClient, create: Callable[..., Any], manage: dict[str, str]
    ) -> None:
        create()

        assert (
            patch_request(
                api_client, manage, {"metrics": {"add": [{"name": "m", "type": "real"}]}}
            ).status_code
            == 200
        )


def suite_tables_for(engine: Engine) -> Any:
    """The tables of the `nts` suite, built from what the endpoint stored."""
    return build(SuiteSchema.model_validate(stored_schema(engine, "nts")))


class TestEvolveAgainstStoredData:
    @pytest.fixture
    def populated(self, db_engine: Engine, create: Callable[..., Any]) -> Any:
        """A suite with a machine, a commit, a run and a sample carrying both metrics."""
        create()
        suite = suite_tables_for(db_engine)
        with db_engine.begin() as connection:
            machine = connection.execute(
                insert(suite.machine)
                .values(name="m", hardware="arm64")
                .returning(suite.machine.c.id)
            ).scalar_one()
            commit = connection.execute(
                insert(suite.commit).values(commit="abc").returning(suite.commit.c.id)
            ).scalar_one()
            test = connection.execute(
                insert(suite.test).values(name="t").returning(suite.test.c.id)
            ).scalar_one()
            run = connection.execute(
                insert(suite.run)
                .values(
                    uuid="11111111-1111-4111-8111-111111111111",
                    machine_id=machine,
                    commit_id=commit,
                )
                .returning(suite.run.c.id)
            ).scalar_one()
            connection.execute(
                insert(suite.sample).values(
                    run_id=run, test_id=test, compile_time=1.5, execution_time=2.5
                )
            )
        return suite

    def test_removing_a_metric_keeps_every_other_value(
        self,
        api_client: TestClient,
        db_engine: Engine,
        populated: Any,
        manage: dict[str, str],
    ) -> None:
        response = patch_request(
            api_client, manage, {"metrics": {"remove": ["compile_time"]}}, confirm=True
        )

        assert response.status_code == 200
        with db_engine.connect() as connection:
            assert connection.execute(select(populated.sample.c.execution_time)).scalar_one() == 2.5
            assert connection.execute(select(populated.run.c.uuid)).scalar_one() is not None
        assert "compile_time" not in column_names(db_engine, "nts", "sample")

    def test_adding_a_metric_leaves_existing_rows_without_a_value(
        self,
        api_client: TestClient,
        db_engine: Engine,
        populated: Any,
        manage: dict[str, str],
    ) -> None:
        # D2: adding an entry leaves existing rows with no value for it.
        patch_request(
            api_client, manage, {"metrics": {"add": [{"name": "code_size", "type": "integer"}]}}
        )

        with db_engine.connect() as connection:
            added = connection.execute(text("SELECT code_size FROM nts.sample")).scalar_one()
        assert added is None

    def test_deleting_the_suite_takes_its_data(
        self,
        api_client: TestClient,
        db_engine: Engine,
        populated: Any,
        manage: dict[str, str],
    ) -> None:
        # endpoints.md promises the suite "and all of its data"; the namespace going is what makes
        # every table in it unreachable, so the rows cannot outlive it.
        api_client.delete(f"{SUITES}/nts?confirm=true", headers=manage)

        with db_engine.connect() as connection, pytest.raises(ProgrammingError):
            connection.execute(select(populated.sample.c.id)).all()


class TestNoOpEvolve:
    def test_an_empty_request_changes_nothing_and_bumps_nothing(
        self,
        api_client: TestClient,
        db_engine: Engine,
        create: Callable[..., Any],
        manage: dict[str, str],
    ) -> None:
        # A no-op must not make every other worker reload for a change that did not happen (D2).
        created = create().json()
        before = schema_version_of(db_engine)

        response = patch_request(api_client, manage, {})

        assert response.status_code == 200
        assert response.json() == created
        with db_engine.connect() as connection:
            assert (
                connection.execute(text("SELECT version FROM schema_version")).scalar_one()
                == before
            )


class TestDelete:
    def test_removes_the_suite_and_its_namespace(
        self,
        api_client: TestClient,
        db_engine: Engine,
        create: Callable[..., Any],
        manage: dict[str, str],
    ) -> None:
        create()

        response = api_client.delete(f"{SUITES}/nts?confirm=true", headers=manage)

        assert response.status_code == 204
        assert response.content == b""
        assert api_client.get(f"{SUITES}/nts").status_code == 404
        assert api_client.get(SUITES).json()["items"] == []
        assert "nts" not in inspect(db_engine).get_schema_names()

    def test_needs_confirming(
        self,
        api_client: TestClient,
        db_engine: Engine,
        create: Callable[..., Any],
        manage: dict[str, str],
    ) -> None:
        create()

        response = api_client.delete(f"{SUITES}/nts", headers=manage)

        assert response.status_code == 400
        assert code_of(response) == "invalid_request"
        assert "nts" in inspect(db_engine).get_schema_names()

    def test_confirm_false_is_not_a_confirmation(
        self, api_client: TestClient, create: Callable[..., Any], manage: dict[str, str]
    ) -> None:
        create()

        assert api_client.delete(f"{SUITES}/nts?confirm=false", headers=manage).status_code == 400

    def test_is_404_for_a_suite_that_is_not_there(
        self, api_client: TestClient, manage: dict[str, str]
    ) -> None:
        response = api_client.delete(f"{SUITES}/nope?confirm=true", headers=manage)

        assert response.status_code == 404
        assert code_of(response) == "not_found"

    def test_resolves_the_suite_before_asking_for_confirmation(
        self, api_client: TestClient, manage: dict[str, str]
    ) -> None:
        # Deliberate and observable: suite existence is public through `GET /api/suites`, so
        # answering 404 first leaks nothing and tells the caller the more useful thing.
        response = api_client.delete(f"{SUITES}/nope", headers=manage)

        assert response.status_code == 404

    def test_frees_the_name_for_reuse(
        self, api_client: TestClient, create: Callable[..., Any], manage: dict[str, str]
    ) -> None:
        create()
        api_client.delete(f"{SUITES}/nts?confirm=true", headers=manage)

        assert create().status_code == 201


class TestConcurrentWrites:
    """Two workers changing one suite at once (D2).

    Driven by calling the endpoint functions directly on threads rather than through the test
    client, which serializes requests through a single portal and so could not overlap two
    transactions. These are the cases the version counter cannot help with: it is a read-path cache,
    and the hazard lives between a read and a write.
    """

    @staticmethod
    def add_metric(engine: Engine, name: str, metric: str) -> Any:
        return patch_schema(
            name,
            SchemaPatch.model_validate({"metrics": {"add": [{"name": metric, "type": "real"}]}}),
            engine,
        )

    def test_neither_of_two_concurrent_additions_is_lost(
        self, db_engine: Engine, create: Callable[..., Any]
    ) -> None:
        """The lost update a registry snapshot would cause.

        Both changes emit DDL, so if the second computed its new schema from a stale base it would
        still add its column while writing a `schema_json` that never mentions the first. The column
        would then be orphaned: invisible to every GET, unwritable because submissions reject
        undeclared keys (D6), and impossible to re-add. The row lock is what prevents it.
        """
        create()
        barrier = threading.Barrier(2)
        failures: list[BaseException] = []

        def add(metric: str) -> None:
            barrier.wait()
            try:
                self.add_metric(db_engine, "nts", metric)
            except BaseException as error:
                failures.append(error)

        threads = [threading.Thread(target=add, args=(m,)) for m in ("aaa", "bbb")]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()

        assert not failures, failures
        declared = {m["name"] for m in stored_schema(db_engine, "nts")["metrics"]}
        assert {"aaa", "bbb"} <= declared
        # The assertion that actually catches it: no column exists that the schema does not declare.
        assert set(column_names(db_engine, "nts", "sample")) == declared | {
            "id",
            "run_id",
            "test_id",
        }

    def test_a_change_racing_a_delete_does_not_deadlock(
        self, db_engine: Engine, create: Callable[..., Any]
    ) -> None:
        """A change and a delete take their locks in the same order, so neither waits on the other.

        With the DDL first and the row second, these two deadlock: the change holds the table and
        wants the row, the delete holds the row and wants the table. Either a 404 (the delete won)
        or success (the change won) is a correct outcome; a deadlock is not.
        """
        create()
        barrier = threading.Barrier(2)
        outcomes: list[str] = []

        def change() -> None:
            barrier.wait()
            try:
                self.add_metric(db_engine, "nts", "aaa")
                outcomes.append("changed")
            except ApiError as error:
                outcomes.append(f"change:{error.code.value}")

        def remove() -> None:
            barrier.wait()
            try:
                delete_suite("nts", db_engine, confirm=True)
                outcomes.append("deleted")
            except ApiError as error:
                outcomes.append(f"delete:{error.code.value}")

        threads = [threading.Thread(target=change), threading.Thread(target=remove)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=30)

        assert all(not thread.is_alive() for thread in threads), "a write never finished"
        # Whoever lost says so with a 404, never with an internal error.
        assert {"deleted"} <= set(outcomes), outcomes
        assert all(outcome in {"changed", "deleted", "change:not_found"} for outcome in outcomes), (
            outcomes
        )

    def test_an_update_only_change_after_a_delete_is_404(
        self, db_engine: Engine, create: Callable[..., Any], manage: dict[str, str]
    ) -> None:
        """An update emits no DDL, so nothing else would notice the suite had gone.

        Without the locked read this returns 200 and the detail body of a suite that no longer
        exists, because the `UPDATE` simply matches no rows.
        """
        create()
        delete_suite("nts", db_engine, confirm=True)

        with pytest.raises(ApiError) as raised:
            patch_schema(
                "nts",
                SchemaPatch.model_validate(
                    {"metrics": {"update": [{"name": "compile_time", "unit": "ms"}]}}
                ),
                db_engine,
            )

        assert raised.value.code is ErrorCode.NOT_FOUND


class TestWriteAuthorization:
    @pytest.mark.parametrize(
        ("method", "path"),
        [("post", SUITES), ("patch", f"{SUITES}/nts/schema"), ("delete", f"{SUITES}/nts")],
    )
    def test_a_write_needs_a_credential(
        self, api_client: TestClient, create: Callable[..., Any], method: str, path: str
    ) -> None:
        response = api_client.request(method.upper(), path, json={})

        assert response.status_code == 401
        assert code_of(response) == "unauthorized"

    @pytest.mark.parametrize(
        ("method", "path"),
        [("post", SUITES), ("patch", f"{SUITES}/nts/schema"), ("delete", f"{SUITES}/nts")],
    )
    def test_a_write_needs_more_than_read(
        self,
        api_client: TestClient,
        create: Callable[..., Any],
        make_key: Callable[..., str],
        bearer: Callable[[str], dict[str, str]],
        method: str,
        path: str,
    ) -> None:
        response = api_client.request(
            method.upper(), path, json={}, headers=bearer(make_key(Scope.READ))
        )

        assert response.status_code == 403
        assert code_of(response) == "forbidden"

    @pytest.mark.parametrize("method", ["patch", "delete"])
    def test_scope_is_checked_before_the_suite_is_resolved(
        self,
        api_client: TestClient,
        make_key: Callable[..., str],
        bearer: Callable[[str], dict[str, str]],
        method: str,
    ) -> None:
        # R5: resolving first and answering 404 would let an under-scoped caller enumerate which
        # suites exist.
        path = f"{SUITES}/nope/schema" if method == "patch" else f"{SUITES}/nope"

        response = api_client.request(
            method.upper(), path, json={}, headers=bearer(make_key(Scope.READ))
        )

        assert response.status_code == 403

    @pytest.mark.parametrize("method", ["patch", "delete"])
    def test_a_missing_credential_outranks_an_unknown_suite(
        self, api_client: TestClient, method: str
    ) -> None:
        path = f"{SUITES}/nope/schema" if method == "patch" else f"{SUITES}/nope"

        assert api_client.request(method.upper(), path, json={}).status_code == 401

    def test_a_higher_scope_may_write(
        self,
        api_client: TestClient,
        make_key: Callable[..., str],
        bearer: Callable[[str], dict[str, str]],
    ) -> None:
        # R5's hierarchy: a key grants its own scope plus every lower one.
        response = api_client.post(SUITES, json=NTS, headers=bearer(make_key(Scope.ADMIN)))

        assert response.status_code == 201

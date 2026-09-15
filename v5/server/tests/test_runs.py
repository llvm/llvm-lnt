"""The run endpoints (endpoints.md, Runs).

Driven over the real application and a real database, because almost everything worth checking here
is what PostgreSQL ends up holding: the rows a submission expands into (D6), the machine, commit and
tests it creates on the way (D7, D13), the cascade a delete reaches, and the atomicity that has to
hold across all of it.

The payload's own validation lives in `test_submission.py`, which drives `validate_submission`
directly; this module checks that the endpoint wires it up, and then everything that only exists
once a database is involved.
"""

from __future__ import annotations

import json
from collections.abc import Callable, Iterator
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime
from typing import Any
from uuid import UUID, uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import Engine, select, text

from conftest import code_of, encoded_profile, run_payload
from introspection import counted, counting_statements
from lnt_v5.app import create_app
from lnt_v5.config import Settings
from lnt_v5.routes.commits import COMMITS_PATH
from lnt_v5.routes.machines import MACHINES_PATH
from lnt_v5.routes.runs import RUNS_PATH
from lnt_v5.routes.suites import SUITES_PATH
from lnt_v5.scopes import Scope
from lnt_v5.suites.submission import validate_submission
from lnt_v5.suites.tables import SuiteTables

RUNS = RUNS_PATH.format(testsuite="nts")
MACHINES = MACHINES_PATH.format(testsuite="nts")
COMMITS = COMMITS_PATH.format(testsuite="nts")

# Two reals and an integer, so that a sample row can be checked for the columns a submission did
# *not* mention as well as the ones it did, and fields on both entities for D7's reconciliation.
NTS: dict[str, Any] = {
    "name": "nts",
    "metrics": [
        {"name": "execution_time", "type": "real"},
        {"name": "compile_time", "type": "real"},
        {"name": "compile_status", "type": "integer"},
    ],
    "machine_fields": [
        {"name": "hardware", "type": "text"},
        {"name": "core_count", "type": "integer"},
    ],
    "commit_fields": [
        {"name": "git_sha", "type": "text"},
        {"name": "author", "type": "text"},
    ],
}

METRICS = [metric["name"] for metric in NTS["metrics"]]

# D12 fixes the format version at 2, so every profile a test submits starts with that byte.
PROFILE = bytes([2, 0xAB, 0xCD])

# What a submission measures when the test does not care what it measured. `conftest.run_payload`
# defaults to no tests at all, which is the minimal D6 body; most of these tests want a run that
# produced a row, so they start from one entry instead.
MEASURED = [{"name": "suite/one", "execution_time": 1.5}]

# What endpoints.md scopes above `read`, with a body each accepts.
WRITES = [
    ("post", RUNS, Scope.SUBMIT),
    ("delete", f"{RUNS}/{{uuid}}", Scope.MANAGE),
]


def payload(**overrides: Any) -> dict[str, Any]:
    """D6's body with one test entry, and whichever keys a test cares about replaced.

    The body's shape is `conftest.run_payload`'s, shared with `test_submission.py`; all this adds
    is the default these endpoint tests want.
    """
    return run_payload(**{"tests": MEASURED, **overrides})


def recent(moment: datetime) -> bool:
    """Whether a timestamp the database produced plausibly belongs to this test run.

    A tolerance rather than a bracket around `datetime.now()`: the clock is PostgreSQL's, which is
    a container's here, and a few seconds of skew against this process is not a defect.
    """
    return abs((datetime.now(UTC) - moment).total_seconds()) < 600


@pytest.fixture
def suite(make_api_suite: Callable[[dict[str, Any]], SuiteTables]) -> SuiteTables:
    """The `nts` suite, created through the API, with its tables for reading the database back."""
    return make_api_suite(NTS)


@pytest.fixture
def submitter(
    make_key: Callable[..., str], bearer: Callable[[str], dict[str, str]]
) -> dict[str, str]:
    """The header for a `submit` key -- exactly what endpoints.md gives `POST /runs` (R5)."""
    return bearer(make_key(Scope.SUBMIT))


@pytest.fixture
def submit(
    api_client: TestClient, submitter: dict[str, str], suite: SuiteTables
) -> Callable[..., Any]:
    """Submit a run. Named keys replace the corresponding top-level key of the payload."""

    def post(**overrides: Any) -> Any:
        return api_client.post(RUNS, json=payload(**overrides), headers=submitter)

    return post


@pytest.fixture
def submitted(submit: Callable[..., Any]) -> Callable[..., Any]:
    """Submit a run and hand back its body, having insisted the submission succeeded."""

    def post(**overrides: Any) -> Any:
        response = submit(**overrides)
        assert response.status_code == 201, response.text
        return response.json()

    return post


def samples(db_engine: Engine, suite: SuiteTables) -> list[dict[str, Any]]:
    """Every sample row in the suite, named by its test, in an order a test can compare against."""
    with db_engine.connect() as connection:
        rows = (
            connection.execute(
                select(
                    suite.test.c.name.label("test"),
                    *(suite.sample.c[metric] for metric in METRICS),
                ).join_from(suite.sample, suite.test, suite.test.c.id == suite.sample.c.test_id)
            )
            .mappings()
            .all()
        )
    return sorted((dict(row) for row in rows), key=repr)


def profiles(db_engine: Engine, suite: SuiteTables) -> list[dict[str, Any]]:
    """Every profile row in the suite, named by its test."""
    with db_engine.connect() as connection:
        rows = (
            connection.execute(
                select(
                    suite.test.c.name.label("test"),
                    suite.profile.c.uuid,
                    suite.profile.c.created_at,
                    suite.profile.c.data,
                ).join_from(suite.profile, suite.test, suite.test.c.id == suite.profile.c.test_id)
            )
            .mappings()
            .all()
        )
    return sorted((dict(row) for row in rows), key=lambda row: str(row["test"]))


class TestSubmit:
    def test_returns_the_created_run_and_where_to_find_it(
        self, api_client: TestClient, submit: Callable[..., Any]
    ) -> None:
        response = submit()

        assert response.status_code == 201
        assert response.headers["Location"] == f"{RUNS}/{response.json()['uuid']}"
        assert api_client.get(response.headers["Location"]).json() == response.json()

    def test_carries_exactly_the_keys_endpoints_md_names(
        self, submitted: Callable[..., Any]
    ) -> None:
        # R4: `machine` and `commit` are the referenced entity's identifier rather than a nested
        # object, and every documented key is present.
        body = submitted(run_parameters={"build_config": "Release"})

        assert set(body) == {"uuid", "machine", "commit", "submitted_at", "run_parameters"}
        assert body["machine"] == "linux"
        assert body["commit"] == "abc123"
        assert body["run_parameters"] == {"build_config": "Release"}

    @pytest.mark.parametrize("version", ["4", 5, None])
    def test_requires_the_one_format_version_that_exists(
        self, submit: Callable[..., Any], version: Any
    ) -> None:
        response = submit(format_version=version)

        assert response.status_code == 400
        assert code_of(response) == "invalid_request"

    def test_requires_format_version_to_be_there_at_all(
        self, api_client: TestClient, submitter: dict[str, str], suite: SuiteTables
    ) -> None:
        body = payload()
        del body["format_version"]

        assert api_client.post(RUNS, json=body, headers=submitter).status_code == 400

    def test_run_parameters_default_to_an_empty_object(self, submitted: Callable[..., Any]) -> None:
        assert submitted()["run_parameters"] == {}

    def test_run_parameters_round_trip_verbatim(self, submitted: Callable[..., Any]) -> None:
        parameters = {"flags": ["-O2", "-g"], "nested": {"jobs": 8, "ok": True}, "none": None}

        assert submitted(run_parameters=parameters)["run_parameters"] == parameters

    @pytest.mark.parametrize(
        "parameters",
        [
            {"x": float("nan")},
            {"x": float("inf")},
            {"x": float("-inf")},
            {"nested": {"deep": [1, float("nan")]}},
        ],
    )
    def test_refuses_a_non_finite_number_in_run_parameters(
        self,
        api_client: TestClient,
        submitter: dict[str, str],
        suite: SuiteTables,
        parameters: dict[str, Any],
    ) -> None:
        # D6: JSON has no literal for any of these, but Python's parser accepts all three and JSONB
        # does not, so one would otherwise fail in the database -- a 500 for a value the caller
        # supplied, which R4 makes an `invalid_request`. Serialized here with `json.dumps`, which
        # emits them, rather than through the client, which may refuse to.
        response = api_client.post(
            RUNS,
            content=json.dumps(payload(run_parameters=parameters)),
            headers={**submitter, "content-type": "application/json"},
        )

        assert response.status_code == 400, response.text
        assert code_of(response) == "invalid_request"

    def test_accepts_a_run_that_measured_nothing(
        self, db_engine: Engine, suite: SuiteTables, submitted: Callable[..., Any]
    ) -> None:
        # D6: a run that measured nothing is still a run.
        submitted(tests=[])

        assert counted(db_engine, suite, "run") == 1
        assert samples(db_engine, suite) == []

    @pytest.mark.parametrize(
        "overrides",
        [
            {"machine": {"name": "lin\x00ux"}},
            {"commit": {"value": "abc\x00123"}},
            {"machine": {"name": "linux", "fields": {"hardware": "x86\x0064"}}},
            {"run_parameters": {"build_config": "Rel\x00ease"}},
            {"run_parameters": {"bu\x00ild": "Release"}},
            {"tests": [{"name": "suite/o\x00ne"}]},
        ],
    )
    def test_a_nul_character_anywhere_is_a_bad_request_rather_than_a_fault(
        self, submit: Callable[..., Any], overrides: dict[str, Any]
    ) -> None:
        # D3: PostgreSQL stores a NUL in neither `text` nor `jsonb`, and raises a `DataError` that
        # nothing attributes -- so without the checks in front of the write every one of these
        # would reach the catch-all handler as a 500 for a value the caller supplied. One case per
        # place a submission can carry a string, because the rule is only worth anything if it
        # holds at all of them.
        response = submit(**overrides)

        assert response.status_code == 400, response.text
        assert code_of(response) == "invalid_request"

    def test_is_404_for_a_suite_that_is_not_there(
        self, api_client: TestClient, submitter: dict[str, str]
    ) -> None:
        response = api_client.post(f"{SUITES_PATH}/nope/runs", json=payload(), headers=submitter)

        assert response.status_code == 404
        assert code_of(response) == "not_found"


class TestUuid:
    def test_keeps_the_one_the_client_supplied(self, submitted: Callable[..., Any]) -> None:
        given = "550e8400-e29b-41d4-a716-446655440000"

        assert submitted(uuid=given)["uuid"] == given

    def test_normalizes_it_to_lowercase(self, submitted: Callable[..., Any]) -> None:
        # D6: stored lowercased, which is also the form the `Location` header and every later
        # lookup use.
        assert submitted(uuid="550E8400-E29B-41D4-A716-446655440000")["uuid"] == (
            "550e8400-e29b-41d4-a716-446655440000"
        )

    def test_generates_one_when_the_submission_omits_it(
        self, submitted: Callable[..., Any]
    ) -> None:
        generated = submitted()["uuid"]

        assert UUID(generated).version == 4
        assert generated == generated.lower()

    def test_generates_a_different_one_for_each_run(self, submitted: Callable[..., Any]) -> None:
        # endpoints.md: v5 always creates a new run, so two submissions for the same machine and
        # commit are two runs.
        assert submitted()["uuid"] != submitted()["uuid"]

    def test_refuses_one_that_is_not_in_the_hyphenated_form(
        self, submit: Callable[..., Any]
    ) -> None:
        # One case rather than the matrix: what the endpoint owes is that a UUID D6 refuses comes
        # back as R4's 400 in the error envelope. Which spellings are refused -- braced, prefixed,
        # a digit short, a trailing newline -- is `test_submission.py`'s, which settles it without
        # a CREATE SCHEMA per case.
        response = submit(uuid="550e8400e29b41d4a716446655440000")

        assert response.status_code == 400
        assert code_of(response) == "invalid_request"

    def test_refuses_a_uuid_a_run_already_has(self, submit: Callable[..., Any]) -> None:
        # R4 gives this `duplicate` rather than the generic conflict: a submitting bot recovers by
        # retrying with a fresh UUID.
        given = "550e8400-e29b-41d4-a716-446655440000"
        assert submit(uuid=given).status_code == 201

        response = submit(uuid=given)

        assert response.status_code == 409
        assert code_of(response) == "duplicate"

    def test_the_duplicate_check_sees_through_the_case(self, submit: Callable[..., Any]) -> None:
        # Runs are stored lowercased, so two spellings of one UUID are one UUID.
        assert submit(uuid="550e8400-e29b-41d4-a716-446655440000").status_code == 201

        response = submit(uuid="550E8400-E29B-41D4-A716-446655440000")

        assert response.status_code == 409
        assert code_of(response) == "duplicate"

    def test_a_refused_duplicate_leaves_the_first_run_alone(
        self, db_engine: Engine, suite: SuiteTables, submit: Callable[..., Any]
    ) -> None:
        given = "550e8400-e29b-41d4-a716-446655440000"
        submit(uuid=given)

        submit(uuid=given, tests=[{"name": "suite/other", "execution_time": 9.0}])

        assert counted(db_engine, suite, "run") == 1
        assert [row["test"] for row in samples(db_engine, suite)] == ["suite/one"]


class TestSubmittedAt:
    def test_is_the_value_the_database_recorded(
        self, db_engine: Engine, suite: SuiteTables, submitted: Callable[..., Any]
    ) -> None:
        # D5 and D6: the column's `now()` default rather than anything this process computed, so
        # that concurrent workers agree on the ordering it defines. The response is that value read
        # back, not a second opinion.
        body = submitted()

        with db_engine.connect() as connection:
            stored = connection.execute(select(suite.run.c.submitted_at)).scalar_one()
        assert datetime.fromisoformat(body["submitted_at"]) == stored

    def test_is_serialized_as_utc(self, submitted: Callable[..., Any]) -> None:
        # D5: always rendered in UTC with a `Z` suffix.
        assert submitted()["submitted_at"].endswith("Z")

    def test_is_roughly_now(self, submitted: Callable[..., Any]) -> None:
        assert recent(datetime.fromisoformat(submitted()["submitted_at"]))

    def test_the_submission_cannot_supply_it(self, submit: Callable[..., Any]) -> None:
        # D6 has no such key, and `extra="forbid"` is what turns sending one into a 400 rather than
        # a value silently ignored.
        response = submit(submitted_at="2020-01-01T00:00:00Z")

        assert response.status_code == 400
        assert code_of(response) == "invalid_request"


class TestImplicitCreation:
    """D7: the machine, the commit and the tests a run names are created if they are not there."""

    def test_creates_the_machine_with_what_the_submission_sent(
        self, api_client: TestClient, submitted: Callable[..., Any]
    ) -> None:
        submitted(
            machine={
                "name": "linux",
                "tracked": False,
                "fields": {"hardware": "x86_64", "core_count": 8},
            }
        )

        machine = api_client.get(f"{MACHINES}/linux").json()
        assert machine["tracked"] is False
        assert machine["fields"] == {"hardware": "x86_64", "core_count": 8}

    def test_creates_the_commit_with_what_the_submission_sent(
        self, api_client: TestClient, submitted: Callable[..., Any]
    ) -> None:
        submitted(commit={"value": "abc123", "ordinal": 42, "fields": {"author": "Jane"}})

        commit = api_client.get(f"{COMMITS}/abc123").json()
        assert commit["ordinal"] == 42
        assert commit["fields"] == {"git_sha": None, "author": "Jane"}

    def test_creates_every_test_it_names(
        self, db_engine: Engine, suite: SuiteTables, submitted: Callable[..., Any]
    ) -> None:
        submitted(tests=[{"name": "suite/one"}, {"name": "suite/two"}, {"name": "other/three"}])

        assert counted(db_engine, suite, "test") == 3

    def test_reuses_the_machine_commit_and_tests_of_an_earlier_run(
        self, db_engine: Engine, suite: SuiteTables, submitted: Callable[..., Any]
    ) -> None:
        submitted()
        submitted()

        assert counted(db_engine, suite, "run") == 2
        assert counted(db_engine, suite, "machine") == 1
        assert counted(db_engine, suite, "commit") == 1
        assert counted(db_engine, suite, "test") == 1

    def test_the_created_machine_is_addressable_by_the_name_that_was_submitted(
        self, api_client: TestClient, submitted: Callable[..., Any]
    ) -> None:
        # R1: the response binds `machine` to the machine's own identifier, so the value a client
        # reads off a run is the one it addresses the machine with.
        body = submitted(machine={"name": "linux-x86_64"})

        assert api_client.get(f"{MACHINES}/{body['machine']}").json()["name"] == "linux-x86_64"

    def test_the_created_commit_is_addressable_by_the_value_that_was_submitted(
        self, api_client: TestClient, submitted: Callable[..., Any]
    ) -> None:
        body = submitted(commit={"value": "014621ede7c1"})

        assert api_client.get(f"{COMMITS}/{body['commit']}").json()["value"] == "014621ede7c1"

    @pytest.mark.parametrize("name", ["a/b", ".", ".."])
    def test_refuses_a_machine_name_no_url_could_address(
        self, submit: Callable[..., Any], name: str
    ) -> None:
        # R1: implicit creation is bound by the same rule as explicit creation, since the machine
        # would otherwise exist at an address nothing can reach.
        response = submit(machine={"name": name})

        assert response.status_code == 400
        assert code_of(response) == "invalid_request"

    @pytest.mark.parametrize("value", ["a/b", ".", ".."])
    def test_refuses_a_commit_value_no_url_could_address(
        self, submit: Callable[..., Any], value: str
    ) -> None:
        response = submit(commit={"value": value})

        assert response.status_code == 400
        assert code_of(response) == "invalid_request"


class TestMetadataReconciliation:
    """D7 end to end: a submission never overwrites metadata, and only fills in what is missing."""

    def test_a_matching_value_is_accepted(self, submit: Callable[..., Any]) -> None:
        machine = {"name": "linux", "fields": {"hardware": "x86_64"}}
        assert submit(machine=machine).status_code == 201

        assert submit(machine=machine).status_code == 201

    def test_a_stored_null_is_filled_in(
        self, api_client: TestClient, submitted: Callable[..., Any]
    ) -> None:
        # How a producer that starts sending a newly declared field populates the records that
        # predate it.
        submitted(machine={"name": "linux", "fields": {"hardware": "x86_64"}})

        submitted(machine={"name": "linux", "fields": {"core_count": 8}})

        assert api_client.get(f"{MACHINES}/linux").json()["fields"] == {
            "hardware": "x86_64",
            "core_count": 8,
        }

    def test_a_contradicted_field_is_a_conflict(
        self, api_client: TestClient, submit: Callable[..., Any]
    ) -> None:
        submit(machine={"name": "linux", "fields": {"hardware": "x86_64"}})

        response = submit(machine={"name": "linux", "fields": {"hardware": "aarch64"}})

        # R4's generic `conflict`: none of the more specific 409s describes machine metadata.
        assert response.status_code == 409
        assert code_of(response) == "conflict"
        assert api_client.get(f"{MACHINES}/linux").json()["fields"]["hardware"] == "x86_64"

    def test_a_contradicted_commit_field_is_a_conflict_too(
        self, submit: Callable[..., Any]
    ) -> None:
        submit(commit={"value": "abc123", "fields": {"author": "Jane"}})

        response = submit(commit={"value": "abc123", "fields": {"author": "Ashok"}})

        assert response.status_code == 409
        assert code_of(response) == "conflict"

    def test_tracked_is_first_write_wins(
        self, api_client: TestClient, submitted: Callable[..., Any]
    ) -> None:
        # D6 and D7 exclude `tracked` from the match: it is a policy flag operators change, so a
        # later submission disagreeing about it is ignored rather than refused.
        submitted(machine={"name": "linux", "tracked": False})

        submitted(machine={"name": "linux", "tracked": True})

        assert api_client.get(f"{MACHINES}/linux").json()["tracked"] is False

    def test_two_submitters_sending_different_subsets_coexist(
        self, api_client: TestClient, submit: Callable[..., Any]
    ) -> None:
        # The property D7 is really after: a key a submission omits is not compared at all, so a
        # producer that knows the hardware and one that knows the core count both succeed, and
        # neither is broken by the other having filled in a field it does not send.
        hardware = {"name": "linux", "fields": {"hardware": "x86_64"}}
        cores = {"name": "linux", "fields": {"core_count": 8}}

        assert submit(machine=hardware).status_code == 201
        assert submit(machine=cores).status_code == 201
        assert submit(machine=hardware).status_code == 201

        assert api_client.get(f"{MACHINES}/linux").json()["fields"] == {
            "hardware": "x86_64",
            "core_count": 8,
        }

    def test_refuses_an_undeclared_field(self, submit: Callable[..., Any]) -> None:
        response = submit(machine={"name": "linux", "fields": {"kernel": "6.1"}})

        assert response.status_code == 400
        assert code_of(response) == "invalid_request"


class TestOrdinal:
    """D11, inline: a submission may place a commit in the order but may never move it."""

    def test_sets_the_ordinal_of_a_commit_that_has_none(
        self, api_client: TestClient, submitted: Callable[..., Any]
    ) -> None:
        submitted(commit={"value": "abc123"})

        submitted(commit={"value": "abc123", "ordinal": 42})

        assert api_client.get(f"{COMMITS}/abc123").json()["ordinal"] == 42

    def test_accepts_the_ordinal_the_commit_already_has(self, submit: Callable[..., Any]) -> None:
        commit = {"value": "abc123", "ordinal": 42}
        assert submit(commit=commit).status_code == 201

        assert submit(commit=commit).status_code == 201

    def test_refuses_an_ordinal_that_contradicts_the_stored_one(
        self, api_client: TestClient, submit: Callable[..., Any]
    ) -> None:
        submit(commit={"value": "abc123", "ordinal": 42})

        response = submit(commit={"value": "abc123", "ordinal": 43})

        assert response.status_code == 409
        assert code_of(response) == "ordinal_conflict"
        assert api_client.get(f"{COMMITS}/abc123").json()["ordinal"] == 42

    def test_refuses_an_ordinal_another_commit_holds(self, submit: Callable[..., Any]) -> None:
        submit(commit={"value": "abc123", "ordinal": 42})

        response = submit(commit={"value": "def456", "ordinal": 42})

        assert response.status_code == 409
        assert code_of(response) == "ordinal_conflict"

    def test_an_omitted_ordinal_never_contradicts(
        self, api_client: TestClient, submitted: Callable[..., Any]
    ) -> None:
        submitted(commit={"value": "abc123", "ordinal": 42})

        submitted(commit={"value": "abc123"})

        assert api_client.get(f"{COMMITS}/abc123").json()["ordinal"] == 42


class TestSamples:
    """D6: what a test entry expands into, as the rows PostgreSQL ends up holding."""

    def test_stores_the_scalars_an_entry_carries(
        self, db_engine: Engine, suite: SuiteTables, submitted: Callable[..., Any]
    ) -> None:
        submitted(tests=[{"name": "suite/one", "execution_time": 1.5, "compile_status": 0}])

        # The metric the entry did not mention is NULL, which is what "no value" means (D6).
        assert samples(db_engine, suite) == [
            {
                "test": "suite/one",
                "execution_time": 1.5,
                "compile_time": None,
                "compile_status": 0,
            }
        ]

    def test_an_array_becomes_one_row_per_element(
        self, db_engine: Engine, suite: SuiteTables, submitted: Callable[..., Any]
    ) -> None:
        submitted(tests=[{"name": "suite/one", "execution_time": [1.0, 2.0, 3.0]}])

        assert [row["execution_time"] for row in samples(db_engine, suite)] == [1.0, 2.0, 3.0]

    def test_scalars_are_repeated_across_the_rows_an_array_produces(
        self, db_engine: Engine, suite: SuiteTables, submitted: Callable[..., Any]
    ) -> None:
        submitted(
            tests=[
                {
                    "name": "suite/one",
                    "execution_time": [1.0, 2.0],
                    "compile_time": [10.0, 20.0],
                    "compile_status": 0,
                }
            ]
        )

        assert samples(db_engine, suite) == sorted(
            [
                {
                    "test": "suite/one",
                    "execution_time": 1.0,
                    "compile_time": 10.0,
                    "compile_status": 0,
                },
                {
                    "test": "suite/one",
                    "execution_time": 2.0,
                    "compile_time": 20.0,
                    "compile_status": 0,
                },
            ],
            key=repr,
        )

    def test_an_entry_with_no_metrics_still_records_that_the_test_ran(
        self, db_engine: Engine, suite: SuiteTables, submitted: Callable[..., Any]
    ) -> None:
        # D6: an entry yields max(1, array length) rows, so this one is a row of nothing but the
        # run and test it belongs to.
        submitted(tests=[{"name": "suite/one"}])

        assert samples(db_engine, suite) == [
            {
                "test": "suite/one",
                "execution_time": None,
                "compile_time": None,
                "compile_status": None,
            }
        ]

    def test_entries_carrying_different_metrics_each_land_in_their_own_columns(
        self, db_engine: Engine, suite: SuiteTables, submitted: Callable[..., Any]
    ) -> None:
        """The executemany footgun, as a test.

        SQLAlchemy Core compiles a multi-row INSERT from the *first* mapping it is given and binds
        every later one to those columns, so a submission whose entries mention different metrics
        would silently write the wrong ones -- here, `compile_time` into nothing and
        `execution_time` into the column the first row happened to name. Deliberately ordered so
        that the narrowest entry comes first.
        """
        submitted(
            tests=[
                {"name": "suite/one", "compile_time": 10.0},
                {"name": "suite/two", "execution_time": 2.0, "compile_status": 1},
                {"name": "suite/three"},
            ]
        )

        assert samples(db_engine, suite) == sorted(
            [
                {
                    "test": "suite/one",
                    "execution_time": None,
                    "compile_time": 10.0,
                    "compile_status": None,
                },
                {
                    "test": "suite/two",
                    "execution_time": 2.0,
                    "compile_time": None,
                    "compile_status": 1,
                },
                {
                    "test": "suite/three",
                    "execution_time": None,
                    "compile_time": None,
                    "compile_status": None,
                },
            ],
            key=repr,
        )

    def test_attaches_every_sample_to_the_run_that_carried_it(
        self, db_engine: Engine, suite: SuiteTables, submitted: Callable[..., Any]
    ) -> None:
        first = submitted(tests=[{"name": "suite/one", "execution_time": 1.0}])
        submitted(tests=[{"name": "suite/one", "execution_time": 2.0}])

        with db_engine.connect() as connection:
            attached = connection.execute(
                select(suite.sample.c.execution_time)
                .join_from(suite.run, suite.sample, suite.sample.c.run_id == suite.run.c.id)
                .where(suite.run.c.uuid == first["uuid"])
            ).scalars()
        assert list(attached) == [1.0]

    def test_a_submission_of_many_samples_is_stored_whole(
        self, db_engine: Engine, suite: SuiteTables, submitted: Callable[..., Any]
    ) -> None:
        # One statement rather than one per row is what makes this affordable; what matters to a
        # caller is that every row arrives.
        submitted(
            tests=[
                {"name": f"suite/test-{index:04d}", "execution_time": [float(index), 0.5]}
                for index in range(500)
            ]
        )

        assert counted(db_engine, suite, "sample") == 1000
        assert counted(db_engine, suite, "test") == 500

    def test_costs_one_insert_however_many_samples_there_are(
        self, submitted: Callable[..., Any]
    ) -> None:
        """D13's cost guarantee for the sample set, which the rows alone cannot show.

        A statement per row stores exactly the same 1 000 samples as one executemany does, and
        passes every other test here while making a submission's cost linear in round trips. So
        this counts the statements: a submission two orders of magnitude larger must still be one
        insert.
        """
        with counting_statements("INSERT INTO nts.sample") as one_row:
            submitted(tests=[{"name": "suite/one", "execution_time": 1.0}])
        with counting_statements("INSERT INTO nts.sample") as many_rows:
            submitted(
                tests=[
                    {"name": f"suite/test-{index:04d}", "execution_time": [float(index)] * 10}
                    for index in range(100)
                ]
            )

        assert len(many_rows) == len(one_row) == 1


class TestProfiles:
    """D12: one profile row per run+test, with the bytes the submission encoded."""

    def test_stores_the_decoded_bytes(
        self, db_engine: Engine, suite: SuiteTables, submitted: Callable[..., Any]
    ) -> None:
        submitted(tests=[{"name": "suite/one", "profile": encoded_profile(0xAB, 0xCD)}])

        stored = profiles(db_engine, suite)
        assert [row["data"] for row in stored] == [PROFILE]
        assert stored[0]["test"] == "suite/one"

    def test_gives_each_profile_a_server_generated_uuid(
        self, db_engine: Engine, suite: SuiteTables, submitted: Callable[..., Any]
    ) -> None:
        # R1: a run's UUID may be the client's, and every other UUID in the API is the server's --
        # the submission format has nowhere to put one for a profile.
        submitted(
            tests=[
                {"name": "suite/one", "profile": encoded_profile(1)},
                {"name": "suite/two", "profile": encoded_profile(2)},
            ]
        )

        minted = {row["uuid"] for row in profiles(db_engine, suite)}
        assert len(minted) == 2
        assert all(UUID(value).version == 4 for value in minted)

    def test_records_when_each_was_created(
        self, db_engine: Engine, suite: SuiteTables, submitted: Callable[..., Any]
    ) -> None:
        # D5 gives the column a default, so the value comes from the database's clock.
        submitted(tests=[{"name": "suite/one", "profile": encoded_profile(1)}])

        assert recent(profiles(db_engine, suite)[0]["created_at"])

    def test_writes_one_row_per_run_and_test(
        self, db_engine: Engine, suite: SuiteTables, submitted: Callable[..., Any]
    ) -> None:
        # D5's unique constraint is on (run_id, test_id), so the same test profiled in two runs is
        # two rows rather than a duplicate.
        entry = [{"name": "suite/one", "profile": encoded_profile(1)}]
        submitted(tests=entry)
        submitted(tests=entry)

        assert counted(db_engine, suite, "profile") == 2

    def test_an_entry_with_no_profile_creates_no_row(
        self, db_engine: Engine, suite: SuiteTables, submitted: Callable[..., Any]
    ) -> None:
        submitted(
            tests=[
                {"name": "suite/one", "profile": encoded_profile(1)},
                {"name": "suite/two"},
                {"name": "suite/three", "profile": None},
            ]
        )

        assert [row["test"] for row in profiles(db_engine, suite)] == ["suite/one"]

    def test_refuses_a_blob_it_cannot_decode(self, submit: Callable[..., Any]) -> None:
        # One case rather than the matrix: what the endpoint owes is that a profile D12 refuses
        # comes back as R4's 400 in the error envelope. Which blobs are refused -- bad padding, an
        # empty one, the wrong version byte, one over the size cap -- is `test_submission.py`'s,
        # which settles it without a CREATE SCHEMA per case.
        response = submit(tests=[{"name": "suite/one", "profile": "not base64!"}])

        assert response.status_code == 400
        assert code_of(response) == "invalid_request"

    def test_nothing_is_written_when_a_profile_is_refused(
        self, db_engine: Engine, suite: SuiteTables, submit: Callable[..., Any]
    ) -> None:
        # Validation is pure and runs in front of the write (D6), so a bad profile on the second
        # entry costs the first one nothing.
        submit(
            tests=[
                {"name": "suite/one", "execution_time": 1.0},
                {"name": "suite/two", "profile": "not base64!"},
            ]
        )

        assert counted(db_engine, suite, "run") == 0
        assert counted(db_engine, suite, "machine") == 0
        assert counted(db_engine, suite, "test") == 0


class TestOversizedBody:
    def test_a_body_larger_than_the_deployment_accepts_is_413(
        self, api_settings: Settings, submitter: dict[str, str], suite: SuiteTables
    ) -> None:
        # R4 puts this at the transport layer, outside the REST API surface and outside the error
        # envelope -- and distinct from the 400 an oversized *profile* gets, which is a limit on one
        # profile rather than on the request carrying it (D12).
        client = TestClient(create_app(api_settings.model_copy(update={"body_limit": 64})))

        with client:
            response = client.post(
                RUNS, json=payload(run_parameters={"padding": "x" * 1000}), headers=submitter
            )

        assert response.status_code == 413
        assert response.headers["content-type"].startswith("text/plain")


class TestAtomicity:
    """D13: a submission either fully succeeds or leaves nothing at all behind."""

    @pytest.fixture
    def failed_halfway(
        self, api_client: TestClient, manage: dict[str, str], submit: Callable[..., Any]
    ) -> Any:
        """A submission that gets as far as creating its machine and is then refused.

        The ordinal is the lever: the machine is resolved before the commit, so a commit that
        already holds a different ordinal rejects the submission only after a machine that did not
        exist has been inserted. Everything written up to that point has to disappear with it.
        """
        created = api_client.post(COMMITS, json={"value": "abc123", "ordinal": 1}, headers=manage)
        assert created.status_code == 201, created.text

        return submit(
            machine={"name": "brand-new", "fields": {"hardware": "x86_64"}},
            commit={"value": "abc123", "ordinal": 2},
            tests=[{"name": "suite/one", "execution_time": 1.0, "profile": encoded_profile(1)}],
        )

    def test_the_submission_is_refused(self, failed_halfway: Any) -> None:
        assert failed_halfway.status_code == 409
        assert code_of(failed_halfway) == "ordinal_conflict"

    @pytest.mark.usefixtures("failed_halfway")
    @pytest.mark.parametrize("table", ["machine", "run", "test", "sample", "profile"])
    def test_nothing_it_created_survives(
        self, db_engine: Engine, suite: SuiteTables, table: str
    ) -> None:
        assert counted(db_engine, suite, table) == 0

    @pytest.mark.usefixtures("failed_halfway")
    def test_what_was_there_before_is_untouched(
        self, api_client: TestClient, db_engine: Engine, suite: SuiteTables
    ) -> None:
        # The commit predates the submission, so the rollback must not take it -- and its ordinal
        # is the one it had.
        assert counted(db_engine, suite, "commit") == 1
        assert api_client.get(f"{COMMITS}/abc123").json()["ordinal"] == 1


class TestConcurrentSubmission:
    """D13, over the endpoint: concurrent submissions naming the same new entities all succeed.

    `test_concurrency.py` covers the get-or-create underneath this, deterministically. What this
    adds is that the endpoint composes those calls into one transaction that neither deadlocks nor
    duplicates anything -- the machine, the commit and the test set are all created by whichever
    request gets there first, and the rest find them.
    """

    @pytest.fixture
    def submitted_at_once(
        self, api_client: TestClient, submitter: dict[str, str], suite: SuiteTables
    ) -> Iterator[list[Any]]:
        tests = [{"name": f"suite/test-{index}"} for index in range(8)]

        def send(index: int) -> Any:
            return api_client.post(
                RUNS,
                json=payload(machine={"name": "shared"}, commit={"value": "shared"}, tests=tests),
                headers=submitter,
            )

        with ThreadPoolExecutor(max_workers=4) as pool:
            yield [future.result(timeout=60) for future in [pool.submit(send, i) for i in range(4)]]

    def test_every_submission_succeeds(self, submitted_at_once: list[Any]) -> None:
        assert [response.status_code for response in submitted_at_once] == [201] * 4

    def test_each_run_gets_a_uuid_of_its_own(self, submitted_at_once: list[Any]) -> None:
        assert len({response.json()["uuid"] for response in submitted_at_once}) == 4

    @pytest.mark.usefixtures("submitted_at_once")
    @pytest.mark.parametrize(("table", "expected"), [("machine", 1), ("commit", 1), ("test", 8)])
    def test_the_shared_entities_are_created_exactly_once(
        self, db_engine: Engine, suite: SuiteTables, table: str, expected: int
    ) -> None:
        assert counted(db_engine, suite, table) == expected

    @pytest.mark.usefixtures("submitted_at_once")
    def test_every_run_kept_its_samples(self, db_engine: Engine, suite: SuiteTables) -> None:
        assert counted(db_engine, suite, "run") == 4
        assert counted(db_engine, suite, "sample") == 32


class TestDetail:
    def test_returns_the_run(self, api_client: TestClient, submitted: Callable[..., Any]) -> None:
        body = submitted(run_parameters={"build_config": "Release"})

        response = api_client.get(f"{RUNS}/{body['uuid']}")

        assert response.status_code == 200
        assert response.json() == body

    def test_accepts_the_uuid_in_either_case(
        self, api_client: TestClient, submitted: Callable[..., Any]
    ) -> None:
        # D6 stores the lowercased form, and the path segment is matched against it.
        body = submitted(uuid="550e8400-e29b-41d4-a716-446655440000")

        assert api_client.get(f"{RUNS}/550E8400-E29B-41D4-A716-446655440000").json() == body

    def test_is_404_for_a_uuid_no_run_has(self, api_client: TestClient, suite: SuiteTables) -> None:
        response = api_client.get(f"{RUNS}/{uuid4()}")

        assert response.status_code == 404
        assert code_of(response) == "not_found"

    @pytest.mark.parametrize("segment", ["nonsense", "1234", "x" * 500])
    def test_is_404_for_a_segment_that_is_not_a_uuid_at_all(
        self, api_client: TestClient, suite: SuiteTables, segment: str
    ) -> None:
        # endpoints.md: it names no run, which is a 404 rather than a malformed request.
        response = api_client.get(f"{RUNS}/{segment}")

        assert response.status_code == 404
        assert code_of(response) == "not_found"

    def test_is_404_for_a_suite_that_is_not_there(self, api_client: TestClient) -> None:
        assert api_client.get(f"{SUITES_PATH}/nope/runs/{uuid4()}").status_code == 404

    def test_is_not_shadowed_by_the_spa_catch_all(
        self, api_client: TestClient, submitted: Callable[..., Any]
    ) -> None:
        body = submitted()

        assert "<title>LNT</title>" not in api_client.get(f"{RUNS}/{body['uuid']}").text


class TestDelete:
    def test_removes_the_run(
        self, api_client: TestClient, manage: dict[str, str], submitted: Callable[..., Any]
    ) -> None:
        body = submitted()

        response = api_client.delete(f"{RUNS}/{body['uuid']}", headers=manage)

        assert response.status_code == 204
        assert response.content == b""
        assert api_client.get(f"{RUNS}/{body['uuid']}").status_code == 404

    def test_accepts_the_uuid_in_either_case(
        self, api_client: TestClient, manage: dict[str, str], submitted: Callable[..., Any]
    ) -> None:
        submitted(uuid="550e8400-e29b-41d4-a716-446655440000")

        deleted = api_client.delete(f"{RUNS}/550E8400-E29B-41D4-A716-446655440000", headers=manage)

        assert deleted.status_code == 204

    def test_cascades_to_its_samples_and_profiles(
        self,
        api_client: TestClient,
        manage: dict[str, str],
        db_engine: Engine,
        suite: SuiteTables,
        submitted: Callable[..., Any],
    ) -> None:
        doomed = submitted(
            tests=[{"name": "suite/one", "execution_time": 1.0, "profile": encoded_profile(1)}]
        )
        submitted(
            tests=[{"name": "suite/one", "execution_time": 2.0, "profile": encoded_profile(2)}]
        )

        api_client.delete(f"{RUNS}/{doomed['uuid']}", headers=manage)

        # The bystanding run keeps both of its rows, so this is a cascade rather than a table-wide
        # delete.
        assert counted(db_engine, suite, "sample") == 1
        assert counted(db_engine, suite, "profile") == 1

    def test_leaves_the_machine_commit_and_tests_behind(
        self,
        api_client: TestClient,
        manage: dict[str, str],
        db_engine: Engine,
        suite: SuiteTables,
        submitted: Callable[..., Any],
    ) -> None:
        # D5: nothing deletes a test, and a run is not the only thing a machine or a commit is for.
        body = submitted()

        api_client.delete(f"{RUNS}/{body['uuid']}", headers=manage)

        assert counted(db_engine, suite, "machine") == 1
        assert counted(db_engine, suite, "commit") == 1
        assert counted(db_engine, suite, "test") == 1

    def test_needs_no_confirmation(
        self, api_client: TestClient, manage: dict[str, str], submitted: Callable[..., Any]
    ) -> None:
        body = submitted()

        assert api_client.delete(f"{RUNS}/{body['uuid']}", headers=manage).status_code == 204

    def test_is_404_for_a_uuid_no_run_has(
        self, api_client: TestClient, manage: dict[str, str], suite: SuiteTables
    ) -> None:
        response = api_client.delete(f"{RUNS}/{uuid4()}", headers=manage)

        assert response.status_code == 404
        assert code_of(response) == "not_found"

    def test_is_404_for_a_suite_that_is_not_there(
        self, api_client: TestClient, manage: dict[str, str]
    ) -> None:
        response = api_client.delete(f"{SUITES_PATH}/nope/runs/{uuid4()}", headers=manage)

        assert response.status_code == 404


class TestSchemaChangedUnderneath:
    """D2's stale reader: answered with a conflict, never silently wrong and never a 500."""

    @pytest.fixture
    def after_the_column_vanished(
        self,
        api_client: TestClient,
        submitter: dict[str, str],
        db_engine: Engine,
        suite: SuiteTables,
    ) -> Any:
        """A submission that reaches its sample insert and finds the metric column gone.

        Dropping the column without going through `PATCH /schema` leaves D2's version counter
        alone, so the freshness check passes and the submission gets all the way to the statement
        that names the column. That makes this the one failure that lands *after* the run row is
        already in -- and so the interesting one for D13's atomicity.
        """
        with db_engine.begin() as connection:
            connection.execute(text("ALTER TABLE nts.sample DROP COLUMN execution_time"))

        return api_client.post(RUNS, json=payload(), headers=submitter)

    def test_a_submission_is_a_retryable_conflict(self, after_the_column_vanished: Any) -> None:
        assert after_the_column_vanished.status_code == 409
        assert code_of(after_the_column_vanished) == "conflict"

    @pytest.mark.usefixtures("after_the_column_vanished")
    @pytest.mark.parametrize("table", ["run", "machine", "commit", "sample"])
    def test_nothing_the_submission_wrote_survives(
        self, db_engine: Engine, suite: SuiteTables, table: str
    ) -> None:
        # D13's atomicity where it is hardest: the run row, and the machine and commit created to
        # point it at, were all written before the failure, and all of them go with it.
        assert counted(db_engine, suite, table) == 0

    def test_a_change_between_validation_and_the_write_is_a_retryable_conflict(
        self,
        api_client: TestClient,
        submitter: dict[str, str],
        db_engine: Engine,
        suite: SuiteTables,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """The window submission deliberately opens by validating outside the write transaction.

        `submit_run` resolves the suite once to validate against and again inside the transaction
        that writes, because D2 wants the freshness check to be that transaction's first statement.
        Between the two, another worker may change the schema -- and D2's answer is that the writer
        is *answered* rather than silently wrong. Staged by hooking validation, which is the only
        deterministic way to land a change in a window that is otherwise microseconds wide.
        """

        def change_the_schema_first(*arguments: Any) -> Any:
            validated = validate_submission(*arguments)
            with db_engine.begin() as connection:
                connection.execute(text("ALTER TABLE nts.sample DROP COLUMN execution_time"))
            return validated

        monkeypatch.setattr("lnt_v5.routes.runs.validate_submission", change_the_schema_first)

        response = api_client.post(RUNS, json=payload(), headers=submitter)

        assert response.status_code == 409, response.text
        assert code_of(response) == "conflict"


class TestAuthorization:
    def test_reading_needs_no_credential(
        self, api_client: TestClient, submitted: Callable[..., Any]
    ) -> None:
        body = submitted()

        assert api_client.get(f"{RUNS}/{body['uuid']}").status_code == 200

    @pytest.mark.parametrize(("method", "path", "scope"), WRITES)
    def test_a_write_needs_a_credential(
        self,
        api_client: TestClient,
        submitted: Callable[..., Any],
        method: str,
        path: str,
        scope: Scope,
    ) -> None:
        body = submitted()

        response = api_client.request(
            method.upper(), path.format(uuid=body["uuid"]), json=payload()
        )

        assert response.status_code == 401
        assert code_of(response) == "unauthorized"

    @pytest.mark.parametrize(("method", "path", "scope"), WRITES)
    def test_a_write_needs_more_than_read(
        self,
        api_client: TestClient,
        submitted: Callable[..., Any],
        make_key: Callable[..., str],
        bearer: Callable[[str], dict[str, str]],
        method: str,
        path: str,
        scope: Scope,
    ) -> None:
        body = submitted()

        response = api_client.request(
            method.upper(),
            path.format(uuid=body["uuid"]),
            json=payload(),
            headers=bearer(make_key(Scope.READ)),
        )

        assert response.status_code == 403
        assert code_of(response) == "forbidden"

    @pytest.mark.parametrize(("method", "path", "scope"), WRITES)
    def test_each_write_accepts_exactly_the_scope_endpoints_md_gives_it(
        self,
        api_client: TestClient,
        submitted: Callable[..., Any],
        make_key: Callable[..., str],
        bearer: Callable[[str], dict[str, str]],
        method: str,
        path: str,
        scope: Scope,
    ) -> None:
        body = submitted()

        response = api_client.request(
            method.upper(),
            path.format(uuid=body["uuid"]),
            json=payload(uuid=str(uuid4())),
            headers=bearer(make_key(scope)),
        )

        assert response.status_code < 300, response.text

    def test_deleting_a_run_needs_more_than_submit(
        self,
        api_client: TestClient,
        submitted: Callable[..., Any],
        submitter: dict[str, str],
    ) -> None:
        # endpoints.md gives POST `submit` and DELETE `manage`, so the key that may create a run
        # may not remove one.
        body = submitted()

        response = api_client.delete(f"{RUNS}/{body['uuid']}", headers=submitter)

        assert response.status_code == 403
        assert code_of(response) == "forbidden"

"""Projects (E13, D7, D2): listing them with their suites, creating them, changing their display
names and deleting them, and how deleting one and creating a suite in it never both succeed.
Renaming them is in `test_renames.py`."""

from __future__ import annotations

from collections.abc import Callable, Iterator
from concurrent.futures import Future, ThreadPoolExecutor
from typing import Any

import pytest
from fastapi import Response
from fastapi.testclient import TestClient
from sqlalchemy import Engine, select, text

from conftest import code_of, ensure_project, suite_path
from introspection import schema_version_of
from lnt_v5.errors import ApiError, ErrorCode
from lnt_v5.routes.projects import delete_project
from lnt_v5.routes.suites import PROJECTS_PATH, SUITES_PATH, create_suite
from lnt_v5.suites.schema import SuiteSchema
from lnt_v5.tables import DISPLAY_NAME_MAX_LENGTH, SUITE_NAME_MAX_LENGTH, project
from test_concurrency import BLOCK_TIMEOUT, until_blocked

NTS: dict[str, Any] = {"name": "nts", "metrics": [{"name": "execution_time", "type": "real"}]}


@pytest.fixture
def create(api_client: TestClient, manage: dict[str, str]) -> Callable[..., Any]:
    """Create a project through the API."""

    def post(name: str = "llvm", **body: Any) -> Any:
        return api_client.post(PROJECTS_PATH, json={"name": name, **body}, headers=manage)

    return post


@pytest.fixture
def background() -> Iterator[Callable[..., Future[Any]]]:
    with ThreadPoolExecutor(max_workers=2) as pool:
        yield pool.submit


class TestCreate:
    def test_returns_the_project_and_where_to_find_it(
        self, api_client: TestClient, create: Callable[..., Any], db_engine: Engine
    ) -> None:
        before = schema_version_of(db_engine)

        response = create("libcxx", display_name="libc++")

        assert response.status_code == 201
        assert response.json() == {"name": "libcxx", "display_name": "libc++", "suites": []}
        assert response.headers["Location"] == f"{PROJECTS_PATH}/libcxx"
        assert api_client.get(response.headers["Location"]).json() == response.json()
        # Every worker learns of it (D2).
        assert schema_version_of(db_engine) == before + 1

    def test_has_no_display_name_unless_given_one(self, create: Callable[..., Any]) -> None:
        assert create().json()["display_name"] is None
        assert create("other", display_name=None).json()["display_name"] is None

    def test_refuses_a_name_taken_by_another_project(self, create: Callable[..., Any]) -> None:
        create()

        response = create()

        assert response.status_code == 409
        assert code_of(response) == "duplicate"

    @pytest.mark.parametrize(
        ("body", "why"),
        [
            ({}, "no name"),
            ({"name": "LLVM"}, "a name D7 does not accept"),
            ({"name": "a" * (SUITE_NAME_MAX_LENGTH + 1)}, "a name too long"),
            ({"name": "llvm", "display_name": ""}, "an empty display name"),
            ({"name": "llvm", "display_name": "x" * (DISPLAY_NAME_MAX_LENGTH + 1)}, "too long"),
            ({"name": "llvm", "display_name": "a\x00b"}, "a display name with a NUL"),
            ({"name": "llvm", "suites": []}, "a key the body does not define"),
        ],
    )
    def test_refuses_a_bad_body(
        self, api_client: TestClient, manage: dict[str, str], body: dict[str, Any], why: str
    ) -> None:
        response = api_client.post(PROJECTS_PATH, json=body, headers=manage)

        assert code_of(response) == "invalid_request", why

    def test_accepts_names_at_their_limits(self, create: Callable[..., Any]) -> None:
        name = "a" * SUITE_NAME_MAX_LENGTH
        display_name = "x" * DISPLAY_NAME_MAX_LENGTH

        assert create(name, display_name=display_name).status_code == 201

    @pytest.mark.parametrize("name", ["admin", "suites", "projects"])
    def test_reserves_no_name(
        self, api_client: TestClient, create: Callable[..., Any], manage: dict[str, str], name: str
    ) -> None:
        # I1: what belongs to a project sits below its name, so no route collides with one.
        assert create(name).status_code == 201
        created = api_client.post(SUITES_PATH.format(project=name), json=NTS, headers=manage)
        assert created.status_code == 201
        assert api_client.get(f"{PROJECTS_PATH}/{name}").json()["suites"][0]["name"] == "nts"


class TestRead:
    def test_lists_every_project_by_name_with_its_suites_by_name(
        self, api_client: TestClient, create: Callable[..., Any], manage: dict[str, str]
    ) -> None:
        for name in ("swift", "llvm", "libcxx"):
            create(name)
        for suite in ("zeta", "alpha"):
            api_client.post(
                SUITES_PATH.format(project="llvm"), json={**NTS, "name": suite}, headers=manage
            )

        items = api_client.get(PROJECTS_PATH).json()["items"]

        assert [item["name"] for item in items] == ["libcxx", "llvm", "swift"]
        llvm = items[1]
        assert [suite["name"] for suite in llvm["suites"]] == ["alpha", "zeta"]
        # Whole schemas, as E10 returns them.
        assert llvm["suites"][0] == api_client.get(suite_path("alpha", "llvm")).json()
        # Projects without suites are listed too.
        assert items[0]["suites"] == []

    def test_lists_nothing_on_an_empty_instance(self, api_client: TestClient) -> None:
        assert api_client.get(PROJECTS_PATH).json() == {"items": []}

    def test_is_404_for_a_project_that_does_not_exist(self, api_client: TestClient) -> None:
        for path in (f"{PROJECTS_PATH}/nope", SUITES_PATH.format(project="nope")):
            response = api_client.get(path)
            assert response.status_code == 404, path
            assert code_of(response) == "not_found"

    def test_needs_no_credential(self, api_client: TestClient, create: Callable[..., Any]) -> None:
        create()

        assert api_client.get(PROJECTS_PATH).status_code == 200
        assert api_client.get(f"{PROJECTS_PATH}/llvm").status_code == 200


class TestUpdate:
    def test_changes_and_clears_the_display_name(
        self,
        api_client: TestClient,
        create: Callable[..., Any],
        manage: dict[str, str],
        db_engine: Engine,
    ) -> None:
        create()
        before = schema_version_of(db_engine)

        changed = api_client.patch(
            f"{PROJECTS_PATH}/llvm", json={"display_name": "LLVM"}, headers=manage
        )
        assert changed.status_code == 200
        assert changed.json() == {"name": "llvm", "display_name": "LLVM", "suites": []}
        assert schema_version_of(db_engine) == before + 1
        assert api_client.get(f"{PROJECTS_PATH}/llvm").json()["display_name"] == "LLVM"

        cleared = api_client.patch(
            f"{PROJECTS_PATH}/llvm", json={"display_name": None}, headers=manage
        )
        assert cleared.json()["display_name"] is None

    @pytest.mark.parametrize("body", [{}, {"display_name": "LLVM"}])
    def test_changes_nothing_when_nothing_changes(
        self,
        api_client: TestClient,
        create: Callable[..., Any],
        manage: dict[str, str],
        db_engine: Engine,
        body: dict[str, Any],
    ) -> None:
        create(display_name="LLVM")
        before = schema_version_of(db_engine)

        response = api_client.patch(f"{PROJECTS_PATH}/llvm", json=body, headers=manage)

        assert response.status_code == 200
        assert response.json()["display_name"] == "LLVM"
        assert schema_version_of(db_engine) == before

    def test_accepts_the_current_name(
        self,
        api_client: TestClient,
        create: Callable[..., Any],
        manage: dict[str, str],
        db_engine: Engine,
    ) -> None:
        create()
        before = schema_version_of(db_engine)

        response = api_client.patch(f"{PROJECTS_PATH}/llvm", json={"name": "llvm"}, headers=manage)

        assert response.status_code == 200
        assert response.json()["name"] == "llvm"
        assert schema_version_of(db_engine) == before

    @pytest.mark.parametrize("display_name", ["", "x" * (DISPLAY_NAME_MAX_LENGTH + 1)])
    def test_refuses_a_bad_display_name(
        self,
        api_client: TestClient,
        create: Callable[..., Any],
        manage: dict[str, str],
        display_name: str,
    ) -> None:
        create()

        response = api_client.patch(
            f"{PROJECTS_PATH}/llvm", json={"display_name": display_name}, headers=manage
        )

        assert code_of(response) == "invalid_request"

    def test_is_404_for_a_project_that_does_not_exist(
        self, api_client: TestClient, manage: dict[str, str]
    ) -> None:
        response = api_client.patch(f"{PROJECTS_PATH}/nope", json={}, headers=manage)

        assert code_of(response) == "not_found"

    def test_is_retryable_while_the_project_is_locked(
        self,
        api_client: TestClient,
        create: Callable[..., Any],
        manage: dict[str, str],
        db_engine: Engine,
    ) -> None:
        # D2: a display-name change waits only a bounded time for its locks.
        create()
        with db_engine.connect() as holder, holder.begin():
            holder.execute(select(project.c.id).with_for_update())

            response = api_client.patch(
                f"{PROJECTS_PATH}/llvm", json={"display_name": "LLVM"}, headers=manage
            )

        assert response.status_code == 409
        assert code_of(response) == "retry"
        assert "Project 'llvm' is busy" in response.json()["error"]["message"]

    def test_does_not_wait_for_a_suite_being_created_in_the_project(
        self,
        create: Callable[..., Any],
        api_client: TestClient,
        manage: dict[str, str],
        db_engine: Engine,
    ) -> None:
        create()
        with db_engine.connect() as creating, creating.begin():
            # What creating a suite holds on its project until it commits (see `add_suite`).
            creating.execute(select(project.c.id).with_for_update(read=True, key_share=True))

            response = api_client.patch(
                f"{PROJECTS_PATH}/llvm", json={"display_name": "LLVM"}, headers=manage
            )

        assert response.status_code == 200


class TestDelete:
    def test_deletes_a_project_without_suites(
        self,
        api_client: TestClient,
        create: Callable[..., Any],
        manage: dict[str, str],
        db_engine: Engine,
    ) -> None:
        create()
        before = schema_version_of(db_engine)

        response = api_client.delete(f"{PROJECTS_PATH}/llvm", headers=manage)

        assert response.status_code == 204
        assert api_client.get(f"{PROJECTS_PATH}/llvm").status_code == 404
        assert schema_version_of(db_engine) == before + 1
        # Its name is free again.
        assert create().status_code == 201

    def test_refuses_a_project_that_has_suites(
        self, api_client: TestClient, create: Callable[..., Any], manage: dict[str, str]
    ) -> None:
        create()
        api_client.post(SUITES_PATH.format(project="llvm"), json=NTS, headers=manage)

        response = api_client.delete(f"{PROJECTS_PATH}/llvm", headers=manage)

        assert response.status_code == 409
        assert code_of(response) == "conflict"
        assert api_client.get(suite_path("nts", "llvm")).status_code == 200

    def test_is_404_for_a_project_that_does_not_exist(
        self, api_client: TestClient, manage: dict[str, str]
    ) -> None:
        assert code_of(api_client.delete(f"{PROJECTS_PATH}/nope", headers=manage)) == "not_found"

    def test_is_retryable_while_the_project_is_locked(
        self,
        api_client: TestClient,
        create: Callable[..., Any],
        manage: dict[str, str],
        db_engine: Engine,
    ) -> None:
        create()
        with db_engine.connect() as holder, holder.begin():
            # What creating a suite in it holds until it commits.
            holder.execute(select(project.c.id).with_for_update(read=True, key_share=True))

            response = api_client.delete(f"{PROJECTS_PATH}/llvm", headers=manage)

        assert response.status_code == 409
        assert code_of(response) == "retry"


class TestDeletionRacingSuiteCreation:
    """D2: deleting a project and creating a suite in it never both succeed. Either the suite is
    stored and the deletion is a 409 `conflict`, or the project is deleted and the creation is a
    404."""

    def test_a_suite_created_during_the_deletion_is_a_404(
        self, db_engine: Engine, background: Callable[..., Future[Any]]
    ) -> None:
        with db_engine.begin() as connection:
            ensure_project(connection, "llvm")
        with db_engine.connect() as deleting, deleting.begin():
            deleting.execute(text("DELETE FROM project WHERE name = 'llvm'"))
            creating = background(
                create_suite, "llvm", SuiteSchema.model_validate(NTS), db_engine, Response()
            )
            until_blocked(db_engine)

        with pytest.raises(ApiError) as raised:
            creating.result(timeout=BLOCK_TIMEOUT)
        assert raised.value.code is ErrorCode.NOT_FOUND
        assert raised.value.message == "Project 'llvm' not found"

    def test_a_deletion_during_the_creation_is_a_conflict(
        self, db_engine: Engine, background: Callable[..., Future[Any]]
    ) -> None:
        with db_engine.begin() as connection:
            ensure_project(connection, "llvm")
        with db_engine.connect() as creating, creating.begin():
            # What `add_suite` holds while it creates the suite's row and tables.
            creating.execute(select(project.c.id).with_for_update(read=True, key_share=True))
            creating.execute(
                text(
                    "INSERT INTO schema (project_id, name, namespace, schema_json, "
                    "migration_version) SELECT id, 'nts', 'nts', '{}', 0 FROM project"
                )
            )
            deleting = background(delete_project, "llvm", db_engine)
            until_blocked(db_engine)

        with pytest.raises(ApiError) as raised:
            deleting.result(timeout=BLOCK_TIMEOUT)
        assert raised.value.code is ErrorCode.CONFLICT
        with db_engine.connect() as connection:
            assert connection.execute(select(project.c.name)).scalars().all() == ["llvm"]


class TestSuiteCreationInABusyProject:
    def test_is_retryable_while_the_project_is_locked(
        self,
        api_client: TestClient,
        create: Callable[..., Any],
        manage: dict[str, str],
        db_engine: Engine,
    ) -> None:
        # E10, D2: creating a suite waits only a bounded time for its project's row, which a
        # change to the project holds, and nothing is created.
        create()
        with db_engine.connect() as holder, holder.begin():
            holder.execute(select(project.c.id).with_for_update())

            response = api_client.post(SUITES_PATH.format(project="llvm"), json=NTS, headers=manage)

        assert response.status_code == 409
        assert code_of(response) == "retry"
        assert api_client.get(SUITES_PATH.format(project="llvm")).json()["items"] == []

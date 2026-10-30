"""Renaming a suite, moving it to another project, and renaming a project (D7, E10, E13).

Only names change: the suite keeps its namespace and its data, the namespace is relabelled with the
suite's new full name, and API keys follow what they list (I5). The races are D2's: every lock is
taken projects first, and a write through a name that a concurrent rename has just retired finds
nothing.
"""

from __future__ import annotations

from collections.abc import Callable, Iterator
from concurrent.futures import Future, ThreadPoolExecutor
from typing import Any

import pytest
from fastapi import Response
from fastapi.testclient import TestClient
from sqlalchemy import Connection, Engine, select, text

from conftest import code_of, ensure_project, entry, run_payload, suite_path
from introspection import label_of, namespace_of, schema_version_of
from lnt_v5 import keys
from lnt_v5.errors import ApiError, ErrorCode
from lnt_v5.routes.projects import ProjectUpdate, delete_project, patch_project
from lnt_v5.routes.suites import (
    PROJECTS_PATH,
    SuiteUpdate,
    create_suite,
    delete_suite,
    patch_suite,
)
from lnt_v5.scopes import Scope
from lnt_v5.suites.registry import SuiteRegistry
from lnt_v5.suites.schema import SuiteSchema
from lnt_v5.suites.store import add_suite
from lnt_v5.tables import project, schema
from test_concurrency import BLOCK_TIMEOUT, until_blocked

NTS: dict[str, Any] = {"name": "nts", "metrics": [{"name": "execution_time", "type": "real"}]}


@pytest.fixture(autouse=True)
def projects(db_engine: Engine) -> None:
    """`libcxx` and `llvm`, with `libcxx/nts`."""
    with db_engine.begin() as connection:
        ensure_project(connection, "libcxx")
        ensure_project(connection, "llvm")
        add_suite(connection, "libcxx", SuiteSchema.model_validate(NTS))


@pytest.fixture
def background() -> Iterator[Callable[..., Future[Any]]]:
    with ThreadPoolExecutor(max_workers=2) as pool:
        yield pool.submit


def suite_names(engine: Engine) -> list[tuple[str, str]]:
    """Every suite, as (project, suite), from the database."""
    with engine.connect() as connection:
        rows = connection.execute(
            select(project.c.name, schema.c.name).select_from(schema.join(project))
        ).all()
    return sorted((row[0], row[1]) for row in rows)


def move(engine: Engine, body: dict[str, Any], path: tuple[str, str] = ("libcxx", "nts")) -> Any:
    """Call the rename-or-move endpoint directly, as a thread racing another can."""
    return patch_suite(*path, SuiteUpdate.model_validate(body), engine)


def rename_project(engine: Engine, body: dict[str, Any], name: str = "libcxx") -> Any:
    return patch_project(name, ProjectUpdate.model_validate(body), engine, SuiteRegistry())


class TestSuiteRenameOrMove:
    SUITE = suite_path("nts", "libcxx")

    @pytest.mark.parametrize(
        ("body", "where"),
        [
            ({"name": "bench"}, ("libcxx", "bench")),
            ({"project": "llvm"}, ("llvm", "nts")),
            ({"project": "llvm", "name": "bench"}, ("llvm", "bench")),
        ],
    )
    def test_changes_only_names(
        self,
        api_client: TestClient,
        manage: dict[str, str],
        submitter: dict[str, str],
        db_engine: Engine,
        body: dict[str, Any],
        where: tuple[str, str],
    ) -> None:
        submitted = api_client.post(
            f"{self.SUITE}/runs",
            json=run_payload(tests=[entry("t", {"execution_time": 1.0})]),
            headers=submitter,
        )
        assert submitted.status_code == 201, submitted.text
        namespace = namespace_of(db_engine, "nts", "libcxx")
        before = schema_version_of(db_engine)

        response = api_client.patch(self.SUITE, json=body, headers=manage)

        assert response.status_code == 200, response.text
        assert response.json()["name"] == where[1]
        moved = suite_path(where[1], where[0])
        assert api_client.get(moved).json() == response.json()
        assert code_of(api_client.get(self.SUITE)) == "not_found"
        assert suite_names(db_engine) == [where]
        # D5, D7: the same namespace and data, relabelled with the new full name.
        assert namespace_of(db_engine, where[1], where[0]) == namespace
        assert label_of(db_engine, namespace) == f"LNT test suite {where[0]}/{where[1]}"
        runs = api_client.get(f"{moved}/runs").json()["items"]
        assert [run["uuid"] for run in runs] == [submitted.json()["uuid"]]
        assert schema_version_of(db_engine) == before + 1
        listed = api_client.get(f"{PROJECTS_PATH}/{where[0]}/suites").json()["items"]
        assert [suite["name"] for suite in listed] == [where[1]]

    @pytest.mark.parametrize(
        "body",
        [{}, {"name": "nts"}, {"project": "libcxx"}, {"name": "nts", "project": "libcxx"}],
    )
    def test_a_body_that_changes_nothing_changes_nothing(
        self, api_client: TestClient, manage: dict[str, str], db_engine: Engine, body: Any
    ) -> None:
        before = schema_version_of(db_engine)

        response = api_client.patch(self.SUITE, json=body, headers=manage)

        assert response.status_code == 200, response.text
        assert response.json()["name"] == "nts"
        assert schema_version_of(db_engine) == before

    @pytest.mark.parametrize(
        "body",
        [
            {"name": None},
            {"project": None},
            {"name": "Not A Name"},
            {"name": ""},
            {"name": "x" * 65},
            {"project": 5},
            {"project": "x\u0000"},
            {"display_name": "NTS"},
        ],
    )
    def test_refuses_a_bad_body(
        self, api_client: TestClient, manage: dict[str, str], body: dict[str, Any]
    ) -> None:
        response = api_client.patch(self.SUITE, json=body, headers=manage)

        assert code_of(response) == "invalid_request"
        assert api_client.get(self.SUITE).status_code == 200

    @pytest.mark.parametrize(
        ("path", "body", "message"),
        [
            (suite_path("missing", "libcxx"), {}, "Test suite 'libcxx/missing' not found"),
            (suite_path("nts", "missing"), {}, "Test suite 'missing/nts' not found"),
            (suite_path("nts", "libcxx"), {"project": "missing"}, "Project 'missing' not found"),
            (suite_path("nts", "libcxx"), {"project": "Not A Name"}, "Project 'Not A Name'"),
        ],
    )
    def test_is_404_for_what_does_not_exist(
        self,
        api_client: TestClient,
        manage: dict[str, str],
        path: str,
        body: dict[str, Any],
        message: str,
    ) -> None:
        response = api_client.patch(path, json=body, headers=manage)

        assert code_of(response) == "not_found"
        assert message in response.json()["error"]["message"]

    @pytest.mark.parametrize(
        ("body", "taken"), [({"name": "other"}, "libcxx/other"), ({"project": "llvm"}, "llvm/nts")]
    )
    def test_refuses_a_name_the_project_it_ends_up_in_has(
        self,
        api_client: TestClient,
        manage: dict[str, str],
        db_engine: Engine,
        body: dict[str, Any],
        taken: str,
    ) -> None:
        with db_engine.begin() as connection:
            add_suite(connection, "libcxx", SuiteSchema.model_validate({**NTS, "name": "other"}))
            add_suite(connection, "llvm", SuiteSchema.model_validate(NTS))

        response = api_client.patch(self.SUITE, json=body, headers=manage)

        assert code_of(response) == "duplicate"
        assert f"'{taken}' already exists" in response.json()["error"]["message"]
        assert api_client.get(self.SUITE).status_code == 200

    def test_the_old_name_can_be_taken_by_a_suite_of_its_own(
        self,
        api_client: TestClient,
        manage: dict[str, str],
        submitter: dict[str, str],
        db_engine: Engine,
    ) -> None:
        api_client.post(f"{self.SUITE}/runs", json=run_payload(), headers=submitter)
        assert api_client.patch(self.SUITE, json={"name": "old"}, headers=manage).is_success

        created = api_client.post(f"{PROJECTS_PATH}/libcxx/suites", json=NTS, headers=manage)

        assert created.status_code == 201, created.text
        assert api_client.get(f"{self.SUITE}/runs").json()["items"] == []
        assert namespace_of(db_engine, "nts", "libcxx") != namespace_of(db_engine, "old", "libcxx")

    def test_is_retryable_while_the_suite_is_being_changed(
        self, api_client: TestClient, manage: dict[str, str], db_engine: Engine
    ) -> None:
        # D2: it waits only a bounded time for the suite's row, which a schema change holds.
        with db_engine.connect() as holder, holder.begin():
            holder.execute(select(schema.c.id).with_for_update())

            response = api_client.patch(self.SUITE, json={"name": "bench"}, headers=manage)

        assert code_of(response) == "retry"
        assert suite_names(db_engine) == [("libcxx", "nts")]

    def test_does_not_wait_for_a_reader_of_the_suite_s_data(
        self, api_client: TestClient, manage: dict[str, str], db_engine: Engine
    ) -> None:
        # Unlike a schema change, it changes no table of the suite (D7).
        namespace = namespace_of(db_engine, "nts", "libcxx")
        with db_engine.connect() as reader, reader.begin():
            reader.execute(text(f'LOCK TABLE "{namespace}".machine IN ACCESS SHARE MODE'))

            response = api_client.patch(self.SUITE, json={"project": "llvm"}, headers=manage)

        assert response.status_code == 200, response.text


class TestProjectRename:
    def test_renames_the_project_and_relabels_its_suites(
        self, api_client: TestClient, manage: dict[str, str], db_engine: Engine
    ) -> None:
        with db_engine.begin() as connection:
            add_suite(connection, "libcxx", SuiteSchema.model_validate({**NTS, "name": "other"}))
        namespaces = {name: namespace_of(db_engine, name, "libcxx") for name in ("nts", "other")}
        before = schema_version_of(db_engine)

        response = api_client.patch(
            f"{PROJECTS_PATH}/libcxx",
            json={"name": "libcpp", "display_name": "libc++"},
            headers=manage,
        )

        assert response.status_code == 200, response.text
        assert response.json()["name"] == "libcpp"
        assert response.json()["display_name"] == "libc++"
        assert [suite["name"] for suite in response.json()["suites"]] == ["nts", "other"]
        assert code_of(api_client.get(f"{PROJECTS_PATH}/libcxx")) == "not_found"
        assert code_of(api_client.get(suite_path("nts", "libcxx"))) == "not_found"
        assert api_client.get(suite_path("nts", "libcpp")).status_code == 200
        for name, namespace in namespaces.items():
            assert namespace_of(db_engine, name, "libcpp") == namespace
            assert label_of(db_engine, namespace) == f"LNT test suite libcpp/{name}"
        assert schema_version_of(db_engine) == before + 1

    @pytest.mark.parametrize("name", [None, "Not A Name", "", 1])
    def test_refuses_a_bad_name(
        self, api_client: TestClient, manage: dict[str, str], name: Any
    ) -> None:
        response = api_client.patch(f"{PROJECTS_PATH}/libcxx", json={"name": name}, headers=manage)

        assert code_of(response) == "invalid_request"

    def test_refuses_the_name_of_another_project(
        self, api_client: TestClient, manage: dict[str, str]
    ) -> None:
        response = api_client.patch(
            f"{PROJECTS_PATH}/libcxx", json={"name": "llvm"}, headers=manage
        )

        assert code_of(response) == "duplicate"
        assert "A project named 'llvm' already exists" in response.json()["error"]["message"]

    def test_the_old_name_can_be_taken_by_a_project_of_its_own(
        self, api_client: TestClient, manage: dict[str, str]
    ) -> None:
        assert api_client.patch(
            f"{PROJECTS_PATH}/libcxx", json={"name": "libcpp"}, headers=manage
        ).is_success

        created = api_client.post(PROJECTS_PATH, json={"name": "libcxx"}, headers=manage)

        assert created.status_code == 201
        assert created.json()["suites"] == []

    def test_is_retryable_while_a_suite_is_being_created_in_it(
        self, api_client: TestClient, manage: dict[str, str], db_engine: Engine
    ) -> None:
        # Unlike a display-name change, it waits for that (D2), for a bounded time.
        with db_engine.connect() as creating, creating.begin():
            creating.execute(
                select(project.c.id)
                .where(project.c.name == "libcxx")
                .with_for_update(read=True, key_share=True)
            )

            response = api_client.patch(
                f"{PROJECTS_PATH}/libcxx", json={"name": "libcpp"}, headers=manage
            )

        assert code_of(response) == "retry"
        assert "Project 'libcxx' is busy" in response.json()["error"]["message"]

    def test_does_not_wait_for_a_suite_of_it_being_changed(
        self, api_client: TestClient, manage: dict[str, str], db_engine: Engine
    ) -> None:
        # Its suites are locked without waiting, so that many busy suites cannot add up to more
        # than D2's bound.
        with db_engine.connect() as changing, changing.begin():
            changing.execute(select(schema.c.id).with_for_update())

            response = api_client.patch(
                f"{PROJECTS_PATH}/libcxx", json={"name": "libcpp"}, headers=manage
            )

        assert code_of(response) == "retry"
        assert "one of its test suites" in response.json()["error"]["message"]
        assert api_client.get(f"{PROJECTS_PATH}/libcxx").status_code == 200


class TestKeysFollow:
    """I5: entries are linked by identity, so renames leave them alone."""

    def listed(self, api_client: TestClient, headers: dict[str, str]) -> Any:
        return api_client.get("/api/auth", headers=headers).json()["key"]["restricted_to"]

    def test_a_suite_entry_follows_the_suite(
        self,
        api_client: TestClient,
        manage: dict[str, str],
        make_key: Callable[..., str],
        bearer: Callable[[str], dict[str, str]],
    ) -> None:
        headers = bearer(make_key(Scope.MANAGE, restricted_to=["libcxx/nts"]))

        api_client.patch(
            suite_path("nts", "libcxx"), json={"project": "llvm", "name": "bench"}, headers=manage
        )

        assert self.listed(api_client, headers) == [{"project": "llvm", "suite": "bench"}]
        machines = f"{suite_path('bench', 'llvm')}/machines"
        assert api_client.post(machines, json={"name": "m"}, headers=headers).status_code == 201

    def test_a_project_entry_covers_what_the_project_holds_now(
        self,
        api_client: TestClient,
        manage: dict[str, str],
        make_key: Callable[..., str],
        bearer: Callable[[str], dict[str, str]],
    ) -> None:
        libcxx = bearer(make_key(Scope.MANAGE, restricted_to=[keys.Entry("libcxx", None)]))
        llvm = bearer(make_key(Scope.MANAGE, restricted_to=[keys.Entry("llvm", None)]))

        api_client.patch(suite_path("nts", "libcxx"), json={"project": "llvm"}, headers=manage)

        machines = f"{suite_path('nts', 'llvm')}/machines"
        assert api_client.post(machines, json={"name": "m"}, headers=libcxx).status_code == 403
        assert api_client.post(machines, json={"name": "m"}, headers=llvm).status_code == 201

    def test_a_project_entry_follows_the_project(
        self,
        api_client: TestClient,
        manage: dict[str, str],
        make_key: Callable[..., str],
        bearer: Callable[[str], dict[str, str]],
    ) -> None:
        headers = bearer(make_key(Scope.MANAGE, restricted_to=[keys.Entry("libcxx", None)]))

        api_client.patch(f"{PROJECTS_PATH}/libcxx", json={"name": "libcpp"}, headers=manage)

        assert self.listed(api_client, headers) == [{"project": "libcpp"}]
        machines = f"{suite_path('nts', 'libcpp')}/machines"
        assert api_client.post(machines, json={"name": "m"}, headers=headers).status_code == 201


class TestRegistry:
    def test_another_worker_sees_the_suite_under_its_new_names(self, db_engine: Engine) -> None:
        # D2: each worker reloads, keeping the tables it built when only the project changes, and
        # building them again when the schema, which names the suite, does.
        registry = SuiteRegistry()
        with db_engine.connect() as connection:
            before = registry.resolve(connection, "libcxx", "nts")

        move(db_engine, {"project": "llvm"})
        with db_engine.connect() as connection:
            moved = registry.resolve(connection, "llvm", "nts")
            assert "nts" not in registry.resolve_project(connection, "libcxx").suites
        rename_project(db_engine, {"name": "libcpp"}, "llvm")
        with db_engine.connect() as connection:
            renamed = registry.resolve(connection, "libcpp", "nts")
        move(db_engine, {"name": "bench"}, ("libcpp", "nts"))
        with db_engine.connect() as connection:
            rebuilt = registry.resolve(connection, "libcpp", "bench")

        assert moved.tables is before.tables and moved.project == "llvm"
        assert renamed.tables is before.tables and renamed.project == "libcpp"
        assert rebuilt.name == "bench" and rebuilt.id == before.id
        assert rebuilt.tables is not before.tables
        assert rebuilt.tables.namespace == before.tables.namespace


def lock_project(connection: Connection, name: str, *, for_update: bool = False) -> None:
    """Take on `name`'s row what a write holding it takes: FOR KEY SHARE, or FOR UPDATE."""
    connection.execute(
        select(project.c.id)
        .where(project.c.name == name)
        .with_for_update(read=not for_update, key_share=not for_update)
    )


class TestRaces:
    """D2: whichever of two concurrent writes gets the rows first, the other waits for it, and then
    sees what it did."""

    def test_a_move_into_a_project_being_deleted_is_a_404(
        self, db_engine: Engine, background: Callable[..., Future[Any]]
    ) -> None:
        with db_engine.connect() as deleting, deleting.begin():
            deleting.execute(text("DELETE FROM project WHERE name = 'llvm'"))
            moving = background(move, db_engine, {"project": "llvm"})
            until_blocked(db_engine)

        with pytest.raises(ApiError) as raised:
            moving.result(timeout=BLOCK_TIMEOUT)
        assert raised.value.code is ErrorCode.NOT_FOUND
        assert raised.value.message == "Project 'llvm' not found"

    def test_deleting_a_project_a_suite_is_being_moved_into_is_a_conflict(
        self, db_engine: Engine, background: Callable[..., Future[Any]]
    ) -> None:
        with db_engine.connect() as moving, moving.begin():
            # What a move holds until it commits.
            lock_project(moving, "llvm")
            moving.execute(
                text("UPDATE schema SET project_id = (SELECT id FROM project WHERE name = 'llvm')")
            )
            deleting = background(delete_project, "llvm", db_engine)
            until_blocked(db_engine)

        with pytest.raises(ApiError) as raised:
            deleting.result(timeout=BLOCK_TIMEOUT)
        assert raised.value.code is ErrorCode.CONFLICT

    @pytest.mark.parametrize(
        "write",
        [
            lambda engine: move(engine, {"name": "bench"}),
            lambda engine: move(engine, {"project": "llvm"}),
            lambda engine: delete_suite("libcxx", "nts", engine, confirm=True),
        ],
        ids=["rename", "move", "delete"],
    )
    def test_a_suite_write_through_the_old_name_of_a_project_being_renamed_is_a_404(
        self,
        db_engine: Engine,
        background: Callable[..., Future[Any]],
        write: Callable[[Engine], Any],
    ) -> None:
        with db_engine.connect() as renaming, renaming.begin():
            # What a project rename holds until it commits.
            lock_project(renaming, "libcxx", for_update=True)
            renaming.execute(text("UPDATE project SET name = 'libcpp' WHERE name = 'libcxx'"))
            renaming.execute(select(schema.c.id).with_for_update(read=True, key_share=True))
            writing = background(write, db_engine)
            until_blocked(db_engine)

        with pytest.raises(ApiError) as raised:
            writing.result(timeout=BLOCK_TIMEOUT)
        assert raised.value.code is ErrorCode.NOT_FOUND
        assert suite_names(db_engine) == [("libcpp", "nts")]

    def test_a_project_renamed_during_a_suite_rename_labels_the_suite_s_new_name(
        self, db_engine: Engine, background: Callable[..., Future[Any]]
    ) -> None:
        namespace = namespace_of(db_engine, "nts", "libcxx")
        with db_engine.connect() as renaming, renaming.begin():
            # What a suite rename holds until it commits.
            lock_project(renaming, "libcxx")
            renaming.execute(select(schema.c.id).with_for_update())
            renaming.execute(text("UPDATE schema SET name = 'bench'"))
            project_renaming = background(rename_project, db_engine, {"name": "libcpp"})
            until_blocked(db_engine)

        project_renaming.result(timeout=BLOCK_TIMEOUT)
        assert suite_names(db_engine) == [("libcpp", "bench")]
        assert label_of(db_engine, namespace) == "LNT test suite libcpp/bench"

    def test_a_suite_created_during_a_project_rename_is_a_404(
        self, db_engine: Engine, background: Callable[..., Future[Any]]
    ) -> None:
        with db_engine.connect() as renaming, renaming.begin():
            lock_project(renaming, "libcxx", for_update=True)
            renaming.execute(text("UPDATE project SET name = 'libcpp' WHERE name = 'libcxx'"))
            body = SuiteSchema.model_validate({**NTS, "name": "other"})
            creating = background(create_suite, "libcxx", body, db_engine, Response())
            until_blocked(db_engine)

        with pytest.raises(ApiError) as raised:
            creating.result(timeout=BLOCK_TIMEOUT)
        assert raised.value.code is ErrorCode.NOT_FOUND

    def test_a_project_renamed_during_a_suite_creation_labels_the_new_suite(
        self, db_engine: Engine, background: Callable[..., Future[Any]]
    ) -> None:
        with db_engine.connect() as creating, creating.begin():
            add_suite(creating, "libcxx", SuiteSchema.model_validate({**NTS, "name": "other"}))
            project_renaming = background(rename_project, db_engine, {"name": "libcpp"})
            until_blocked(db_engine)

        project_renaming.result(timeout=BLOCK_TIMEOUT)
        assert label_of(db_engine, namespace_of(db_engine, "other", "libcpp")) == (
            "LNT test suite libcpp/other"
        )

    def test_renaming_a_project_while_one_of_its_suites_is_deleted_is_retryable(
        self, db_engine: Engine
    ) -> None:
        with db_engine.connect() as deleting, deleting.begin():
            # What deleting the suite holds until it commits.
            lock_project(deleting, "libcxx")
            deleting.execute(select(schema.c.id).with_for_update())

            with pytest.raises(ApiError) as raised:
                rename_project(db_engine, {"name": "libcpp"})

        assert raised.value.code is ErrorCode.RETRY

    def test_a_key_created_during_a_rename_of_its_suite_is_refused(
        self, db_engine: Engine, background: Callable[..., Future[Any]]
    ) -> None:
        def create_key() -> Any:
            with db_engine.begin() as connection:
                return keys.create_key(connection, "k", Scope.MANAGE, [keys.Entry("libcxx", "nts")])

        with db_engine.connect() as renaming, renaming.begin():
            lock_project(renaming, "libcxx")
            renaming.execute(select(schema.c.id).with_for_update())
            renaming.execute(text("UPDATE schema SET name = 'bench'"))
            creating = background(create_key)
            until_blocked(db_engine)

        with pytest.raises(keys.UnknownEntriesError):
            creating.result(timeout=BLOCK_TIMEOUT)

    def test_a_suite_renamed_during_the_creation_of_a_key_listing_it_stays_listed(
        self, db_engine: Engine, background: Callable[..., Future[Any]]
    ) -> None:
        with db_engine.connect() as creating, creating.begin():
            created = keys.create_key(creating, "k", Scope.MANAGE, [keys.Entry("libcxx", "nts")])
            renaming = background(move, db_engine, {"name": "bench"})
            until_blocked(db_engine)

        renaming.result(timeout=BLOCK_TIMEOUT)
        with db_engine.connect() as connection:
            resolved = keys.resolve_token(connection, created.token)
        assert resolved is not None
        assert resolved.restricted_to == (keys.Entry("libcxx", "bench"),)

"""The order of the projects, and of each project's suites (D7, E10, E13).

The API lists them in it, a reorder changes it, and creating, moving and deleting place what they
create, move and delete. In the races, a reorder holds what it reorders until it commits, except
against the creation of a project, which takes no lock: that one ends up after every project the
reorder read.
"""

from __future__ import annotations

from collections.abc import Callable, Iterator
from concurrent.futures import Future, ThreadPoolExecutor
from typing import Any

import pytest
from fastapi import Response
from fastapi.testclient import TestClient
from sqlalchemy import Engine, select, text

from conftest import code_of, ensure_project
from introspection import schema_version_of
from lnt_v5.errors import ApiError, ErrorCode
from lnt_v5.routes.projects import ProjectCreate, ProjectOrder, create_project, reorder_projects
from lnt_v5.routes.suites import (
    PROJECTS_PATH,
    SUITES_PATH,
    SuiteOrder,
    create_suite,
    reorder_suites,
)
from lnt_v5.suites.registry import SuiteRegistry
from lnt_v5.suites.schema import SuiteSchema
from lnt_v5.suites.store import (
    add_suite,
    locked_projects_in_order,
    locked_suites_in_order,
    reorder,
)
from lnt_v5.tables import project, schema
from test_concurrency import BLOCK_TIMEOUT, until_blocked
from test_renames import lock_project

NTS: dict[str, Any] = {"name": "nts", "metrics": [{"name": "execution_time", "type": "real"}]}

LIBCXX_SUITES = SUITES_PATH.format(project="libcxx")


@pytest.fixture(autouse=True)
def projects(db_engine: Engine) -> None:
    """`libcxx`, with `nts` then `bench`, `llvm` and `swift`, in that order."""
    with db_engine.begin() as connection:
        for name in ("libcxx", "llvm", "swift"):
            ensure_project(connection, name)
        for name in ("nts", "bench"):
            add_suite(connection, "libcxx", SuiteSchema.model_validate({**NTS, "name": name}))


@pytest.fixture
def background() -> Iterator[Callable[..., Future[Any]]]:
    with ThreadPoolExecutor(max_workers=2) as pool:
        yield pool.submit


def names(items: list[dict[str, Any]]) -> list[str]:
    return [item["name"] for item in items]


def listed(api_client: TestClient) -> dict[str, list[str]]:
    """Each project's suites by name, keyed by the project's name, as the API lists them."""
    return {
        item["name"]: names(item["suites"])
        for item in api_client.get(PROJECTS_PATH).json()["items"]
    }


def order_projects(engine: Engine, order: list[str]) -> Any:
    """Call the endpoint reordering the projects directly, as a thread racing another can."""
    return reorder_projects(ProjectOrder(order=order), engine, SuiteRegistry())


def order_suites(engine: Engine, project_name: str, order: list[str]) -> Any:
    return reorder_suites(project_name, SuiteOrder(order=order), engine, SuiteRegistry())


def error_message(response: Any) -> str:
    return str(response.json()["error"]["message"])


class TestReorderProjects:
    def test_puts_them_in_the_order_given(
        self, api_client: TestClient, manage: dict[str, str], db_engine: Engine
    ) -> None:
        before = schema_version_of(db_engine)

        response = api_client.patch(
            PROJECTS_PATH, json={"order": ["swift", "libcxx", "llvm"]}, headers=manage
        )

        assert response.status_code == 200, response.text
        # As listing them returns them, suites included.
        assert response.json() == api_client.get(PROJECTS_PATH).json()
        assert names(response.json()["items"]) == ["swift", "libcxx", "llvm"]
        assert list(listed(api_client).items()) == [
            ("swift", []),
            ("libcxx", ["nts", "bench"]),
            ("llvm", []),
        ]
        assert schema_version_of(db_engine) == before + 1

    def test_an_order_that_is_the_current_one_changes_nothing(
        self, api_client: TestClient, manage: dict[str, str], db_engine: Engine
    ) -> None:
        before = schema_version_of(db_engine)

        response = api_client.patch(
            PROJECTS_PATH, json={"order": ["libcxx", "llvm", "swift"]}, headers=manage
        )

        assert response.status_code == 200
        assert names(response.json()["items"]) == ["libcxx", "llvm", "swift"]
        assert schema_version_of(db_engine) == before

    @pytest.mark.parametrize(
        ("order", "message"),
        [
            (["swift", "libcxx"], "it leaves out 'llvm'"),
            (["swift", "libcxx", "llvm", "clang"], "it names 'clang', which is not among them"),
            (["swift", "libcxx", "llvm", "swift"], "it names 'swift' more than once"),
            (
                ["swift", "swift", "clang", "cuda"],
                "it leaves out 'libcxx', 'llvm'; it names 'clang', 'cuda', which are not among "
                "them; it names 'swift' more than once",
            ),
            # Not a valid name either, which is no reason to say anything else.
            (["swift", "libcxx", "llvm", "a/b"], "it names 'a/b', which is not among them"),
        ],
    )
    def test_refuses_an_order_that_does_not_name_each_project_once(
        self,
        api_client: TestClient,
        manage: dict[str, str],
        db_engine: Engine,
        order: list[str],
        message: str,
    ) -> None:
        before = schema_version_of(db_engine)

        response = api_client.patch(PROJECTS_PATH, json={"order": order}, headers=manage)

        assert response.status_code == 400
        assert code_of(response) == "invalid_request"
        assert error_message(response) == (
            f"The order must name each of the projects exactly once, but {message}."
        )
        assert list(listed(api_client)) == ["libcxx", "llvm", "swift"]
        assert schema_version_of(db_engine) == before

    @pytest.mark.parametrize(
        "body",
        [
            {},
            {"order": None},
            {"order": "libcxx"},
            {"order": ["libcxx", "llvm", 1]},
            {"order": ["libcxx", "llvm", "swift\u0000"]},
            {"order": ["libcxx", "llvm", "swift"], "name": "x"},
        ],
    )
    def test_refuses_a_bad_body(
        self, api_client: TestClient, manage: dict[str, str], body: dict[str, Any]
    ) -> None:
        response = api_client.patch(PROJECTS_PATH, json=body, headers=manage)

        assert response.status_code == 400
        assert code_of(response) == "invalid_request"

    def test_puts_a_new_project_last(self, api_client: TestClient, manage: dict[str, str]) -> None:
        api_client.patch(PROJECTS_PATH, json={"order": ["swift", "llvm", "libcxx"]}, headers=manage)

        api_client.post(PROJECTS_PATH, json={"name": "aaa"}, headers=manage)

        assert list(listed(api_client)) == ["swift", "llvm", "libcxx", "aaa"]

    @pytest.mark.parametrize("body", [{"name": "aaa"}, {"display_name": "AAA"}])
    def test_a_change_to_a_project_keeps_its_place(
        self, api_client: TestClient, manage: dict[str, str], body: dict[str, Any]
    ) -> None:
        response = api_client.patch(f"{PROJECTS_PATH}/swift", json=body, headers=manage)
        assert response.status_code == 200

        assert list(listed(api_client)) == ["libcxx", "llvm", body.get("name", "swift")]

    def test_deleting_a_project_leaves_the_others_in_order(
        self, api_client: TestClient, manage: dict[str, str]
    ) -> None:
        api_client.patch(PROJECTS_PATH, json={"order": ["swift", "llvm", "libcxx"]}, headers=manage)

        assert api_client.delete(f"{PROJECTS_PATH}/llvm", headers=manage).status_code == 204

        assert list(listed(api_client)) == ["swift", "libcxx"]

    def test_is_retryable_while_a_project_is_locked(
        self, api_client: TestClient, manage: dict[str, str], db_engine: Engine
    ) -> None:
        # D2: a reorder waits only a bounded time for its locks, here behind a rename.
        with db_engine.connect() as holder, holder.begin():
            lock_project(holder, "llvm", for_update=True)

            response = api_client.patch(
                PROJECTS_PATH, json={"order": ["swift", "llvm", "libcxx"]}, headers=manage
            )

        assert response.status_code == 409
        assert code_of(response) == "retry"
        assert error_message(response).startswith("The order of the projects is busy")

    def test_does_not_wait_for_a_suite_being_written(
        self, api_client: TestClient, manage: dict[str, str], db_engine: Engine
    ) -> None:
        with db_engine.connect() as writing, writing.begin():
            lock_project(writing, "libcxx")

            response = api_client.patch(
                PROJECTS_PATH, json={"order": ["swift", "llvm", "libcxx"]}, headers=manage
            )

        assert response.status_code == 200


class TestReorderSuites:
    def test_puts_them_in_the_order_given(
        self, api_client: TestClient, manage: dict[str, str], db_engine: Engine
    ) -> None:
        before = schema_version_of(db_engine)

        response = api_client.patch(LIBCXX_SUITES, json={"order": ["bench", "nts"]}, headers=manage)

        assert response.status_code == 200, response.text
        # As listing them returns them.
        assert response.json() == api_client.get(LIBCXX_SUITES).json()
        assert names(response.json()["items"]) == ["bench", "nts"]
        assert listed(api_client)["libcxx"] == ["bench", "nts"]
        assert schema_version_of(db_engine) == before + 1

    @pytest.mark.parametrize(
        ("project_name", "order"), [("libcxx", ["nts", "bench"]), ("swift", [])]
    )
    def test_an_order_that_is_the_current_one_changes_nothing(
        self,
        api_client: TestClient,
        manage: dict[str, str],
        db_engine: Engine,
        project_name: str,
        order: list[str],
    ) -> None:
        before = schema_version_of(db_engine)

        response = api_client.patch(
            SUITES_PATH.format(project=project_name), json={"order": order}, headers=manage
        )

        assert response.status_code == 200
        assert names(response.json()["items"]) == order
        assert schema_version_of(db_engine) == before

    @pytest.mark.parametrize(
        ("order", "message"),
        [
            (["bench"], "it leaves out 'nts'"),
            (["bench", "nts", "other"], "it names 'other', which is not among them"),
            (["bench", "nts", "bench"], "it names 'bench' more than once"),
        ],
    )
    def test_refuses_an_order_that_does_not_name_each_suite_once(
        self, api_client: TestClient, manage: dict[str, str], order: list[str], message: str
    ) -> None:
        response = api_client.patch(LIBCXX_SUITES, json={"order": order}, headers=manage)

        assert response.status_code == 400
        assert code_of(response) == "invalid_request"
        assert error_message(response) == (
            "The order must name each of the test suites of project 'libcxx' exactly once, but "
            f"{message}."
        )
        assert listed(api_client)["libcxx"] == ["nts", "bench"]

    @pytest.mark.parametrize("body", [{}, {"order": None}, {"order": [None]}])
    def test_refuses_a_bad_body(
        self, api_client: TestClient, manage: dict[str, str], body: dict[str, Any]
    ) -> None:
        response = api_client.patch(LIBCXX_SUITES, json=body, headers=manage)

        assert response.status_code == 400
        assert code_of(response) == "invalid_request"

    def test_is_404_for_a_project_that_does_not_exist(
        self, api_client: TestClient, manage: dict[str, str]
    ) -> None:
        response = api_client.patch(
            SUITES_PATH.format(project="nope"), json={"order": []}, headers=manage
        )

        assert response.status_code == 404
        assert error_message(response) == "Project 'nope' not found"

    def test_puts_a_new_suite_last(self, api_client: TestClient, manage: dict[str, str]) -> None:
        api_client.patch(LIBCXX_SUITES, json={"order": ["bench", "nts"]}, headers=manage)

        api_client.post(LIBCXX_SUITES, json={**NTS, "name": "aaa"}, headers=manage)

        assert listed(api_client)["libcxx"] == ["bench", "nts", "aaa"]

    @pytest.mark.parametrize(
        ("body", "where"),
        [
            ({"project": "llvm"}, {"libcxx": ["bench"], "llvm": ["zzz", "nts"]}),
            (
                {"project": "llvm", "name": "aaa"},
                {"libcxx": ["bench"], "llvm": ["zzz", "aaa"]},
            ),
            # Renamed within its project, it keeps its place.
            ({"name": "aaa"}, {"libcxx": ["aaa", "bench"], "llvm": ["zzz"]}),
        ],
    )
    def test_puts_a_suite_moved_to_another_project_last(
        self,
        api_client: TestClient,
        manage: dict[str, str],
        body: dict[str, Any],
        where: dict[str, list[str]],
    ) -> None:
        # `zzz` is created after `nts`, so `nts` sorts first unless the move puts it last.
        api_client.post(
            SUITES_PATH.format(project="llvm"), json={**NTS, "name": "zzz"}, headers=manage
        )

        response = api_client.patch(f"{LIBCXX_SUITES}/nts", json=body, headers=manage)
        assert response.status_code == 200, response.text

        found = listed(api_client)
        assert {name: found[name] for name in ("libcxx", "llvm")} == where

    @pytest.mark.parametrize(
        "patch",
        [
            {"display_name": "NTS"},
            {"metrics": {"add": [{"name": "size", "type": "integer"}]}},
        ],
    )
    def test_a_change_to_a_suite_s_schema_keeps_its_place(
        self, api_client: TestClient, manage: dict[str, str], patch: dict[str, Any]
    ) -> None:
        response = api_client.patch(f"{LIBCXX_SUITES}/nts/schema", json=patch, headers=manage)
        assert response.status_code == 200, response.text

        assert listed(api_client)["libcxx"] == ["nts", "bench"]

    def test_deleting_a_suite_leaves_the_others_in_order(
        self, api_client: TestClient, manage: dict[str, str]
    ) -> None:
        for name in ("aaa", "zzz"):
            api_client.post(LIBCXX_SUITES, json={**NTS, "name": name}, headers=manage)
        api_client.patch(
            LIBCXX_SUITES, json={"order": ["zzz", "bench", "aaa", "nts"]}, headers=manage
        )

        response = api_client.delete(f"{LIBCXX_SUITES}/bench?confirm=true", headers=manage)
        assert response.status_code == 204

        assert listed(api_client)["libcxx"] == ["zzz", "aaa", "nts"]

    def test_is_retryable_while_a_suite_of_the_project_is_being_written(
        self, api_client: TestClient, manage: dict[str, str], db_engine: Engine
    ) -> None:
        # D2: a reorder waits only a bounded time for its locks.
        with db_engine.connect() as writing, writing.begin():
            lock_project(writing, "libcxx")

            response = api_client.patch(
                LIBCXX_SUITES, json={"order": ["bench", "nts"]}, headers=manage
            )

        assert response.status_code == 409
        assert code_of(response) == "retry"
        assert error_message(response).startswith("Project 'libcxx' is busy")


class TestRaces:
    def test_a_project_created_during_a_reorder_goes_after_the_projects_it_reorders(
        self, db_engine: Engine, background: Callable[..., Future[Any]]
    ) -> None:
        # Creating a project takes no lock, so it does not wait for the reorder's. It draws a
        # position larger than every one that existed then, which the reorder only hands out again.
        with db_engine.connect() as reordering, reordering.begin():
            members = locked_projects_in_order(reordering)
            reorder(reordering, project, members, ["swift", "llvm", "libcxx"], "the projects")
            # Waits for the counter's row, which both bump, once its project is stored.
            creating = background(create_project, ProjectCreate(name="aaa"), db_engine, Response())
            until_blocked(db_engine)

        creating.result(timeout=BLOCK_TIMEOUT)
        with db_engine.connect() as connection:
            ordered = connection.execute(select(project.c.name).order_by(project.c.position))
            assert list(ordered.scalars()) == ["swift", "llvm", "libcxx", "aaa"]

    def test_a_project_created_while_a_reorder_waits_is_not_missing_from_it(
        self,
        api_client: TestClient,
        manage: dict[str, str],
        db_engine: Engine,
        background: Callable[..., Future[Any]],
    ) -> None:
        # The reorder reads the projects in the statement that locks them, so a project created
        # while it waits is not one it expects the order to name, and goes after them.
        with db_engine.connect() as changing, changing.begin():
            changing.execute(text("UPDATE project SET display_name = 'Swift' WHERE name = 'swift'"))
            reordering = background(order_projects, db_engine, ["swift", "llvm", "libcxx"])
            until_blocked(db_engine)
            created = api_client.post(PROJECTS_PATH, json={"name": "aaa"}, headers=manage)
            assert created.status_code == 201

        reordered = reordering.result(timeout=BLOCK_TIMEOUT)
        assert [found.name for found in reordered.items] == ["swift", "llvm", "libcxx", "aaa"]

    @pytest.mark.parametrize(
        ("change", "message"),
        [
            (
                "UPDATE project SET name = 'swiftlang' WHERE name = 'swift'",
                "it leaves out 'swiftlang'; it names 'swift', which is not among them",
            ),
            (
                "DELETE FROM project WHERE name = 'swift'",
                "it names 'swift', which is not among them",
            ),
        ],
    )
    def test_a_project_renamed_or_deleted_while_a_reorder_waits_is_refused_as_it_was(
        self,
        db_engine: Engine,
        background: Callable[..., Future[Any]],
        change: str,
        message: str,
    ) -> None:
        with db_engine.connect() as changing, changing.begin():
            changing.execute(text(change))
            reordering = background(order_projects, db_engine, ["swift", "llvm", "libcxx"])
            until_blocked(db_engine)

        with pytest.raises(ApiError) as raised:
            reordering.result(timeout=BLOCK_TIMEOUT)
        assert raised.value.code is ErrorCode.INVALID_REQUEST
        assert raised.value.message.endswith(f"but {message}.")

    def test_a_suite_created_during_a_reorder_waits_and_goes_last(
        self, db_engine: Engine, background: Callable[..., Future[Any]]
    ) -> None:
        with db_engine.connect() as reordering, reordering.begin():
            members = locked_suites_in_order(reordering, "libcxx")
            reorder(reordering, schema, members, ["bench", "nts"], "the suites")
            body = SuiteSchema.model_validate({**NTS, "name": "aaa"})
            creating = background(create_suite, "libcxx", body, db_engine, Response())
            until_blocked(db_engine)

        creating.result(timeout=BLOCK_TIMEOUT)
        with db_engine.connect() as connection:
            ordered = connection.execute(select(schema.c.name).order_by(schema.c.position))
            assert list(ordered.scalars()) == ["bench", "nts", "aaa"]

    def test_a_suite_reorder_through_the_old_name_of_a_project_being_renamed_is_a_404(
        self, db_engine: Engine, background: Callable[..., Future[Any]]
    ) -> None:
        with db_engine.connect() as renaming, renaming.begin():
            renaming.execute(text("UPDATE project SET name = 'libcpp' WHERE name = 'libcxx'"))
            reordering = background(order_suites, db_engine, "libcxx", ["bench", "nts"])
            until_blocked(db_engine)

        with pytest.raises(ApiError) as raised:
            reordering.result(timeout=BLOCK_TIMEOUT)
        assert raised.value.code is ErrorCode.NOT_FOUND


class TestRegistry:
    def test_another_worker_sees_the_new_order(self, db_engine: Engine) -> None:
        # D2: a reorder changes no stored schema, so the worker keeps every suite it built, but
        # still lists them in the new order.
        registry = SuiteRegistry()
        with db_engine.connect() as connection:
            before = registry.resolve_project(connection, "libcxx").suites

        order_projects(db_engine, ["swift", "libcxx", "llvm"])
        order_suites(db_engine, "libcxx", ["bench", "nts"])

        with db_engine.connect() as connection:
            projects = registry.fresh(connection)
        assert list(projects) == ["swift", "libcxx", "llvm"]
        after = projects["libcxx"].suites
        assert list(after) == ["bench", "nts"]
        assert all(after[name] is before[name] for name in before)

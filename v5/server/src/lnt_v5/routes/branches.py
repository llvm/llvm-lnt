"""Branches: the lines of history a suite's ordered commits are on (E3).

A branch is not an entity but a value commits share (D1), so this is a read-only list of the values
in use, for a client to offer a choice of one: the Graph plots one branch at a time. Only commits
with an ordinal count, the only ones a series or a trend can place.

Its own route rather than one under `/commits`, where `branches` would be taken for a commit's
value.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter
from pydantic import BaseModel, Field
from sqlalchemy import Connection, Select, String, cast, func, null, select, union_all

from lnt_v5 import examples
from lnt_v5.auth import require_scope
from lnt_v5.db import EngineDep
from lnt_v5.responses import Items
from lnt_v5.routes.suites import SUITES_PATH
from lnt_v5.scopes import Scope
from lnt_v5.suites.registry import RegistryDep, Suite
from lnt_v5.suites.scope import ProjectName, SuiteName, suite_responses, suite_scope

BRANCHES_PATH = f"{SUITES_PATH}/{{suite}}/branches"

router = APIRouter(prefix=BRANCHES_PATH, tags=["Commits"])


# An object around a single key, like a test, so that it can gain keys later.
#
# The docstring is published, as the description I8's document gives this schema, so it is written
# for API users.
class Branch(BaseModel):
    """A branch that commits with an ordinal are on."""

    name: str | None = Field(
        description="The branch's name, or null for the commits without a branch.",
        examples=[examples.BRANCH],
    )


def branch_names(connection: Connection, suite: Suite) -> list[str | None]:
    """The branches of the suite's commits with an ordinal, by code point, after null if some
    such commit has none (E3).

    PostgreSQL has no loose index scan, so a `DISTINCT` would read the whole `(branch, ordinal)`
    index, an entry per ordered commit, of which a suite can hold hundreds of thousands. A
    recursive walk instead asks the index for the least branch after the previous one, a probe per
    branch: a suite has few. It walks in the column's collation, the index's, and only the result
    is sorted by code point.
    """
    commit = suite.tables.commit
    ordered = commit.c.ordinal.is_not(None)

    def least(*conditions: Any) -> Select[Any]:
        # `min` leaves out the nulls, and PostgreSQL answers it with a probe of the index.
        return select(func.min(commit.c.branch).label("branch")).where(ordered, *conditions)

    walk = least().cte("walk", recursive=True)
    walk = walk.union_all(
        select(least(commit.c.branch > walk.c.branch).scalar_subquery()).where(
            walk.c.branch.is_not(None)
        )
    )
    unbranched = select(commit.c.id).where(ordered, commit.c.branch.is_(None)).exists()
    found = union_all(
        select(walk.c.branch).where(walk.c.branch.is_not(None)),
        select(cast(null(), String).label("branch")).where(unbranched),
    ).subquery()
    query = select(found.c.branch).order_by(found.c.branch.collate("C").nulls_first())
    return list(connection.execute(query).scalars())


@router.get(
    "",
    dependencies=[require_scope(Scope.READ)],
    summary="List branches",
    responses=suite_responses(),
)
def list_branches(
    project: ProjectName,
    testsuite: SuiteName,
    engine: EngineDep,
    registry: RegistryDep,
) -> Items[Branch]:
    """The branches that the suite's commits with an ordinal are on: first null, if some of them
    have no branch, then each branch name, by code point. Commits without an ordinal aren't
    considered. Use a name with `branch=`, or null with `has_branch=false`, on the commit list, the
    series and the trends."""
    with (
        engine.connect() as connection,
        suite_scope(registry, connection, project, testsuite) as suite,
    ):
        return Items(items=[Branch(name=name) for name in branch_names(connection, suite)])

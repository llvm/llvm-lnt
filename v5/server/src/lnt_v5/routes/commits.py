"""Commits: the named points that group runs (endpoints.md, Commits).

A commit is one of the two entities carrying schema-declared metadata (D7), so the object these
endpoints accept and return is the same one a run submission nests under `commit`: the identity
attribute `value`, the built-in `ordinal` and `tag`, and a `fields` dict of declared
`commit_fields`. That object, and the validation of `fields`, live in `suites/entities.py`, shared
with everything else that writes one; only the response models are here.

Three things here are specific to commits. `ordinal` is unique within the suite (D11), so a write
that would give two commits the same one answers R4's `ordinal_conflict` rather than the generic
`conflict` -- a distinction R4 draws deliberately, because a caller cannot recover from it by
retrying. `previous`/`next` on the detail response are computed by asking for the nearest ordinal in
each direction, never by following a stored link (D11). And this list is the first cursor-paginated
one: see `querying.Keyset` for the mechanism, which the run, test and time-series lists will share.
"""

from __future__ import annotations

from typing import Annotated, Any, Literal

from fastapi import APIRouter, Query, Response
from pydantic import BaseModel, ConfigDict, Field, StringConstraints
from sqlalchemy import (
    ColumnElement,
    Connection,
    Row,
    Select,
    Table,
    delete,
    insert,
    select,
    update,
)

from lnt_v5.auth import require_scope
from lnt_v5.db import EngineDep, reporting_violation
from lnt_v5.errors import ApiError, ErrorCode
from lnt_v5.querying import (
    DEFAULT_LIMIT,
    MAX_LIMIT,
    Cursor,
    Keyset,
    Limit,
    SortKey,
    cursor_page,
    search_condition,
    sort_order,
)
from lnt_v5.responses import CursorPage
from lnt_v5.routes.machines import NO_MACHINE_FILTERED, machine_id
from lnt_v5.routes.suites import SUITES_PATH
from lnt_v5.scopes import Scope
from lnt_v5.suites.entities import (
    CommitObject,
    Contradiction,
    EntityObject,
    FieldValue,
    Ordinal,
    Storable,
    create_or_reconcile,
    identifier,
    location_of,
    rendered_fields,
    validate_fields,
)
from lnt_v5.suites.registry import RegistryDep, Suite
from lnt_v5.suites.schema import CommitField
from lnt_v5.suites.scope import SUITE_NOT_FOUND, SUITE_SCHEMA_CHANGED, suite_responses, suite_scope
from lnt_v5.suites.submission import SubmittedCommit
from lnt_v5.suites.tables import (
    COMMIT_ORDINAL_CONSTRAINT,
    COMMIT_VALUE_CONSTRAINT,
    NAME_LENGTH,
    REGRESSION_COMMIT_CONSTRAINT,
)

COMMITS_PATH = f"{SUITES_PATH}/{{testsuite}}/commits"

router = APIRouter(prefix=COMMITS_PATH, tags=["Commits"])

Tag = Annotated[
    str,
    StringConstraints(min_length=1, max_length=NAME_LENGTH),
    Storable,
    Field(
        description=(
            "An editorial label, such as a release name. Several commits may share one. Set only "
            "through PATCH, never at creation or by a run submission."
        )
    ),
]

# endpoints.md names these two and no others. A literal rather than a free string, so R8's document
# enumerates them and an unknown one is a 400 before the endpoint runs.
CommitSort = Literal["ordinal", "-ordinal"]

# Every operation here reaches the suite's own tables, so every one can answer both of the failures
# `suite_scope` produces; each widens the wording with the cases it adds of its own.
_NO_COMMIT = f"{SUITE_NOT_FOUND} Or no commit in it has that value."
_ORDINAL_TAKEN = f"The ordinal is already held by another commit. {SUITE_SCHEMA_CHANGED}"


class Commit(CommitObject):
    """A commit as every response carries it.

    `ordinal` and `fields` are redeclared without their defaults, and `tag` is added. R4 requires
    every documented key to be present in a response, and inheriting the request model's
    optionality would instead tell a generated client they may be absent.
    """

    ordinal: Ordinal | None
    tag: Tag | None
    fields: dict[str, FieldValue]


class CommitDetail(Commit):
    """What the detail, create and update responses carry: a commit and its ordinal neighbours.

    The neighbours are plain commit objects, without neighbours of their own -- the chain stops
    after one step, so a client walking the order pages through it one request at a time.
    """

    previous: Commit | None = Field(
        description=(
            "The commit with the nearest lower ordinal, or null at the start of the ordered range "
            "and on a commit with no ordinal of its own. Commits with no ordinal are skipped."
        )
    )
    next: Commit | None = Field(
        description="The commit with the nearest higher ordinal, under the same rules."
    )


class CommitUpdate(EntityObject):
    """What `PATCH` may change. A key the request omits is left unchanged.

    Every key is optional, and the endpoint dumps this with `exclude_unset`, which is what keeps an
    omitted key apart from one sent as `null`: `ordinal: null` and `tag: null` clear a stored value,
    while omitting them leaves it alone. Inside `fields`, an explicit null clears likewise. `value`
    is not here at all, because a commit cannot be renamed -- sending one is a 400.
    """

    ordinal: Ordinal | None = None
    tag: Tag | None = None


class ResolveRequest(BaseModel):
    """The body of `POST /commits/resolve`."""

    model_config = ConfigDict(extra="forbid")

    # Bounded in length but not in what each entry may say: a value too long to be a commit, or
    # shaped like nothing that could be one, is still a value this suite does not hold, and the
    # endpoint's contract is to report that under `not_found` rather than fail the whole lookup.
    # The count is capped at R2's page ceiling, so that one request cannot expand into a statement
    # with more bind parameters than the protocol carries.
    commits: list[str] = Field(
        min_length=1,
        max_length=MAX_LIMIT,
        description=(
            "The commit values to look up: at least one, at most 10 000. Duplicates are resolved "
            "once. A value that is not a commit in this suite is reported under 'not_found' "
            "rather than failing the request."
        ),
    )


class ResolvedCommits(BaseModel):
    """The body of `POST /commits/resolve`: a lookup table, not one of R2's list envelopes.

    R2's `items` rule governs a list endpoint's top-level body; this is a table keyed by commit
    value, which is what makes it useful -- a client resolving a page of runs looks each one up by
    the value it already holds.
    """

    results: dict[str, Commit] = Field(
        description="Each commit that exists, keyed by the value it was asked for."
    )
    not_found: list[str] = Field(
        description="The requested values that name no commit in this suite."
    )


class Commits:
    """The query every commit response is built from, and how to read one of its rows back.

    Public because a run submission creates commits too (D7), and the table, the two 409 wordings
    and the constraint names it needs are all already here; `routes/runs.py` reaches
    `get_or_create` below rather than restating any of them.

    Holds the internal `id` alongside the commit's own columns: it is never rendered -- R1 keeps
    auto-increment ids out of the API entirely -- but it is the unique tiebreaker D10 requires under
    every cursor, and the default order endpoints.md gives this list.
    """

    def __init__(self, suite: Suite) -> None:
        self.schema = suite.schema
        self.table: Table = suite.tables.commit
        self._run: Table = suite.tables.run
        self._profile: Table = suite.tables.profile

    def select(self) -> Select[Any]:
        return select(
            self.table.c.id,
            self.table.c.commit,
            self.table.c.ordinal,
            self.table.c.tag,
            *(self.table.c[field.name] for field in self.schema.commit_fields),
        )

    def keyset(self, sort: CommitSort | None) -> Keyset:
        """D10's ordering for this list: the caller's sort, then the internal tiebreaker.

        With no `sort`, the tiebreaker is the whole order -- endpoints.md makes that the order in
        which the server first saw each commit, which is deliberately not the ordinal order.
        """
        if sort is None:
            return Keyset(tiebreaker=self.table.c.id)
        _, descending = sort_order(sort)
        return Keyset(SortKey(self.table.c.ordinal, descending), tiebreaker=self.table.c.id)

    def search(self, term: str) -> ColumnElement[bool]:
        return search_condition(term, self.table, ["commit", "tag"], self.schema.commit_fields)

    def has_run(self, machine: int | None, *, profiled: bool = False) -> ColumnElement[bool]:
        """Whether this commit has a run -- on that machine if one is named, carrying a profile if
        asked for.

        One predicate for both filters, because endpoints.md scopes `has_profiles=` to `machine=`
        when both are given: they describe one set of runs rather than two independent ones.
        """
        source = (
            self._run.join(self._profile, self._profile.c.run_id == self._run.c.id)
            if profiled
            else self._run
        )
        conditions = [self._run.c.commit_id == self.table.c.id]
        if machine is not None:
            conditions.append(self._run.c.machine_id == machine)
        return select(1).select_from(source).where(*conditions).exists()

    def read(self, row: Row[Any]) -> Commit:
        return Commit(
            value=row._mapping[self.table.c.commit],
            ordinal=row._mapping[self.table.c.ordinal],
            tag=row._mapping[self.table.c.tag],
            fields=rendered_fields(self.schema.commit_fields, self.table, row),
        )

    def one(self, connection: Connection, value: str) -> Commit:
        row = connection.execute(self.select().where(self.table.c.commit == value)).one_or_none()
        if row is None:
            raise self.missing(value)
        return self.read(row)

    def detail(self, connection: Connection, value: str) -> CommitDetail:
        """One commit with its ordinal neighbours, as the detail, create and update responses go."""
        commit = self.one(connection, value)
        return CommitDetail(
            **commit.model_dump(),
            previous=self.neighbour(connection, commit.ordinal, lower=True),
            next=self.neighbour(connection, commit.ordinal, lower=False),
        )

    def neighbour(
        self, connection: Connection, ordinal: int | None, *, lower: bool
    ) -> Commit | None:
        """The commit with the nearest lower or higher ordinal (D11).

        A query for the nearest ordinal rather than a stored link, so nothing has to be maintained
        when an ordinal is assigned, changed or cleared. A commit with no ordinal has no neighbours,
        and is never anyone else's: the comparison below is unknown for a null ordinal, so those
        rows drop out without being filtered for.
        """
        if ordinal is None:
            return None
        column = self.table.c.ordinal
        row = connection.execute(
            self.select()
            .where(column < ordinal if lower else column > ordinal)
            .order_by(column.desc() if lower else column.asc())
            .limit(1)
        ).one_or_none()
        return None if row is None else self.read(row)

    def missing(self, value: str) -> ApiError:
        """The 404 for a commit that is not there, worded in one place for all its callers."""
        return _missing(self.schema.name, value)

    def taken(self, value: str) -> str:
        return f"A commit '{value}' already exists in test suite '{self.schema.name}'"

    def ordinal_taken(self, ordinal: int | None) -> str:
        return (
            f"Ordinal {ordinal} is already held by another commit in test suite "
            f"'{self.schema.name}'"
        )

    def in_use(self, value: str) -> str:
        return (
            f"Commit '{value}' is referenced by a regression in test suite "
            f"'{self.schema.name}' and cannot be deleted until that reference is removed"
        )

    def get_or_create(self, connection: Connection, submitted: SubmittedCommit) -> int:
        """The id of the commit a run submission names, creating it if it is not there (D7, D13).

        `ordinal` is reconciled exactly as a declared field is -- D7 says so, because it is nullable
        and factual rather than a policy flag: it is set when the commit has none, left alone when
        it already equals the submitted one, and refused when it differs. What it does not share is
        the code: R4 answers a contradicted ordinal with `ordinal_conflict`, which it splits out
        because a client cannot recover from it by retrying.

        `uq_commit_ordinal` is attributed around the whole body rather than around either statement,
        and that placement is load-bearing. The INSERT can trip it -- another commit already holds
        the ordinal -- in which case the get-or-create re-raises rather than treating it as a lost
        race, and this is what turns the re-raise into R4's 409 instead of a 500. The UPDATE that
        fills in a NULL ordinal can equally lose that race to a commit created since.
        """
        # D7: only what the submission sends is matched, so the ordinal joins the fields exactly
        # when one was sent. An omitted ordinal is neither compared nor written, and can never be
        # the reason a submission is refused.
        matched: dict[str, Any] = dict(submitted.fields)
        if submitted.ordinal is not None:
            matched["ordinal"] = submitted.ordinal

        with reporting_violation(
            COMMIT_ORDINAL_CONSTRAINT,
            ErrorCode.ORDINAL_CONFLICT,
            self.ordinal_taken(submitted.ordinal),
        ):
            return create_or_reconcile(
                connection,
                self.table.c.commit,
                submitted.value,
                constraint=COMMIT_VALUE_CONSTRAINT,
                values={"ordinal": submitted.ordinal, **submitted.fields},
                matched=matched,
                contradiction=self._contradicted(submitted.value),
            )

    def _contradicted(self, value: str) -> Contradiction:
        """The 409 for a submitted value that disagrees with the stored one (D7, D11).

        Two codes from one rule, which is why this branches on the key rather than being two
        functions: R4 gives a contradicted field the generic `conflict`, and a contradicted ordinal
        `ordinal_conflict`, because the second tells the client its view of the commit order is
        wrong and that retrying cannot help. Both name the stored value and the submitted one, so
        that a submitter can fix its configuration without reading the database.

        The branch is unambiguous because D5 forbids a `commit_field` from taking a built-in
        column's name, so `ordinal` here is always the built-in attribute and never a declared one.
        """

        def error(key: str, stored: Any, submitted: Any) -> ApiError:
            if key == "ordinal":
                return ApiError(
                    ErrorCode.ORDINAL_CONFLICT,
                    f"Commit '{value}' in test suite '{self.schema.name}' is already at ordinal "
                    f"{stored}, but this submission places it at {submitted}. Use PATCH to move a "
                    f"commit once its ordinal is set.",
                )
            return ApiError(
                ErrorCode.CONFLICT,
                f"Commit '{value}' in test suite '{self.schema.name}' already has "
                f"{key}={stored!r}, but this submission says {submitted!r}. A submission never "
                f"overwrites stored metadata; use PATCH to change it.",
            )

        return error


def _missing(testsuite: str, value: str) -> ApiError:
    """The 404 for a commit no suite holds, shared by the commit routes and by every body that
    names one."""
    return ApiError(ErrorCode.NOT_FOUND, f"No commit '{value}' in test suite '{testsuite}'")


def commit_id(connection: Connection, suite: Suite, value: str) -> int:
    """The id of the commit a request body names, or the 404 for a value no commit has.

    `machines.machine_id`'s counterpart, and here for the same reason: the lookup and the wording
    of its 404 belong with the entity. Deliberately unlike the `commit=` *filter*, which R3 answers
    with an empty page -- this one resolves a value the request asked to store, and storing a
    reference to a commit that is not there is not something the caller meant.
    """
    commit = suite.tables.commit
    return identifier(
        connection, commit.c.commit, value, lambda missed: _missing(suite.schema.name, missed)
    )


def commit_ordinal(connection: Connection, suite: Suite, value: str) -> int:
    """The ordinal of a commit a request body names as a range boundary (D11).

    `POST /query`'s `after_commit`/`before_commit` name a commit and mean its *position*, so both
    ways of failing to have one are the caller's mistake and neither is an empty page. A value no
    commit has is the 404 R4 gives an entity named by a request body -- deliberately unlike the
    `commit=` filter beside it, which R3 answers with an empty result, because that one asks which
    rows belong to a commit whereas this one asks where a commit sits. And a commit that exists but
    has no ordinal sits nowhere (D1), so there is no comparison to make: that is a 400, since no
    data would answer it either.

    A SELECT of its own rather than `entities.identifier` or `Commits.one`: the first projects the
    row's `id`, which is not what a bound needs, and the second reads every declared commit field
    to build a response body that is thrown away.
    """
    commit = suite.tables.commit
    row = connection.execute(select(commit.c.ordinal).where(commit.c.commit == value)).one_or_none()
    if row is None:
        raise _missing(suite.schema.name, value)
    if row.ordinal is None:
        raise ApiError(
            ErrorCode.INVALID_REQUEST,
            f"Commit '{value}' in test suite '{suite.schema.name}' has no ordinal, so it has no "
            f"position in the commit order and cannot bound a range. Give it one with PATCH.",
        )
    return int(row.ordinal)


@router.get(
    "",
    dependencies=[require_scope(Scope.READ)],
    summary="List commits",
    responses=suite_responses(not_found=NO_MACHINE_FILTERED),
)
def list_commits(
    testsuite: str,
    engine: EngineDep,
    registry: RegistryDep,
    search: Annotated[
        str | None,
        Query(
            description=(
                "Case-insensitive substring match against the commit value, the tag, or any "
                "searchable commit field."
            )
        ),
    ] = None,
    machine: Annotated[
        str | None,
        Query(description="Keep only commits with at least one run on this machine."),
    ] = None,
    has_profiles: Annotated[
        bool | None,
        Query(
            description=(
                "Keep only commits that have a run carrying profile data, or only those that have "
                "none. Scoped to `machine=` when that is given too. Omit for both."
            )
        ),
    ] = None,
    sort: Annotated[
        CommitSort | None,
        Query(
            description=(
                "Order by ordinal, ascending (oldest first) or descending; either way, commits "
                "with no ordinal are excluded. Omit to order by the sequence in which the server "
                "first saw each commit, which keeps every commit."
            )
        ),
    ] = None,
    limit: Limit = DEFAULT_LIMIT,
    cursor: Cursor = None,
) -> CursorPage[Commit]:
    """Every commit in the suite, filtered, ordered and cursor-paginated (R2, R3, D9, D10).

    Omitting `sort` orders by the internal id, which is the order the server first saw each commit
    in; `sort=ordinal` orders by the ordinal instead and excludes the commits that have none, since
    they have no position in that order. That exclusion comes from the keyset rather than from here
    (D10, `querying.Keyset.defined`).
    """
    with engine.connect() as connection, suite_scope(registry, connection, testsuite) as suite:
        commits = Commits(suite)
        conditions: list[ColumnElement[bool]] = []
        if search is not None:
            conditions.append(commits.search(search))

        on_machine = None
        if machine is not None:
            on_machine = machine_id(connection, suite, machine)
            # Redundant when `has_profiles=true` follows, which implies a run on this machine.
            if has_profiles is not True:
                conditions.append(commits.has_run(on_machine))
        if has_profiles is not None:
            profiled = commits.has_run(on_machine, profiled=True)
            conditions.append(profiled if has_profiles else ~profiled)

        return cursor_page(
            connection,
            commits.select().where(*conditions),
            commits.keyset(sort),
            limit,
            cursor,
            commits.read,
        )


@router.post(
    "",
    status_code=201,
    dependencies=[require_scope(Scope.SUBMIT)],
    summary="Create a commit",
    responses=suite_responses(
        conflict=f"A commit with that value already exists. {_ORDINAL_TAKEN}"
    ),
)
def create_commit(
    testsuite: str,
    body: CommitObject,
    engine: EngineDep,
    registry: RegistryDep,
    response: Response,
) -> CommitDetail:
    """Create a commit without a run, optionally placing it in the order (D7, D11).

    Commits are also created implicitly by run submission; this is the path for declaring one ahead
    of any data, or for giving an ordinal to a commit that will never carry any.
    """
    with engine.begin() as connection, suite_scope(registry, connection, testsuite) as suite:
        commits = Commits(suite)
        values = validate_fields(suite.schema, CommitField, body.fields)
        with (
            reporting_violation(
                COMMIT_VALUE_CONSTRAINT, ErrorCode.DUPLICATE, commits.taken(body.value)
            ),
            reporting_violation(
                COMMIT_ORDINAL_CONSTRAINT,
                ErrorCode.ORDINAL_CONFLICT,
                commits.ordinal_taken(body.ordinal),
            ),
        ):
            connection.execute(
                insert(commits.table).values(commit=body.value, ordinal=body.ordinal, **values)
            )
        created = commits.detail(connection, body.value)

    response.headers["Location"] = location_of(COMMITS_PATH, testsuite, body.value)
    return created


@router.post(
    "/resolve",
    dependencies=[require_scope(Scope.READ)],
    summary="Resolve commits in bulk",
    responses=suite_responses(),
)
def resolve_commits(
    testsuite: str, body: ResolveRequest, engine: EngineDep, registry: RegistryDep
) -> ResolvedCommits:
    """Look up many commits at once, for a client that holds a page of values and needs their
    metadata.

    `read`-scoped despite being a POST: the body is a lookup key too long for a query string, not a
    change (R5). Unpaginated, because the response is bounded by the request.
    """
    with engine.connect() as connection, suite_scope(registry, connection, testsuite) as suite:
        commits = Commits(suite)
        # Deduplicated, keeping the order the request gave, so that a client can read the response
        # back in the order it asked -- `dict` preserves insertion order, and JSON objects render
        # in it.
        requested = list(dict.fromkeys(body.commits))
        rows = connection.execute(
            commits.select().where(commits.table.c.commit.in_(requested))
        ).all()
        found = {commit.value: commit for commit in (commits.read(row) for row in rows)}
        return ResolvedCommits(
            results={value: found[value] for value in requested if value in found},
            not_found=[value for value in requested if value not in found],
        )


@router.get(
    "/{value}",
    dependencies=[require_scope(Scope.READ)],
    summary="Get a commit",
    responses=suite_responses(not_found=_NO_COMMIT),
)
def get_commit(
    testsuite: str, value: str, engine: EngineDep, registry: RegistryDep
) -> CommitDetail:
    """One commit, plus the commits either side of it in ordinal order (D11)."""
    with engine.connect() as connection, suite_scope(registry, connection, testsuite) as suite:
        return Commits(suite).detail(connection, value)


@router.patch(
    "/{value}",
    dependencies=[require_scope(Scope.MANAGE)],
    summary="Update a commit",
    responses=suite_responses(not_found=_NO_COMMIT, conflict=_ORDINAL_TAKEN),
)
def update_commit(
    testsuite: str, value: str, body: CommitUpdate, engine: EngineDep, registry: RegistryDep
) -> CommitDetail:
    """Set or clear the ordinal and tag, and/or set declared fields (D7, D11).

    This is the only way to change an ordinal once set, and the only way to set a tag at all. A key
    the request omits is left unchanged, inside `fields` as well as beside it.
    """
    with engine.begin() as connection, suite_scope(registry, connection, testsuite) as suite:
        commits = Commits(suite)
        changes = body.model_dump(exclude_unset=True)
        values: dict[str, Any] = {key: changes[key] for key in ("ordinal", "tag") if key in changes}
        if "fields" in changes:
            values |= validate_fields(suite.schema, CommitField, changes["fields"])

        # A request that changes nothing is still a 404 for a commit that is not there, which
        # `detail` answers on its own -- an UPDATE with no values would match no rows either way.
        if values:
            with reporting_violation(
                COMMIT_ORDINAL_CONSTRAINT,
                ErrorCode.ORDINAL_CONFLICT,
                commits.ordinal_taken(values.get("ordinal")),
            ):
                changed = connection.execute(
                    update(commits.table).where(commits.table.c.commit == value).values(**values)
                )
            if changed.rowcount == 0:
                raise commits.missing(value)
        return commits.detail(connection, value)


@router.delete(
    "/{value}",
    status_code=204,
    dependencies=[require_scope(Scope.MANAGE)],
    summary="Delete a commit",
    responses=suite_responses(
        not_found=_NO_COMMIT,
        conflict=f"A regression references this commit. {SUITE_SCHEMA_CHANGED}",
    ),
)
def delete_commit(testsuite: str, value: str, engine: EngineDep, registry: RegistryDep) -> None:
    """Delete a commit, its runs, and their samples and profiles (D1, D5).

    One statement: D5 gives `{suite}.run.commit_id` an `ON DELETE CASCADE`, and the runs take their
    samples and profiles with them in turn. `{suite}.regression.commit_id` deliberately has no
    cascade, so a commit a regression still names refuses to go -- reported as R4's `in_use`, which
    tells the caller to detach the regression rather than to retry.
    """
    with engine.begin() as connection, suite_scope(registry, connection, testsuite) as suite:
        commits = Commits(suite)
        with reporting_violation(
            REGRESSION_COMMIT_CONSTRAINT, ErrorCode.IN_USE, commits.in_use(value)
        ):
            removed = connection.execute(
                delete(commits.table).where(commits.table.c.commit == value)
            )
        if removed.rowcount == 0:
            raise commits.missing(value)

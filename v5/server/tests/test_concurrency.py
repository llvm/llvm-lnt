"""D13's get-or-create under actual concurrency, and D7's reconciliation on top of it.

The interesting failures here are the ones a single-threaded test cannot see: a savepoint that
rolls back more than the statement that failed, an insert that re-queries after the wrong kind of
integrity error, and a batch insert whose row order lets two submitters deadlock. So these drive a
real PostgreSQL from several threads, each on a connection of its own, and the races are made
deterministic rather than hoped for -- a transaction holds an uncommitted row, the test waits until
the other thread is demonstrably blocked on it, and only then commits.

`conftest.py`'s `db_engine` empties the database afterwards rather than rolling a transaction back,
which is what makes any of this possible: the code under test manages its own transactions and
savepoints, and an outer rollback-everything transaction would quietly interfere with both.
"""

from __future__ import annotations

import time
from collections.abc import Callable, Iterator, Sequence
from concurrent.futures import Future, ThreadPoolExecutor
from dataclasses import dataclass
from typing import Any

import pytest
from sqlalchemy import Connection, Engine, insert, select, text

from introspection import counted, counting_statements
from lnt_v5.errors import ApiError, ErrorCode
from lnt_v5.routes.commits import Commits
from lnt_v5.routes.machines import Machines
from lnt_v5.suites import tables as suite_tables
from lnt_v5.suites.concurrency import resolve_names
from lnt_v5.suites.registry import Suite
from lnt_v5.suites.schema import SuiteSchema
from lnt_v5.suites.submission import SubmittedCommit, SubmittedMachine
from lnt_v5.suites.tables import build

# A suite with a field of two different types on each entity, so that reconciliation is exercised
# against something other than text, and one metric because D5 gives every suite a sample table.
NTS: dict[str, Any] = {
    "name": "nts",
    "metrics": [{"name": "execution_time", "type": "real"}],
    "machine_fields": [
        {"name": "hardware", "type": "text"},
        {"name": "core_count", "type": "integer"},
    ],
    "commit_fields": [
        {"name": "author", "type": "text"},
        {"name": "commit_message", "type": "text"},
    ],
}

# How long a test waits for another thread to reach the lock it is supposed to block on. Generous,
# because it is only ever paid when something is wrong: the wait ends as soon as PostgreSQL reports
# the block, which takes milliseconds.
BLOCK_TIMEOUT = 20.0


@pytest.fixture
def suite(db_engine: Engine) -> Suite:
    """The `nts` suite's tables, created directly rather than through the API.

    Nothing here goes through an endpoint -- this is the layer underneath them -- so the schema is
    built in the test rather than posted. `db_engine` drops the namespace afterwards.
    """
    schema = SuiteSchema.model_validate(NTS)
    tables = build(schema)
    with db_engine.begin() as connection:
        suite_tables.create(connection, tables)
    return Suite(schema=schema, tables=tables, schema_json=schema.model_dump_json())


@pytest.fixture
def machines(suite: Suite) -> Machines:
    return Machines(suite)


@pytest.fixture
def commits(suite: Suite) -> Commits:
    return Commits(suite)


@pytest.fixture
def background() -> Iterator[Callable[..., Future[Any]]]:
    """Run something on a thread of its own, and re-raise whatever it raised when asked for it."""
    with ThreadPoolExecutor(max_workers=8) as pool:
        yield pool.submit


def submitted_machine(
    name: str = "linux", *, tracked: bool = True, **fields: Any
) -> SubmittedMachine:
    return SubmittedMachine(name=name, tracked=tracked, fields=fields)


def submitted_commit(
    value: str = "abc", *, ordinal: int | None = None, **fields: Any
) -> SubmittedCommit:
    return SubmittedCommit(value=value, ordinal=ordinal, fields=fields)


def until_blocked(engine: Engine) -> None:
    """Wait until some backend on this database is waiting on a lock.

    This is what makes a race deterministic instead of a sleep and a hope. The thread under test is
    expected to reach an INSERT that collides with an uncommitted row and wait there; PostgreSQL
    reports exactly that in `pg_stat_activity`, so the test can hold the winning transaction open
    until the loser has demonstrably arrived.
    """
    deadline = time.monotonic() + BLOCK_TIMEOUT
    while time.monotonic() < deadline:
        with engine.connect() as connection:
            waiting = connection.execute(
                text(
                    "SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() "
                    "AND wait_event_type = 'Lock'"
                )
            ).scalar_one()
        if waiting:
            return
        time.sleep(0.01)
    raise AssertionError(f"no backend blocked on a lock within {BLOCK_TIMEOUT}s")


def raced(
    db_engine: Engine,
    background: Callable[..., Future[Any]],
    winning: Callable[[Connection], Any],
    losing: Callable[[Connection], Any],
) -> Future[Any]:
    """Run `losing` against a `winning` transaction held open until the loser is blocked behind it.

    The staging `lost_race` uses for the INSERT race, generalized so that the *fill* race can use
    it too. What makes a fill race reproducible is precisely what makes an insert race
    reproducible: the winner writes and holds, so the loser is guaranteed to have read the state
    that predates the write, and only then does the winner commit.

    Hands back the loser's future rather than its result, because half of these races end in an
    `ApiError` the caller wants to inspect.
    """

    def lose() -> Any:
        with db_engine.connect() as connection, connection.begin():
            return losing(connection)

    winner = db_engine.connect()
    try:
        transaction = winner.begin()
        winning(winner)
        running = background(lose)
        until_blocked(db_engine)
        transaction.commit()
    finally:
        winner.close()
    return running


def stored(engine: Engine, suite: Suite, table: str, key: str, value: str) -> Any:
    """One row of a suite table, read on a connection of its own."""
    held = getattr(suite.tables, table)
    with engine.connect() as connection:
        return connection.execute(select(held).where(held.c[key] == value)).one()


@dataclass(frozen=True)
class LostRace:
    """What the loser of a deliberately staged race came away with."""

    winner_id: int
    loser_id: int
    earlier_work: int


@pytest.fixture
def lost_race(
    db_engine: Engine,
    machines: Machines,
    commits: Commits,
    background: Callable[..., Future[Any]],
) -> LostRace:
    """Stage D13's race so that one side is guaranteed to lose, and report what it got.

    The shape is the one that is reliable: the winner inserts the machine and holds its transaction
    open, so the loser's SELECT misses and its INSERT blocks on the unique index rather than failing
    outright. Committing the winner is what wakes it into the unique violation the savepoint exists
    to absorb.

    The loser does unrelated work of its own first -- it creates a commit -- because that is what a
    real submission does, and because a savepoint rolled back too far would take it with it.
    """

    def lose() -> LostRace:
        with db_engine.connect() as connection, connection.begin():
            earlier = commits.get_or_create(connection, submitted_commit("abc"))
            return LostRace(
                winner_id=0,
                loser_id=machines.get_or_create(connection, submitted_machine()),
                earlier_work=earlier,
            )

    winner = db_engine.connect()
    try:
        transaction = winner.begin()
        winner_id = machines.get_or_create(winner, submitted_machine())
        running = background(lose)
        until_blocked(db_engine)
        transaction.commit()
        outcome = running.result(timeout=BLOCK_TIMEOUT)
    finally:
        winner.close()
    return LostRace(winner_id, outcome.loser_id, outcome.earlier_work)


class TestLostRace:
    def test_the_loser_returns_the_row_the_winner_created(self, lost_race: LostRace) -> None:
        # D13: no error, no second row, and no client-side retry -- the loser re-queries and comes
        # back with the winner's machine.
        assert lost_race.loser_id == lost_race.winner_id

    def test_only_the_savepoint_is_rolled_back(
        self, lost_race: LostRace, db_engine: Engine, suite: Suite
    ) -> None:
        # The whole point of the savepoint, and what a naive `try: insert / except: re-query` gets
        # wrong by rolling back the transaction: the commit the loser created before the race is
        # still there, and still has the id it was given.
        assert lost_race.earlier_work == stored(db_engine, suite, "commit", "commit", "abc").id

    def test_exactly_one_row_survives_the_race(
        self, lost_race: LostRace, db_engine: Engine, suite: Suite
    ) -> None:
        assert counted(db_engine, suite.tables, "machine") == 1

    def test_an_ordinal_violation_is_not_mistaken_for_a_lost_race(
        self, db_engine: Engine, commits: Commits
    ) -> None:
        # The subtlety the recovery has to get right: a commit INSERT can trip `uq_commit_ordinal`
        # as well as `uq_commit_commit`, and only the second is a race. Swallowing this one would
        # re-query for a commit that was never created and report the wrong thing entirely.
        with db_engine.begin() as connection:
            commits.get_or_create(connection, submitted_commit("first", ordinal=5))
        with db_engine.begin() as connection, pytest.raises(ApiError) as failure:
            commits.get_or_create(connection, submitted_commit("second", ordinal=5))

        assert failure.value.code is ErrorCode.ORDINAL_CONFLICT

    def test_an_unrelated_integrity_failure_is_not_swallowed(
        self, db_engine: Engine, commits: Commits, suite: Suite
    ) -> None:
        # The same rule from the other side: filling in a NULL ordinal is an UPDATE, and it can lose
        # the ordinal to a commit created since. That is `ordinal_conflict` too, not a 500.
        with db_engine.begin() as connection:
            commits.get_or_create(connection, submitted_commit("abc"))
            commits.get_or_create(connection, submitted_commit("other", ordinal=7))
        with db_engine.begin() as connection, pytest.raises(ApiError) as failure:
            commits.get_or_create(connection, submitted_commit("abc", ordinal=7))

        assert failure.value.code is ErrorCode.ORDINAL_CONFLICT
        assert stored(db_engine, suite, "commit", "commit", "abc").ordinal is None


class TestBatchResolution:
    def test_resolves_nothing_without_a_statement(self, db_engine: Engine, suite: Suite) -> None:
        with db_engine.begin() as connection:
            assert resolve_names(connection, suite.tables.test, []) == {}

    def test_creates_every_name_it_does_not_find(self, db_engine: Engine, suite: Suite) -> None:
        with db_engine.begin() as connection:
            resolved = resolve_names(connection, suite.tables.test, ["b/two", "a/one"])

        assert sorted(resolved) == ["a/one", "b/two"]
        assert counted(db_engine, suite.tables, "test") == 2

    def test_returns_the_same_ids_the_second_time(self, db_engine: Engine, suite: Suite) -> None:
        with db_engine.begin() as connection:
            first = resolve_names(connection, suite.tables.test, ["a", "b"])
            second = resolve_names(connection, suite.tables.test, ["b", "c", "a"])

        assert {name: second[name] for name in first} == first
        assert counted(db_engine, suite.tables, "test") == 3

    def test_costs_the_same_statements_for_ten_names_as_for_ten_thousand(
        self, db_engine: Engine, suite: Suite
    ) -> None:
        """D13: a fixed number of round trips, "not a statement per name, nor one per chunk".

        The guarantee no assertion about stored rows can see. A loop over names, or a chunked
        insert, produces exactly the same `{suite}.test` table and passes every other test in this
        class, while turning a submission naming tens of thousands of tests into tens of thousands
        of statements. Two sets three orders of magnitude apart, both entirely new so that both
        take the read-insert-read path, and the requirement is that the counts are equal.
        """
        with db_engine.begin() as connection:
            with counting_statements("nts.test") as few:
                resolve_names(connection, suite.tables.test, [f"a/{index}" for index in range(10)])
            with counting_statements("nts.test") as many:
                resolve_names(
                    connection, suite.tables.test, [f"b/{index}" for index in range(10_000)]
                )

        # Three: read what exists, insert the rest, read back the ones the insert skipped.
        assert len(many) == len(few) == 3

    def test_costs_one_statement_when_every_name_is_already_there(
        self, db_engine: Engine, suite: Suite
    ) -> None:
        # The other half of the claim, and the case a producer resubmitting the same suite hits on
        # every run after its first: nothing needs creating, so only the opening read runs.
        names = [f"a/{index}" for index in range(100)]
        with db_engine.begin() as connection:
            resolve_names(connection, suite.tables.test, names)
            with counting_statements("nts.test") as again:
                resolve_names(connection, suite.tables.test, names)

        assert len(again) == 1

    def test_resolves_a_name_a_concurrent_transaction_won(
        self, db_engine: Engine, suite: Suite, background: Callable[..., Future[Any]]
    ) -> None:
        # The batch counterpart of the single-row race, and the reason the statement re-SELECTs
        # rather than trusting `RETURNING`: `ON CONFLICT DO NOTHING` returns nothing for the row the
        # winner inserted, so a mapping built from `RETURNING` alone would be missing "shared".
        def lose() -> dict[str, int]:
            with db_engine.connect() as connection, connection.begin():
                return resolve_names(connection, suite.tables.test, ["shared", "mine"])

        winner = db_engine.connect()
        try:
            transaction = winner.begin()
            won = resolve_names(winner, suite.tables.test, ["shared", "theirs"])
            running = background(lose)
            until_blocked(db_engine)
            transaction.commit()
            resolved = running.result(timeout=BLOCK_TIMEOUT)
        finally:
            winner.close()

        assert sorted(resolved) == ["mine", "shared"]
        assert resolved["shared"] == won["shared"]
        assert counted(db_engine, suite.tables, "test") == 3

    def test_overlapping_sets_resolve_consistently_under_load(
        self, db_engine: Engine, suite: Suite, background: Callable[..., Future[Any]]
    ) -> None:
        # Several threads resolving overlapping sets at once, each in a different order, which is
        # the arrangement that deadlocks a batch insert that writes rows in the order it was given
        # them: two transactions each hold a speculative insertion lock the other is waiting for,
        # and PostgreSQL kills one. That surfaces here as an exception out of `result()` rather than
        # as a wrong answer, so "nothing raised" is half of what this asserts.
        names = [f"suite/test-{index:03d}" for index in range(200)]
        # Every thread wants every name, so the overlap is total; the orders are deliberately
        # incompatible with each other, and none of them is the ascending one the insert imposes.
        sets = [
            names,
            list(reversed(names)),
            names[100:] + names[:100],
            list(reversed(names[100:] + names[:100])),
            names[::2] + names[1::2],
            names[1::2] + names[::2],
        ]

        def resolve(wanted: Sequence[str]) -> dict[str, int]:
            with db_engine.connect() as connection, connection.begin():
                return resolve_names(connection, suite.tables.test, wanted)

        running = [background(resolve, wanted) for wanted in sets]
        resolutions = [future.result(timeout=BLOCK_TIMEOUT) for future in running]

        # One row per distinct name, and every thread agreeing on which id each name has -- which is
        # what a duplicate row would break even if no statement had failed.
        agreed: dict[str, int] = {}
        for resolution in resolutions:
            agreed |= resolution
        assert set(agreed) == set(names)
        for resolution in resolutions:
            assert resolution == {name: agreed[name] for name in resolution}
        assert counted(db_engine, suite.tables, "test") == len(names)

    def test_fails_loudly_if_a_name_is_still_unresolved(
        self, db_engine: Engine, suite: Suite
    ) -> None:
        # Nothing deletes a test (D5), so there is no legitimate way to get here; the check exists
        # so that a table which has somehow stopped accepting rows is a fault rather than a run
        # whose samples silently attach to the wrong tests. Forced with a rule that swallows the
        # insert, since no ordinary sequence of API calls can produce it.
        with db_engine.begin() as connection:
            connection.execute(
                text('CREATE RULE "skip" AS ON INSERT TO nts.test DO INSTEAD NOTHING')
            )
        with db_engine.begin() as connection, pytest.raises(RuntimeError, match="did not resolve"):
            resolve_names(connection, suite.tables.test, ["a"])


class TestMachineReconciliation:
    def test_creates_the_machine_with_what_the_submission_sent(
        self, db_engine: Engine, machines: Machines, suite: Suite
    ) -> None:
        with db_engine.begin() as connection:
            machines.get_or_create(
                connection, submitted_machine(tracked=False, hardware="x86_64", core_count=8)
            )

        row = stored(db_engine, suite, "machine", "name", "linux")
        assert (row.tracked, row.hardware, row.core_count) == (False, "x86_64", 8)

    def test_a_matching_value_is_accepted(
        self, db_engine: Engine, machines: Machines, suite: Suite
    ) -> None:
        with db_engine.begin() as connection:
            first = machines.get_or_create(connection, submitted_machine(hardware="x86_64"))
            second = machines.get_or_create(connection, submitted_machine(hardware="x86_64"))

        assert first == second
        assert stored(db_engine, suite, "machine", "name", "linux").hardware == "x86_64"

    def test_a_stored_null_is_filled_in(
        self, db_engine: Engine, machines: Machines, suite: Suite
    ) -> None:
        # D7: a key the record has no value for is set rather than being a contradiction. This is
        # how a producer that starts sending a newly declared field populates the existing rows.
        with db_engine.begin() as connection:
            machines.get_or_create(connection, submitted_machine(hardware="x86_64"))
            machines.get_or_create(connection, submitted_machine(core_count=8))

        row = stored(db_engine, suite, "machine", "name", "linux")
        assert (row.hardware, row.core_count) == ("x86_64", 8)

    def test_a_contradicted_field_is_a_conflict(
        self, db_engine: Engine, machines: Machines, suite: Suite
    ) -> None:
        with db_engine.begin() as connection:
            machines.get_or_create(connection, submitted_machine(hardware="x86_64"))
        with db_engine.begin() as connection, pytest.raises(ApiError) as failure:
            machines.get_or_create(connection, submitted_machine(hardware="aarch64"))

        # R4's generic `conflict`: the request contradicts existing state in a way none of the more
        # specific 409 codes describes.
        assert failure.value.code is ErrorCode.CONFLICT
        # The message names the field and both values, so a submitter can fix its configuration
        # without reading the database.
        assert "hardware" in failure.value.message
        assert "x86_64" in failure.value.message
        assert "aarch64" in failure.value.message
        assert stored(db_engine, suite, "machine", "name", "linux").hardware == "x86_64"

    def test_a_key_the_submission_omits_is_never_compared(
        self, db_engine: Engine, machines: Machines, suite: Suite
    ) -> None:
        with db_engine.begin() as connection:
            machines.get_or_create(connection, submitted_machine(hardware="x86_64"))
            machines.get_or_create(connection, submitted_machine())

        assert stored(db_engine, suite, "machine", "name", "linux").hardware == "x86_64"

    def test_tracked_is_first_write_wins(
        self, db_engine: Engine, machines: Machines, suite: Suite
    ) -> None:
        # D6 and D7 exclude `tracked` from the match entirely: it is a policy flag operators are
        # expected to change, so a submission that disagrees is ignored rather than refused.
        with db_engine.begin() as connection:
            machines.get_or_create(connection, submitted_machine(tracked=False))
            machines.get_or_create(connection, submitted_machine(tracked=True))

        assert stored(db_engine, suite, "machine", "name", "linux").tracked is False


class TestCommitReconciliation:
    def test_creates_the_commit_with_what_the_submission_sent(
        self, db_engine: Engine, commits: Commits, suite: Suite
    ) -> None:
        with db_engine.begin() as connection:
            commits.get_or_create(connection, submitted_commit(ordinal=3, author="Jane"))

        row = stored(db_engine, suite, "commit", "commit", "abc")
        assert (row.ordinal, row.author) == (3, "Jane")

    def test_a_stored_null_ordinal_is_set(
        self, db_engine: Engine, commits: Commits, suite: Suite
    ) -> None:
        with db_engine.begin() as connection:
            commits.get_or_create(connection, submitted_commit())
            commits.get_or_create(connection, submitted_commit(ordinal=3))

        assert stored(db_engine, suite, "commit", "commit", "abc").ordinal == 3

    def test_a_matching_ordinal_is_left_alone(
        self, db_engine: Engine, commits: Commits, suite: Suite
    ) -> None:
        with db_engine.begin() as connection:
            first = commits.get_or_create(connection, submitted_commit(ordinal=3))
            second = commits.get_or_create(connection, submitted_commit(ordinal=3))

        assert first == second
        assert stored(db_engine, suite, "commit", "commit", "abc").ordinal == 3

    def test_a_contradicted_ordinal_is_an_ordinal_conflict(
        self, db_engine: Engine, commits: Commits, suite: Suite
    ) -> None:
        with db_engine.begin() as connection:
            commits.get_or_create(connection, submitted_commit(ordinal=3))
        with db_engine.begin() as connection, pytest.raises(ApiError) as failure:
            commits.get_or_create(connection, submitted_commit(ordinal=4))

        # R4 splits this out from `conflict` deliberately: the client's view of the commit order is
        # wrong, and retrying cannot help.
        assert failure.value.code is ErrorCode.ORDINAL_CONFLICT
        assert "3" in failure.value.message
        assert "4" in failure.value.message
        assert stored(db_engine, suite, "commit", "commit", "abc").ordinal == 3

    def test_an_omitted_ordinal_never_contradicts(
        self, db_engine: Engine, commits: Commits, suite: Suite
    ) -> None:
        with db_engine.begin() as connection:
            commits.get_or_create(connection, submitted_commit(ordinal=3))
            commits.get_or_create(connection, submitted_commit())

        assert stored(db_engine, suite, "commit", "commit", "abc").ordinal == 3

    def test_a_contradicted_field_is_a_plain_conflict(
        self, db_engine: Engine, commits: Commits
    ) -> None:
        with db_engine.begin() as connection:
            commits.get_or_create(connection, submitted_commit(author="Jane"))
        with db_engine.begin() as connection, pytest.raises(ApiError) as failure:
            commits.get_or_create(connection, submitted_commit(author="John"))

        assert failure.value.code is ErrorCode.CONFLICT

    def test_fields_and_the_ordinal_are_filled_in_together(
        self, db_engine: Engine, commits: Commits, suite: Suite
    ) -> None:
        with db_engine.begin() as connection:
            commits.get_or_create(connection, submitted_commit(author="Jane"))
            commits.get_or_create(
                connection, submitted_commit(ordinal=3, author="Jane", commit_message="Fix it")
            )

        row = stored(db_engine, suite, "commit", "commit", "abc")
        assert (row.ordinal, row.author, row.commit_message) == (3, "Jane", "Fix it")


class TestConcurrentFill:
    """D7's "never overwritten", under the race that is the only way to violate it.

    Filling in a stored NULL is the one thing a submission does to a row it did not create, and
    under READ COMMITTED two submissions can both read that NULL before either of them writes. If
    the fill trusts that read, the second one waits on the first's row lock and then overwrites a
    value it never compared against -- D7's rule holding *usually* rather than always, silently,
    and with no constraint to catch it: the unique index on `ordinal` sees a *different* commit
    taking an ordinal, not two submissions handing *this* commit two of them.

    Staged exactly as the insert races above are, with the winner holding its transaction open
    until the loser is demonstrably blocked behind it, so both sides are guaranteed to have read
    the NULL.
    """

    @pytest.fixture
    def existing_machine(self, db_engine: Engine, machines: Machines) -> None:
        """A machine whose `hardware` nobody has filled in yet, committed so both racers see it."""
        with db_engine.begin() as connection:
            machines.get_or_create(connection, submitted_machine())

    @pytest.fixture
    def existing_commit(self, db_engine: Engine, commits: Commits) -> None:
        """A commit with no ordinal, likewise."""
        with db_engine.begin() as connection:
            commits.get_or_create(connection, submitted_commit())

    @pytest.mark.usefixtures("existing_machine")
    def test_the_loser_of_a_field_fill_is_refused_rather_than_overwriting(
        self,
        db_engine: Engine,
        machines: Machines,
        suite: Suite,
        background: Callable[..., Future[Any]],
    ) -> None:
        running = raced(
            db_engine,
            background,
            lambda connection: machines.get_or_create(
                connection, submitted_machine(hardware="x86_64")
            ),
            lambda connection: machines.get_or_create(
                connection, submitted_machine(hardware="aarch64")
            ),
        )

        with pytest.raises(ApiError) as failure:
            running.result(timeout=BLOCK_TIMEOUT)

        # One value stored, and the submission that disagrees with it told so -- which is the same
        # answer D7 gives when the value was stored an hour earlier rather than a millisecond.
        assert failure.value.code is ErrorCode.CONFLICT
        assert stored(db_engine, suite, "machine", "name", "linux").hardware == "x86_64"

    @pytest.mark.usefixtures("existing_commit")
    def test_the_loser_of_an_ordinal_fill_is_refused_rather_than_overwriting(
        self,
        db_engine: Engine,
        commits: Commits,
        suite: Suite,
        background: Callable[..., Future[Any]],
    ) -> None:
        # D11: PATCH is the only way to move a commit once its ordinal is set, and "set" includes
        # set a millisecond ago by a submission that has only just committed.
        running = raced(
            db_engine,
            background,
            lambda connection: commits.get_or_create(connection, submitted_commit(ordinal=3)),
            lambda connection: commits.get_or_create(connection, submitted_commit(ordinal=4)),
        )

        with pytest.raises(ApiError) as failure:
            running.result(timeout=BLOCK_TIMEOUT)

        assert failure.value.code is ErrorCode.ORDINAL_CONFLICT
        assert stored(db_engine, suite, "commit", "commit", "abc").ordinal == 3

    @pytest.mark.usefixtures("existing_machine")
    def test_two_submissions_filling_in_the_same_value_both_succeed(
        self,
        db_engine: Engine,
        machines: Machines,
        suite: Suite,
        background: Callable[..., Future[Any]],
    ) -> None:
        # The other side of the rule, and what keeps the lock from turning a fleet of identically
        # configured submitters into a conflict storm: the loser re-reads under the lock, finds the
        # value it was going to write already there, and has nothing left to do.
        running = raced(
            db_engine,
            background,
            lambda connection: machines.get_or_create(
                connection, submitted_machine(hardware="x86_64")
            ),
            lambda connection: machines.get_or_create(
                connection, submitted_machine(hardware="x86_64")
            ),
        )

        assert running.result(timeout=BLOCK_TIMEOUT) > 0
        assert stored(db_engine, suite, "machine", "name", "linux").hardware == "x86_64"

    @pytest.mark.usefixtures("existing_machine")
    def test_a_submission_with_nothing_to_fill_takes_no_lock(
        self, db_engine: Engine, machines: Machines
    ) -> None:
        # The hot path, which is the overwhelmingly common one: a submission re-sending metadata
        # that is already stored reconciles to nothing and must not serialize against anything.
        # Asserted by the statement it does *not* send, since a superfluous lock is invisible in
        # the rows and only shows up as contention under load.
        with db_engine.begin() as connection:
            machines.get_or_create(connection, submitted_machine(hardware="x86_64"))
        with (
            db_engine.begin() as connection,
            counting_statements("FOR UPDATE") as locking,
        ):
            machines.get_or_create(connection, submitted_machine(hardware="x86_64"))
            machines.get_or_create(connection, submitted_machine())

        assert locking == []


class TestTransactionBoundaries:
    def test_the_caller_owns_the_transaction(
        self, db_engine: Engine, machines: Machines, suite: Suite
    ) -> None:
        # Nothing here commits on its own: a run submission is atomic from the API user's
        # perspective (D13), so a machine created on the way to a failure must not survive it.
        with db_engine.connect() as connection, connection.begin():
            machines.get_or_create(connection, submitted_machine())
            connection.rollback()

        assert counted(db_engine, suite.tables, "machine") == 0

    def test_a_row_written_earlier_in_the_transaction_is_found(
        self, db_engine: Engine, machines: Machines, suite: Suite
    ) -> None:
        # The get-or-create reads through its own transaction, so a machine inserted by hand a
        # moment earlier is found rather than raced against.
        with db_engine.begin() as connection:
            existing = connection.execute(
                insert(suite.tables.machine)
                .values(name="linux", hardware="x86_64")
                .returning(suite.tables.machine.c.id)
            ).scalar_one()

            assert machines.get_or_create(connection, submitted_machine()) == existing


def test_a_failed_get_or_create_leaves_the_connection_usable(
    db_engine: Engine, commits: Commits, machines: Machines, suite: Suite
) -> None:
    """A 409 is an application answer, not a broken transaction -- but the caller still rolls back.

    What this pins is that the savepoint machinery does not leave the connection in a state where
    the rollback itself fails, which is how a badly nested savepoint shows up.
    """
    with db_engine.connect() as connection:
        with connection.begin():
            machines.get_or_create(connection, submitted_machine())
            commits.get_or_create(connection, submitted_commit("first", ordinal=5))
            with pytest.raises(ApiError):
                commits.get_or_create(connection, submitted_commit("second", ordinal=5))
            connection.rollback()

        with connection.begin():
            assert machines.get_or_create(connection, submitted_machine()) > 0

    assert counted(db_engine, suite.tables, "commit") == 0

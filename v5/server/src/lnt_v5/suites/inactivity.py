"""Deleting the machines and commits that have been inactive for longer than they asked (O10).

A machine or a commit with `delete_after_inactive_days` set is due once its last activity -- its
latest run's `submitted_at`, or its `first_seen_at` if it has no run -- is more than that many days
old. A commit with an ordinal never is. `sweep` finds the due entities of every suite and deletes
them, one transaction each, exactly as their `DELETE` routes do: the foreign keys D5 declares take
the runs, samples, profiles and regression indicators with them.

The server sweeps periodically from a background thread (`InactivitySweeper`), and an operator can
sweep once with `lnt-v5 server sweep`. Both go through `sweep`, which takes an advisory lock so that
only one process sweeps at a time, and skips the round if another process holds it.
"""

from __future__ import annotations

import logging
import threading
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any

from sqlalchemy import (
    Column,
    ColumnElement,
    Connection,
    Engine,
    Interval,
    Table,
    and_,
    delete,
    exists,
    func,
    literal_column,
    select,
    text,
    true,
)
from sqlalchemy.exc import SQLAlchemyError

from lnt_v5.suites.registry import Suite, SuiteRegistry

logger = logging.getLogger(__name__)

# An arbitrary but fixed key for the advisory lock that keeps sweeps from overlapping, spelling
# "LNTS". Distinct from `migrate.MIGRATION_LOCK_KEY`, so that a sweep and a migration never wait for
# each other's lock.
SWEEP_LOCK_KEY = 0x4C4E5453

# How long after starting a server sweeps for the first time: soon, so that a deployment restarting
# more often than the sweep interval still sweeps (O10), but not at once, to keep the work out of
# the way of a server that has just started taking traffic.
FIRST_ROUND_DELAY = 60.0

# How long shutting down waits for a round in progress to stop. A round stops between two entities,
# so it may take longer while it deletes one with a long history; the thread is a daemon, so it does
# not hold the process up, and the transaction it leaves open is rolled back with its connection.
_STOP_TIMEOUT = 5.0

_ONE_DAY = literal_column("INTERVAL '1 day'", Interval)


@dataclass(frozen=True)
class SweptSuite:
    """What one round deleted from one suite, and how many of its steps failed.

    `deleted` holds the identities of what was deleted, keyed by kind: `machine` and `commit`. A
    failure is logged where it happens; the count is for a caller that reports the round as a whole,
    such as `lnt-v5 server sweep`.
    """

    suite: str
    deleted: Mapping[str, tuple[str, ...]]
    failures: int


@dataclass(frozen=True)
class _Kind:
    """One of the two tables a round sweeps, and what differs between them."""

    noun: str
    table: Table
    # What the logs and the result name an entity by.
    identity: Column[Any]
    # The column of `{suite}.run` that refers to this table.
    runs: Column[Any]
    # What else an entity of this kind must satisfy to be deleted at all.
    eligible: ColumnElement[bool]

    def due(self) -> ColumnElement[bool]:
        """Whether a row is due for deletion now (O10).

        "Inactive for more than N days" is "first seen before the cutoff, and no run submitted
        since", which is the later of the two being before it. Each part is bounded: a commit is
        found through the partial index on the setting (a suite has few machines), and a machine's
        runs are probed through the index on `run(machine_id, submitted_at)`. A commit's runs are
        found through the index on `run.commit_id`, and are few: about one per machine.
        """
        days = self.table.c.delete_after_inactive_days
        cutoff = func.now() - days * _ONE_DAY
        run = self.runs.table
        return and_(
            self.eligible,
            days.is_not(None),
            self.table.c.first_seen_at < cutoff,
            ~exists().where(self.runs == self.table.c.id, run.c.submitted_at >= cutoff),
        )


def _kinds(suite: Suite) -> tuple[_Kind, _Kind]:
    machine, commit, run = suite.tables.machine, suite.tables.commit, suite.tables.run
    return (
        _Kind("machine", machine, machine.c.name, run.c.machine_id, eligible=true()),
        # An ordered commit is part of the suite's history, and is never deleted this way.
        _Kind(
            "commit", commit, commit.c.commit, run.c.commit_id, eligible=commit.c.ordinal.is_(None)
        ),
    )


def sweep(
    engine: Engine, registry: SuiteRegistry, stopping: threading.Event | None = None
) -> list[SweptSuite] | None:
    """Delete every due machine and commit of every suite, and say what was deleted (O10).

    Returns None without doing anything if another process is sweeping. Once `stopping` is set, the
    round stops before its next statement, and reports what it had deleted so far.

    The lock is held by the session rather than a transaction, because the round spans many
    transactions on the same connection: one to find each suite's due entities, and one per entity
    to delete it.
    """
    with engine.connect() as connection:
        locked = connection.execute(
            text("SELECT pg_try_advisory_lock(:key)"), {"key": SWEEP_LOCK_KEY}
        ).scalar_one()
        connection.commit()
        if not locked:
            return None
        try:
            with connection.begin():
                suites = list(registry.fresh(connection).values())
            swept = []
            for suite in suites:
                if _stopping(stopping):
                    break
                swept.append(_sweep_suite(connection, suite, stopping))
            return swept
        finally:
            _unlock(connection)


def _unlock(connection: Connection) -> None:
    """Release the sweep lock, or make sure the connection holding it is never used again.

    The lock belongs to the session, and the connection goes back to the pool afterwards: if the
    unlock failed and the connection were reused, every later round in every process would find the
    lock taken and skip, for as long as the connection lived.
    """
    try:
        # Roll back any transaction a failure left open, since the unlock can't run inside it.
        connection.rollback()
        connection.execute(text("SELECT pg_advisory_unlock(:key)"), {"key": SWEEP_LOCK_KEY})
        connection.commit()
    except SQLAlchemyError:
        connection.invalidate()
        raise


def _sweep_suite(
    connection: Connection, suite: Suite, stopping: threading.Event | None
) -> SweptSuite:
    deleted: dict[str, tuple[str, ...]] = {}
    failures = 0
    for kind in _kinds(suite):
        deleted[kind.noun] = ()
        if _stopping(stopping):
            continue
        due = _due_entities(connection, suite, kind)
        if due is None:
            failures += 1
            continue
        for identifier, identity in due:
            if _stopping(stopping):
                break
            outcome = _delete_if_due(connection, suite, kind, identifier, identity)
            if outcome is None:
                failures += 1
            elif outcome:
                deleted[kind.noun] += (identity,)
    return SweptSuite(suite=suite.schema.name, deleted=deleted, failures=failures)


def _stopping(stopping: threading.Event | None) -> bool:
    return stopping is not None and stopping.is_set()


def _due_entities(
    connection: Connection, suite: Suite, kind: _Kind
) -> Sequence[tuple[int, str]] | None:
    """The id and identity of every entity of this kind that is due, or None if they can't be read.

    A failure here -- the suite deleted since the round started, say -- is logged rather than
    raised, so that it does not stop the round from sweeping the other suites (O10).
    """
    try:
        with connection.begin():
            rows = connection.execute(
                select(kind.table.c.id, kind.identity).where(kind.due())
            ).all()
    except SQLAlchemyError:
        logger.warning(
            "Could not look for inactive %ss to delete in test suite '%s'; will retry next round",
            kind.noun,
            suite.schema.name,
            exc_info=True,
        )
        return None
    return [(identifier, identity) for identifier, identity in rows]


def _delete_if_due(
    connection: Connection, suite: Suite, kind: _Kind, identifier: int, identity: str
) -> bool | None:
    """Delete one entity if it is still due, in a transaction of its own.

    Returns whether it was deleted, or None if that failed. The entity is addressed by id rather
    than by its identity, which a PATCH may have changed since: a machine can be renamed.

    The row is locked first, and then deleted only if it is still due, and the two are separate
    statements on purpose. The lock conflicts with the key-share lock a run insert takes on its
    machine and commit through the foreign keys, so it waits for every run being inserted for the
    entity to be committed or rolled back. Under READ COMMITTED (see db.py), the next statement then
    sees those runs. A check inside the locking statement would not: PostgreSQL re-evaluates a
    locked row's own columns after the wait, but the subquery on the runs would still use the
    statement's original snapshot.

    A failure is logged rather than raised, like a failure to find the due entities.
    """
    table = kind.table
    try:
        with connection.begin():
            connection.execute(select(table.c.id).where(table.c.id == identifier).with_for_update())
            # Nothing to delete if someone else already has, or if the entity is no longer due.
            removed = connection.execute(delete(table).where(table.c.id == identifier, kind.due()))
            if removed.rowcount == 0:
                return False
    except SQLAlchemyError:
        logger.warning(
            "Could not delete inactive %s '%s' from test suite '%s'; will retry next round",
            kind.noun,
            identity,
            suite.schema.name,
            exc_info=True,
        )
        return None
    logger.info(
        "Deleted %s '%s' from test suite '%s' after it was inactive for longer than it asked",
        kind.noun,
        identity,
        suite.schema.name,
    )
    return True


class InactivitySweeper:
    """The server's periodic sweep (O10): a background thread that sweeps every `interval` seconds.

    A thread rather than an asyncio task, because a round is blocking database work like any
    request, and the endpoints run in threads for the same reason. Each worker process has one; the
    advisory lock in `sweep` keeps them from sweeping at the same time.
    """

    def __init__(
        self,
        engine: Engine,
        registry: SuiteRegistry,
        interval: float,
        *,
        first_round_delay: float = FIRST_ROUND_DELAY,
    ) -> None:
        self._engine = engine
        self._registry = registry
        self._interval = interval
        self._first_round_delay = first_round_delay
        self._stopping = threading.Event()
        self._thread = threading.Thread(target=self._run, name="inactivity-sweeper", daemon=True)

    def start(self) -> None:
        self._thread.start()

    def stop(self) -> None:
        self._stopping.set()
        self._thread.join(_STOP_TIMEOUT)

    def _run(self) -> None:
        delay = self._first_round_delay
        while not self._stopping.wait(delay):
            delay = self._interval
            try:
                sweep(self._engine, self._registry, self._stopping)
            except Exception:
                # Whatever went wrong, the next round tries again: a sweep must never stop the
                # server from serving (O10), and an exception escaping here would end the thread.
                logger.exception("Sweeping inactive machines and commits failed")

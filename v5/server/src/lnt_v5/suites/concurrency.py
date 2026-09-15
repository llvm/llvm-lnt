"""D13's get-or-create: the row a submission needs, whether or not it is already there.

A run submission names a machine, a commit and a set of tests, and each of them is created on
demand. Two submissions naming the same one race, and the loser's INSERT hits a unique constraint.
D13's answer is neither a lock taken up front nor a retry the client has to make: the INSERT runs
inside a SAVEPOINT, so the loser rolls back that one statement -- keeping everything it wrote
earlier in the same transaction -- and re-reads the row the winner created. That is the whole
protocol, and it is the only thing this module knows.

Two entry points, because D13 asks for two shapes. `get_or_create` resolves one row by its natural
key, and is what `entities.create_or_reconcile` -- and through it the machine and commit readers --
builds on. `resolve_names` resolves a whole set of test names in a fixed number of round trips,
which is what keeps a submission carrying tens of thousands of tests from costing tens of thousands
of statements.

Deliberately ignorant of what a machine or a commit is: which table, which constraint, and the
wording of each 409 all live with the entity (see `routes/machines.py` and `routes/commits.py`), and
D7's reconciliation on top of this lives in `entities.py` -- so that each is stated once rather than
once per write path. What lives here is what those two -- and the tests -- would otherwise each get
subtly wrong.
"""

from __future__ import annotations

from collections.abc import Collection, Mapping, Sequence
from dataclasses import dataclass
from typing import Any

from sqlalchemy import (
    Column,
    Connection,
    Row,
    String,
    Table,
    any_,
    bindparam,
    func,
    insert,
    select,
)
from sqlalchemy.dialects.postgresql import ARRAY
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.exc import IntegrityError
from sqlalchemy.sql.elements import BindParameter

from lnt_v5.db import unique_violation_constraint


@dataclass(frozen=True)
class Resolved:
    """What a get-or-create settled on: the row's id, the columns asked for, and who created it.

    `created` is the half D7 needs. A row this transaction just wrote holds exactly what was
    submitted and has nothing to reconcile; one that was already there may contradict it, and only
    then does the submitted metadata have to be matched against what is stored.

    `stored` is keyed by column name, which is what the caller already has: the names come from the
    submission, and handing back a row to be indexed by column object would make every caller
    rebuild the mapping it just passed in.
    """

    identifier: int
    stored: Mapping[str, Any]
    created: bool


def get_or_create(
    connection: Connection,
    key: Column[Any],
    value: Any,
    *,
    constraint: str,
    values: Mapping[str, Any],
    read: Collection[str],
) -> Resolved:
    """The row a natural key names, created from `values` if it is not there yet (D13).

    `key` and `value` are both the row's identity and the way it is read back, so the row this
    looks up and the row it inserts cannot drift apart; `values` is everything else the new row
    carries, and `read` names the columns the caller wants back beside the id, from whichever of
    the two paths produced the row. For a table shaped like `{suite}.machine` or `{suite}.commit`
    (see D5): a surrogate `id` and a unique natural key.

    `constraint` is the name of the unique constraint on `key`, and the narrowness of the recovery
    is the point. A lost race trips *that* constraint and nothing else, so anything else has to be
    re-raised: a commit insert can equally trip `uq_commit_ordinal`, which is not a lost race at all
    but an ordinal another commit already holds, and swallowing it would re-query, find the commit
    it just failed to create absent, and report the wrong thing -- where R4 wants
    `ordinal_conflict`. `unique_violation_constraint` is what tells the two apart.

    The caller owns the transaction. Only the INSERT is wrapped in a savepoint, so a submission
    that has already created its machine keeps it when it loses the race for its commit.
    """
    table = key.table
    # By column object rather than by name: the id and a declared field are selected side by side,
    # and `Row._mapping` keyed by column cannot confuse the two whatever the field is called.
    wanted = [table.c[name] for name in read]
    query = select(table.c.id, *wanted).where(key == value)

    def resolved(row: Row[Any], *, created: bool) -> Resolved:
        return Resolved(
            identifier=int(row._mapping[table.c.id]),
            stored={column.name: row._mapping[column] for column in wanted},
            created=created,
        )

    row = connection.execute(query).one_or_none()
    if row is not None:
        return resolved(row, created=False)

    try:
        with connection.begin_nested():
            inserted = connection.execute(
                insert(table).values({key.name: value, **values}).returning(table.c.id, *wanted)
            ).one()
    except IntegrityError as error:
        if unique_violation_constraint(error) != constraint:
            raise
    else:
        return resolved(inserted, created=True)

    # The savepoint is gone and everything before it survives, so the winner's row is simply read.
    # READ COMMITTED (see db.py) is what makes this work: the statement takes a fresh snapshot, and
    # the transaction that beat us to the INSERT has necessarily committed by now -- had it rolled
    # back instead, our INSERT would have proceeded rather than failed. `one` rather than
    # `one_or_none`: nothing but a concurrent DELETE of the row we were told already exists can get
    # here, which is a fault rather than something to paper over.
    return resolved(connection.execute(query).one(), created=False)


def resolve_names(connection: Connection, table: Table, names: Collection[str]) -> dict[str, int]:
    """The id of every named row, creating the ones that are not there yet (D13).

    For a table shaped like `{suite}.test` (see D5): a surrogate `id` and a unique `name`. D13
    requires every test name in a submission to be resolved in O(1) database round trips whatever
    the count, with the same concurrency guarantee as the single-row path above, and that is what
    this is -- three statements at worst, one when every name is already there, and never a number
    that grows with the set.

    Concurrency is handled by `ON CONFLICT DO NOTHING` plus the re-SELECT underneath it rather than
    by a savepoint: the insert cannot fail, but it also does not report the rows a concurrent
    transaction won, since `RETURNING` covers only the rows the statement itself wrote. Reading the
    still-missing names back afterwards is what picks up the winner's ids.
    """
    wanted = sorted(set(names))
    if not wanted:
        return {}

    resolved = _existing(connection, table, wanted)
    missing = [name for name in wanted if name not in resolved]
    if not missing:
        return resolved

    # `missing` is sorted, and the statement below inserts in that order, which is what keeps two
    # concurrent submissions with overlapping test sets from deadlocking. An `INSERT ... ON
    # CONFLICT` takes a speculative insertion lock on each row before writing it and waits there if
    # another transaction is inserting the same one; two submitters writing {a, b} in opposite
    # orders would each end up holding what the other waits for, and PostgreSQL would kill one of
    # them -- a 500 on a request that did nothing wrong. Every submitter taking the same order makes
    # that cycle impossible. The ORDER BY restates what the sorted array already gives, so that the
    # requirement is in the statement rather than only in the Python that built its parameter.
    unnested = func.unnest(_array(missing)).column_valued("name")
    connection.execute(
        pg_insert(table)
        .from_select(["name"], select(unnested).order_by(unnested))
        # By column rather than by constraint name: PostgreSQL infers the unique index from the
        # column, so nothing here has to be kept in step with the naming convention. Named at all,
        # rather than left bare, so that this can only ever skip a repeated name.
        .on_conflict_do_nothing(index_elements=[table.c.name])
    )

    resolved |= _existing(connection, table, missing)
    unresolved = [name for name in missing if name not in resolved]
    if unresolved:
        # Nothing deletes a test (D5), so a name that was absent before the insert, was not written
        # by it, and is still absent after it says something is wrong with the table rather than
        # with the request. Loud, because the alternative -- returning what did resolve -- would
        # write a run's samples against the wrong tests, or against none.
        raise RuntimeError(
            f"{table.fullname} did not resolve {len(unresolved)} name(s) after inserting them: "
            f"{', '.join(unresolved[:10])}"
        )
    return resolved


def _existing(connection: Connection, table: Table, names: Sequence[str]) -> dict[str, int]:
    """The id of each of these names that the table already holds."""
    rows = connection.execute(
        select(table.c.id, table.c.name).where(table.c.name == any_(_array(names)))
    ).all()
    return {row.name: int(row.id) for row in rows}


def _array(names: Sequence[str]) -> BindParameter[Any]:
    """Every name as a single array parameter, rather than one parameter per name.

    This is what makes the claim of O(1) round trips true rather than aspirational. A statement
    binding one parameter per name stops working at PostgreSQL's limit of 65535 of them, which a
    suite with tens of thousands of tests reaches, and the usual answer -- chunking -- is a loop
    over round trips wearing a different hat. One array parameter has no such ceiling, so
    `= ANY(:names)` and `unnest(:names)` cover any set in one statement each.
    """
    return bindparam("names", value=list(names), type_=ARRAY(String))

"""Checking a new order that a request gives for a list (I3).

A request can reorder a list by naming its members in their new order: the entries of a schema's
lists (D2), the projects (E13) and the suites of a project (E10). Each such order must name every
member exactly once.
"""

from __future__ import annotations

from collections import Counter
from collections.abc import Sequence

from lnt_v5.errors import ApiError, ErrorCode


def check_order(names: Sequence[str], order: Sequence[str], rule: str) -> None:
    """Refuse `order` with a 400 unless it names each of `names` exactly once.

    The message starts with `rule`, which says what the order must name. It then names the
    problems: the members the order leaves out, in the order of `names`, the names that are not
    members, and the names it repeats. An order from a client that missed a change made meanwhile is
    the likeliest mistake, and the names show the client what changed.
    """
    # Counted once, and looked up rather than searched: the request decides how long it is.
    counts = Counter(order)
    members = set(names)
    problems = []
    if missing := [name for name in names if name not in counts]:
        problems.append(f"leaves out {_quoted(missing)}")
    if unknown := [name for name in counts if name not in members]:
        verb = "is" if len(unknown) == 1 else "are"
        problems.append(f"names {_quoted(unknown)}, which {verb} not among them")
    if repeated := [name for name, count in counts.items() if count > 1]:
        problems.append(f"names {_quoted(repeated)} more than once")
    if problems:
        raise ApiError(ErrorCode.INVALID_REQUEST, f"{rule}, but it {'; it '.join(problems)}.")


def _quoted(names: list[str]) -> str:
    return ", ".join(f"'{name}'" for name in names)

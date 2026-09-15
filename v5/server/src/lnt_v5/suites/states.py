"""The states a regression can be in (D5).

In a module of its own for the reason `scopes.py` gives for the same shape: two layers need it and
neither should have to import the other. The database layer constrains the stored value with a
check constraint, and the regression endpoints translate between the stored integer and the string
the API speaks -- and a route that only needs to render a state should not have to import the
per-suite DDL builder to get at it.

Unlike the rest of `suites/`, this is fixed by code rather than by a suite's schema: the five states
are the same in every suite.
"""

from __future__ import annotations

from enum import IntEnum


class RegressionState(IntEnum):
    """The states D5 stores in `{suite}.regression.state`, by their stored value.

    Stored as an integer and exposed as a string (endpoints.md, Regressions). Unlike an API key's
    scope, which D5 keeps as text because it is read once per request and never filtered on, this
    column is indexed and filtered on by `?state=`.
    """

    DETECTED = 0
    ACTIVE = 1
    NOT_TO_BE_FIXED = 2
    FIXED = 3
    FALSE_POSITIVE = 4

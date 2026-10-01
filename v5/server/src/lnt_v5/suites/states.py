"""The states a regression can be in (D5), in both of the spellings the system uses.

In a module of its own for the reason `scopes.py` gives for the same shape: two layers need it and
neither should have to import the other. The database layer constrains the stored value with a
check constraint, and the regression endpoints speak the string -- and a route that only needs to
render a state should not have to import the per-suite DDL builder to get at it. The translation
between the two lives here rather than at either end, so that neither end can invent a third
spelling.

Unlike the rest of `suites/`, this is fixed by code rather than by a suite's schema: the five states
are the same in every suite.
"""

from __future__ import annotations

from enum import IntEnum, StrEnum, auto


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


class RegressionStateName(StrEnum):
    """The same five states, as endpoints.md has the API speak them.

    A second enum rather than a property on the first, because this is the type a request body and
    a response field are validated against: pydantic renders it as one named string enum in R8's
    document, so every endpoint that carries a state refers to the same component, and a value that
    is not one of the five is R4's 400 naming those that are.

    `auto()` gives each member the lowercase of its own name, so only the names are written twice,
    and the two enums are paired *by name* below -- which is what makes a member added to one and
    forgotten in the other a failure rather than a state the API can never speak.
    """

    DETECTED = auto()
    ACTIVE = auto()
    NOT_TO_BE_FIXED = auto()
    FIXED = auto()
    FALSE_POSITIVE = auto()

    @property
    def stored(self) -> int:
        """The integer D5 stores for this state."""
        return RegressionState[self.name].value

    @classmethod
    def of(cls, stored: int) -> RegressionStateName:
        """The name the API speaks for a state read out of the database."""
        return cls[RegressionState(stored).name]

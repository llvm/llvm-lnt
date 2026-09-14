"""The authorization scopes (R5)."""

from __future__ import annotations

from enum import StrEnum


class Scope(StrEnum):
    """What an API key is allowed to do; see R5 for what each one covers.

    Declared lowest privilege first, because the declaration order *is* R5's hierarchy and
    :meth:`grants` reads it. This lives in its own module because both the database layer, which
    constrains the stored value, and the authentication layer, which compares a key's scope
    against an endpoint's requirement, need it, and neither should have to import the other.
    """

    READ = "read"
    SUBMIT = "submit"
    TRIAGE = "triage"
    MANAGE = "manage"
    ADMIN = "admin"

    def grants(self, required: Scope) -> bool:
        """Whether a key holding this scope satisfies an endpoint requiring `required`.

        A key grants its own scope plus every lower one (R5). That is a comparison of position in
        the declaration order, deliberately not the `<` that `StrEnum` inherits from `str`, which
        compares alphabetically and would decide that `read` outranks `manage`.
        """
        return _RANK[self] >= _RANK[required]


# Built once, since every authenticated request consults it (R5).
_RANK = {scope: rank for rank, scope in enumerate(Scope)}

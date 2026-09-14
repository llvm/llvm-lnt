"""The authorization scopes (R5)."""

from __future__ import annotations

from enum import StrEnum


# In its own module because both the database layer, which constrains the stored value, and the
# authentication layer, which compares a key's scope against an endpoint's requirement, need it,
# and neither should have to import the other.
#
# The class docstring is published: it is this enum's description in the OpenAPI document.
class Scope(StrEnum):
    """What an API key is allowed to do.

    A key grants its own scope and every lower one: read < submit < triage < manage < admin.
    """

    # Lowest privilege first: the declaration order *is* the hierarchy, and `grants` reads it.
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

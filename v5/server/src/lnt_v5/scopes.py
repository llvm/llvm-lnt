"""The authorization scopes (I5)."""

from __future__ import annotations

from enum import StrEnum


# In its own module because both the database layer, which constrains the stored value, and the
# authentication layer, which compares a key's scope against an endpoint's requirement, need it,
# and neither should have to import the other.
#
# The class docstring is published: it is this enum's description in the OpenAPI document.
class Scope(StrEnum):
    """What an API key is allowed to do. Each scope includes the ones before it: read < submit <
    triage < manage < admin.

    - `read`: read all data. Doesn't need a key at all.
    - `submit`: submit runs and create commits.
    - `triage`: create, update and delete regressions and their indicators.
    - `manage`: create, update and delete machines; update and delete commits; delete runs; create,
      change and delete test suites.
    - `admin`: list, create and revoke API keys.

    A `submit`, `triage` or `manage` key can be restricted to some test suites. It then has its
    scope only in those suites, and only `read` everywhere else -- including for creating a test
    suite.
    """

    # Lowest privilege first: the declaration order *is* the hierarchy, and `grants` reads it.
    READ = "read"
    SUBMIT = "submit"
    TRIAGE = "triage"
    MANAGE = "manage"
    ADMIN = "admin"

    def grants(self, required: Scope) -> bool:
        """Whether a key holding this scope satisfies an endpoint requiring `required`.

        A key grants its own scope plus every lower one (I5). That is a comparison of position in
        the declaration order, deliberately not the `<` that `StrEnum` inherits from `str`, which
        compares alphabetically and would decide that `read` outranks `manage`.
        """
        return _RANK[self] >= _RANK[required]


# Built once, since every authenticated request consults it (I5).
_RANK = {scope: rank for rank, scope in enumerate(Scope)}


# I5: the scopes that a key restricted to some suites cannot have. A restricted `read` key would
# grant nothing beyond anonymous access, and the endpoints `admin` is for address no suite.
UNRESTRICTABLE_SCOPES = (Scope.READ, Scope.ADMIN)

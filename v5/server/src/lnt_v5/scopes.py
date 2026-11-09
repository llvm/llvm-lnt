"""The authorization scopes (I5)."""

from __future__ import annotations

from enum import StrEnum


# In its own module, with `KeyScope`, because both the database layer, which constrains a key's
# stored scope, and the authentication layer, which compares it against an endpoint's requirement,
# need them, and neither should have to import the other.
class Scope(StrEnum):
    """The scope an endpoint requires (I5). Each scope includes the ones before it.

    `read` needs no key: see `KeyScope` for the scopes a key can have.
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


# The class docstring is published: it is this enum's description in the OpenAPI document.
class KeyScope(StrEnum):
    """What an API key is allowed to do. Each scope includes the ones before it, submit < triage <
    manage < admin, and reading, which needs no key at all.

    - `submit`: submit runs and create commits.
    - `triage`: create, update and delete regressions and their indicators.
    - `manage`: create, update and delete machines; update and delete commits; delete runs; create,
      rename, move, change, reorder and delete test suites; create, rename, change, reorder and
      delete projects.
    - `admin`: list, create, change and revoke API keys.

    A `submit`, `triage` or `manage` key can be restricted to some projects as a whole and some
    single test suites. It then has its scope only in the suites it covers, and can only read
    everywhere else. Creating a test suite in a project, moving one into it, reordering its test
    suites, or changing or deleting the project, needs a key covering that project as a whole.
    Creating a project, or reordering the projects, always needs an unrestricted key.
    """

    # I5: every scope but `read`, which needs no key.
    SUBMIT = Scope.SUBMIT.value
    TRIAGE = Scope.TRIAGE.value
    MANAGE = Scope.MANAGE.value
    ADMIN = Scope.ADMIN.value

    def grants(self, required: Scope) -> bool:
        """Whether a key holding this scope satisfies an endpoint requiring `required`."""
        return Scope(self.value).grants(required)


# I5: the scopes a restricted key can have. The endpoints `admin` is for address no project or
# suite.
RESTRICTABLE_SCOPES = (KeyScope.SUBMIT, KeyScope.TRIAGE, KeyScope.MANAGE)

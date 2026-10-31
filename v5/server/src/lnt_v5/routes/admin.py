"""Instance-level API key management (E11).

These are the only endpoints in the API that require `admin`, and the only GETs that
unauthenticated access never reaches.
"""

from __future__ import annotations

from datetime import datetime
from typing import Annotated, Any

from fastapi import APIRouter, Body, Path
from pydantic import BaseModel, ConfigDict, Field, model_validator
from pydantic.config import JsonDict

from lnt_v5 import examples, keys
from lnt_v5.auth import require_scope
from lnt_v5.db import EngineDep
from lnt_v5.errors import ApiError, ErrorCode, ErrorEnvelope
from lnt_v5.responses import Items
from lnt_v5.scopes import Scope
from lnt_v5.strings import Storable
from lnt_v5.suites.schema import SuiteNameStr
from lnt_v5.tables import KEY_NAME_MAX_LENGTH

router = APIRouter(
    prefix="/api/admin",
    tags=["Admin"],
    dependencies=[require_scope(Scope.ADMIN)],
)

# The docstrings of the models and endpoints below are published, as the descriptions I8's document
# gives them, so they are written for API users.


def _suite_is_never_null(schema: JsonDict) -> None:
    """Describe `suite` as the string it is when present, rather than as nullable: it is left out
    rather than null when there is none, and a null one is refused."""
    properties = schema.get("properties")
    suite = properties.get("suite") if isinstance(properties, dict) else None
    if isinstance(suite, dict) and isinstance(branches := suite.pop("anyOf", None), list):
        suite.pop("default", None)
        suite.update(next(b for b in branches if isinstance(b, dict) and b.get("type") != "null"))


class RestrictionEntry(BaseModel):
    """What a restricted API key is restricted to: a single test suite, named by its project's name
    and its own."""

    model_config = ConfigDict(
        extra="forbid",
        from_attributes=True,
        # As for a schema's entries: `suite` may be left out of a request, where it is refused for
        # now, and is in every response.
        json_schema_serialization_defaults_required=True,
        json_schema_extra=_suite_is_never_null,
    )

    project: SuiteNameStr = Field(
        description="The name of the project.", examples=[examples.PROJECT["name"]]
    )
    suite: SuiteNameStr | None = Field(
        default=None,
        description=(
            "The name of the test suite, in the project. A key is restricted to single test "
            "suites, so every entry names one."
        ),
        examples=[examples.SUITE],
    )

    @model_validator(mode="before")
    @classmethod
    def _reject_null_suite(cls, data: Any) -> Any:
        # E11: a whole project is written without `suite`, rather than with a null one.
        if isinstance(data, dict) and "suite" in data and data["suite"] is None:
            raise ValueError("'suite' must be the name of a test suite, not null")
        return data

    def entry(self) -> keys.Entry:
        return keys.Entry(self.project, self.suite)


class ApiKey(BaseModel):
    """An API key. The token itself is never shown."""

    model_config = ConfigDict(from_attributes=True)

    prefix: str = Field(
        description="The first 8 characters of the key's token. Use it to revoke the key.",
        examples=[examples.API_KEY_TOKEN[:8]],
    )
    name: str = Field(
        description="A label for the key. Several keys can have the same name.",
        examples=[examples.API_KEY_NAME],
    )
    scope: Scope
    restricted_to: list[RestrictionEntry] | None = Field(
        description=(
            "What the key is restricted to, under their current names, sorted by project name, "
            "then by suite name. Null if it isn't restricted. A restricted key has its scope only "
            "in these test suites, and can only read everywhere else. A suite that is deleted is "
            "removed from the list, so the list is empty once all of them are: the key then can "
            "only read."
        ),
        examples=[[{"project": examples.PROJECT["name"], "suite": examples.SUITE}]],
    )
    created_at: datetime = Field(description="When the key was created.")
    last_used_at: datetime | None = Field(
        description="When the key was last used, approximately. Null if it has never been used."
    )
    is_active: bool = Field(description="False if the key has been revoked.")


class ApiKeyCreated(ApiKey):
    """A new API key, with its token."""

    token: str = Field(
        description=(
            "The token, to send in an `Authorization: Bearer <token>` header. It is only shown "
            "here: save it, because it can't be retrieved later."
        ),
        examples=[examples.API_KEY_TOKEN],
    )


class ApiKeyCreate(BaseModel):
    """The name and scope of a new key, and the test suites it is restricted to."""

    model_config = ConfigDict(extra="forbid")

    name: Annotated[str, Storable] = Field(
        min_length=1,
        max_length=KEY_NAME_MAX_LENGTH,
        description="A label for the key. Several keys can have the same name.",
    )
    scope: Scope
    # Only the shape is checked here. Which keys can be restricted, and to which existing suites,
    # is checked by `keys.create_key`, which the CLI shares.
    restricted_to: list[RestrictionEntry] | None = Field(
        default=None,
        min_length=1,
        description=(
            "The test suites to restrict the key to, each listed once. It then has its scope only "
            "in these suites, and can only read everywhere else, which includes creating a test "
            "suite or a project. Only `submit`, `triage` and `manage` keys can be restricted, and "
            "every suite must exist. Leave out, or set to null, for an unrestricted key."
        ),
    )


_CREATE_EXAMPLES = {
    "submitter": {
        "summary": "A key for a CI job that submits runs",
        "value": {"name": examples.API_KEY_NAME, "scope": "submit"},
    },
    "restricted": {
        "summary": "A key that submits runs to one test suite only",
        "value": {
            "name": examples.API_KEY_NAME,
            "scope": "submit",
            "restricted_to": [{"project": examples.PROJECT["name"], "suite": examples.SUITE}],
        },
    },
}

# A whole token is not a prefix, so passing one instead finds no key: a 404.
KeyPrefix = Annotated[
    str, Path(description="The key's prefix: the first 8 characters of its token.")
]


@router.get("/api-keys", summary="List API keys")
def list_api_keys(engine: EngineDep) -> Items[ApiKey]:
    """All API keys, newest first, including revoked ones."""
    with engine.connect() as connection:
        found = keys.list_keys(connection)
    return Items(items=[ApiKey.model_validate(key) for key in found])


# No `Location` header: there is deliberately no per-key detail route.
@router.post(
    "/api-keys",
    status_code=201,
    summary="Create an API key",
    responses={
        404: {
            "model": ErrorEnvelope,
            "description": "A project or a test suite in `restricted_to` doesn't exist.",
        }
    },
)
def create_api_key(
    body: Annotated[ApiKeyCreate, Body(openapi_examples=_CREATE_EXAMPLES)], engine: EngineDep
) -> ApiKeyCreated:
    """Create an API key. The response is the only time its token is shown.

    Keys can't be changed and don't expire. To change a key's scope or what it is restricted to,
    create a new key and revoke the old one.

    The test suites in `restricted_to` must exist when the key is created. A suite that is deleted
    later is removed from the key, and a suite created again with the same name is a different
    suite, which the key doesn't cover. A key whose suites have all been deleted stays restricted,
    and can only read.
    """
    restricted_to = (
        None if body.restricted_to is None else [entry.entry() for entry in body.restricted_to]
    )
    try:
        with engine.begin() as connection:
            created = keys.create_key(connection, body.name, body.scope, restricted_to)
    # The subclass first: what does not exist is a 404 (I3), any other refusal a 400.
    except keys.UnknownEntriesError as error:
        raise ApiError(ErrorCode.NOT_FOUND, str(error)) from error
    except ValueError as error:
        raise ApiError(ErrorCode.INVALID_REQUEST, str(error)) from error
    return ApiKeyCreated.model_validate(created)


@router.delete(
    "/api-keys/{prefix}",
    status_code=204,
    summary="Revoke an API key",
    responses={404: {"model": ErrorEnvelope, "description": "No key has this prefix."}},
)
def revoke_api_key(prefix: KeyPrefix, engine: EngineDep) -> None:
    """Revoke an API key. It stops working immediately, and stays in the list with `is_active`
    set to false.

    Revoking an already revoked key succeeds. Revoking can't be undone: create a new key instead.
    Any key can be revoked, including the one used for this request.
    """
    with engine.begin() as connection:
        revoked = keys.revoke_key(connection, prefix)
    if not revoked:
        raise ApiError(ErrorCode.NOT_FOUND, f"No API key has the prefix '{prefix}'.")

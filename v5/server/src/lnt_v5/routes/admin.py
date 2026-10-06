"""Instance-level API key management (E11).

These are the only endpoints in the API that require `admin`, and the only GETs that
unauthenticated access never reaches.
"""

from __future__ import annotations

from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Body, Path
from pydantic import BaseModel, ConfigDict, Field

from lnt_v5 import examples, keys
from lnt_v5.auth import require_scope
from lnt_v5.db import EngineDep
from lnt_v5.errors import ApiError, ErrorCode, ErrorEnvelope
from lnt_v5.responses import Items
from lnt_v5.scopes import Scope
from lnt_v5.strings import Storable
from lnt_v5.tables import KEY_NAME_MAX_LENGTH

router = APIRouter(
    prefix="/api/admin",
    tags=["Admin"],
    dependencies=[require_scope(Scope.ADMIN)],
)

# The docstrings of the models and endpoints below are published, as the descriptions I8's document
# gives them, so they are written for API users.


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
    """The name and scope of a new key."""

    model_config = ConfigDict(extra="forbid")

    name: Annotated[str, Storable] = Field(
        min_length=1,
        max_length=KEY_NAME_MAX_LENGTH,
        description="A label for the key. Several keys can have the same name.",
    )
    scope: Scope


_CREATE_EXAMPLES = {
    "submitter": {
        "summary": "A key for a CI job that submits runs",
        "value": {"name": examples.API_KEY_NAME, "scope": "submit"},
    }
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
@router.post("/api-keys", status_code=201, summary="Create an API key")
def create_api_key(
    body: Annotated[ApiKeyCreate, Body(openapi_examples=_CREATE_EXAMPLES)], engine: EngineDep
) -> ApiKeyCreated:
    """Create an API key. The response is the only time its token is shown.

    Keys can't be changed and don't expire. To change a key's scope, create a new key and revoke
    the old one.
    """
    with engine.begin() as connection:
        created = keys.create_key(connection, body.name, body.scope)
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

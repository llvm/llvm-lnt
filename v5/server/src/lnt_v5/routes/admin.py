"""Instance-level API key management (endpoints.md, Admin).

These are the only endpoints in the API that require `admin`, and the only GETs that
unauthenticated access never reaches.
"""

from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter
from pydantic import BaseModel, ConfigDict, Field

from lnt_v5 import keys
from lnt_v5.auth import require_scope
from lnt_v5.db import EngineDep
from lnt_v5.errors import ApiError, ErrorCode, ErrorEnvelope
from lnt_v5.responses import Items
from lnt_v5.scopes import Scope
from lnt_v5.tables import KEY_NAME_MAX_LENGTH

# Declared on the router rather than on each route: endpoints.md requires `admin` for all three,
# including the GET, and one declaration cannot drift between them.
router = APIRouter(
    prefix="/api/admin",
    tags=["Admin"],
    dependencies=[require_scope(Scope.ADMIN)],
)


class ApiKey(BaseModel):
    """A key as D5 exposes it. Neither the raw token nor its hash ever appears."""

    model_config = ConfigDict(from_attributes=True)

    prefix: str
    name: str
    scope: Scope
    created_at: datetime
    last_used_at: datetime | None = Field(
        description="Null until the key is first used, and approximate thereafter (see D5)."
    )
    is_active: bool


class ApiKeyCreated(ApiKey):
    token: str = Field(
        description="The raw token. Shown only in this response and not recoverable afterwards."
    )


class ApiKeyCreate(BaseModel):
    name: str = Field(
        min_length=1,
        max_length=KEY_NAME_MAX_LENGTH,
        description="A human-readable label. Deliberately not unique: two keys may share one.",
    )
    scope: Scope


@router.get("/api-keys", summary="List API keys")
def list_api_keys(engine: EngineDep) -> Items[ApiKey]:
    """Every key, newest first, revoked ones included."""
    with engine.connect() as connection:
        found = keys.list_keys(connection)
    return Items(items=[ApiKey.model_validate(key) for key in found])


# No `Location` header: there is deliberately no per-key detail route, so the list is the only way
# to read a key back.
@router.post("/api-keys", status_code=201, summary="Create an API key")
def create_api_key(body: ApiKeyCreate, engine: EngineDep) -> ApiKeyCreated:
    """Mint a key, returning its raw token this once (R5)."""
    with engine.begin() as connection:
        created = keys.create_key(connection, body.name, body.scope)
    return ApiKeyCreated.model_validate(created)


@router.delete(
    "/api-keys/{prefix}",
    status_code=204,
    summary="Revoke an API key",
    responses={404: {"model": ErrorEnvelope, "description": "No key has that prefix."}},
)
def revoke_api_key(prefix: str, engine: EngineDep) -> None:
    """Revoke a key by its prefix.

    Idempotent: revoking an already-revoked key succeeds again. A caller that passes a whole token
    instead of its prefix gets a 404, since no key has a 64-character prefix.
    """
    with engine.begin() as connection:
        revoked = keys.revoke_key(connection, prefix)
    if not revoked:
        raise ApiError(ErrorCode.NOT_FOUND, f"No API key has the prefix '{prefix}'.")

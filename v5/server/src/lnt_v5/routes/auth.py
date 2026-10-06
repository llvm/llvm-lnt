"""The key a request authenticated with (E12).

What lets a client check a token, and learn which scope it grants, without the `admin` scope the
API key endpoints require.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from lnt_v5.auth import RequireScope
from lnt_v5.keys import ResolvedKey
from lnt_v5.routes.admin import ApiKey
from lnt_v5.scopes import Scope

AUTH_PATH = "/api/auth"

router = APIRouter(tags=["Authentication"])


class Authentication(BaseModel):
    """Who the request authenticated as."""

    key: ApiKey | None = Field(
        description="The key the request authenticated with, or null if it presented none."
    )


# Depends on the scope check directly rather than declaring it in `dependencies=[...]`, because the
# key that check resolves is the answer.
@router.get(AUTH_PATH, summary="The API key the request authenticated with")
def authentication(
    key: Annotated[ResolvedKey | None, Depends(RequireScope(Scope.READ))],
) -> Authentication:
    """Check a token, and learn which scope it grants.

    `last_used_at` is as it stood before this request, which is itself a use (D5).
    """
    return Authentication(key=None if key is None else ApiKey.model_validate(key))

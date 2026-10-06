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

# The docstrings of the model and the endpoint below are published, as the descriptions I8's
# document gives them, so they are written for API users.


class Authentication(BaseModel):
    """The API key the request was made with."""

    key: ApiKey | None = Field(
        description="The API key the request was made with. Null if it was made without one."
    )


# Depends on the scope check directly rather than declaring it in `dependencies=[...]`, because the
# key that check resolves is the answer. `last_used_at` is as it stood before this request, which
# is itself a use (D5).
@router.get(AUTH_PATH, summary="Get the API key used for the request")
def authentication(
    key: Annotated[ResolvedKey | None, Depends(RequireScope(Scope.READ))],
) -> Authentication:
    """Check an API key, and find out which scope it has. Unlike the other API key operations,
    this doesn't require the `admin` scope.

    `last_used_at` doesn't count this request.
    """
    return Authentication(key=None if key is None else ApiKey.model_validate(key))

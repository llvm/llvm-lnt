"""The crawler policy (I10): every crawler is asked to stay away from the whole instance.

Outside the REST API surface (I5), and so out of I8's document, like `/llms.txt`. The route
declares no scope, so nothing on its path ever looks at an `Authorization` header.
"""

from __future__ import annotations

from fastapi import APIRouter
from fastapi.responses import PlainTextResponse

_POLICY = "User-agent: *\nDisallow: /\n"

router = APIRouter()


# `async def` for the same reason as `/llms.txt` (see llms.py).
@router.get("/robots.txt", include_in_schema=False, response_class=PlainTextResponse)
async def robots_txt() -> str:
    """Ask every crawler to stay away from the whole instance (I10)."""
    return _POLICY

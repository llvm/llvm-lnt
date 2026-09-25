"""The AI agent orientation document (R6).

`/llms.txt` follows the llms.txt convention -- the same idea as robots.txt, addressed to a reader
rather than a crawler: a short plain-text document at a fixed path that tells an automated client
what this server is and how to drive it. The document itself is `llms.txt`, beside this module, so
that prose stays out of Python source and stays diffable as prose.

Outside the REST API surface (R5), and so out of R8's document; see infrastructure.md for both.
Being outside it is structural here rather than an exception applied to it: the route declares no
scope, so nothing on its path ever looks at an `Authorization` header, and a malformed or revoked
one is therefore as ignored as a correct one.
"""

from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter
from fastapi.responses import PlainTextResponse

LLMS_PATH = "/llms.txt"

# Read once, at import: the document is static, and a packaging mistake that lost it should fail
# the process rather than every request. `read_text` decodes UTF-8, which is what R6 serves it as.
_DOCUMENT = (Path(__file__).with_name("llms.txt")).read_text(encoding="utf-8")

router = APIRouter()


# `async def`, alone among this app's endpoints: the others all do blocking database work and
# belong in the threadpool, whereas this one returns a string that is already in memory, and
# handing that to a worker thread costs more than producing the response does.
@router.get(LLMS_PATH, include_in_schema=False, response_class=PlainTextResponse)
async def llms_txt() -> str:
    """Orient an automated client: what LNT is, what it holds, and how to ask for it (R6)."""
    return _DOCUMENT

from __future__ import annotations

import logging

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

logger = logging.getLogger(__name__)

router = APIRouter()

HEALTHZ_PATH = "/healthz"


# include_in_schema=False: R5 places /healthz outside the REST API surface, and R8's document
# describes that surface. It is specified in the design docs, not in the OpenAPI spec.
@router.get(HEALTHZ_PATH, include_in_schema=False)
def healthz(request: Request) -> JSONResponse:
    """Report whether the server can serve traffic (R7).

    Connecting is the whole check: the engine sets `pool_pre_ping`, so checkout issues a trivial
    statement of its own and reconnects if the pooled connection has gone stale. Running a second
    `select 1` here would only double the round trips.

    Known trade-off: this shares the request pool, so a saturated pool reports the same 500 as an
    unreachable database, after blocking for the pool timeout. Splitting off a dedicated probe
    connection is the fix if that ever shows up in practice; there is no point paying for it
    before then.
    """
    engine = request.app.state.engine
    try:
        with engine.connect():
            pass
    except Exception:
        logger.exception("Health check failed: the database is unreachable")
        return JSONResponse(status_code=500, content={"ok": False})
    return JSONResponse(content={"ok": True})

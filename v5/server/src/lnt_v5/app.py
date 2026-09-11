"""Application assembly."""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from starlette.middleware.body_limit import RequestBodyLimitMiddleware

from .config import Settings, get_settings
from .db import make_engine
from .errors import register_error_handlers
from .routes.health import router as health_router
from .spa import SpaStaticFiles

logger = logging.getLogger(__name__)


def _configure_logging() -> None:
    """Send this package's logs through uvicorn's handlers.

    uvicorn configures its own loggers and leaves the root logger alone, so without this our
    module loggers fall back to `logging.lastResort`: no timestamp, no level, and anything below
    WARNING silently dropped. Borrowing uvicorn's handler is what makes `logger.info` usable at
    all, and means application logs are formatted like the server's rather than beside them.

    The handler lives on the `uvicorn` logger; `uvicorn.error` and `uvicorn.access` reach it by
    propagation. A no-op when uvicorn is not running, which leaves pytest's capture alone.
    """
    handlers = logging.getLogger("uvicorn").handlers
    if not handlers:
        return
    package_logger = logging.getLogger(__package__)
    package_logger.handlers = handlers
    package_logger.setLevel(logging.INFO)
    package_logger.propagate = False


def _default_client_dist() -> Path:
    # src/lnt_v5/app.py -> src/lnt_v5 -> src -> server -> v5
    return Path(__file__).resolve().parents[3] / "client" / "dist"


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or get_settings()
    _configure_logging()

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        app.state.engine = make_engine(settings)
        try:
            yield
        finally:
            app.state.engine.dispose()

    app = FastAPI(
        title="LNT v5",
        lifespan=lifespan,
        # R8 puts the OpenAPI document at /api/openapi.json and the viewer at /api/docs. FastAPI
        # would otherwise register them at /docs, /redoc and /openapi.json -- both the wrong URLs
        # and, since neither exists yet, routes that would shadow client paths.
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
    )

    register_error_handlers(app)
    app.add_middleware(RequestBodyLimitMiddleware, max_body_size=settings.body_limit)

    # Routes before the SPA mount: a mount at "/" matches everything, so anything registered
    # after it is unreachable.
    app.include_router(health_router)

    client_dist = Path(settings.client_dist) if settings.client_dist else _default_client_dist()
    if client_dist.is_dir():
        directory: str | None = str(client_dist)
    else:
        # StaticFiles already models "no directory" as serving nothing, which is exactly the
        # specified behaviour for an unbuilt client.
        logger.warning("Client bundle not found at %s; only API routes will be served", client_dist)
        directory = None
    app.mount("/", SpaStaticFiles(directory=directory), name="spa")

    return app

FROM node:24-alpine AS client-build
WORKDIR /app
# Manifests first, so the dependency layer is reused when only sources change.
COPY package.json package-lock.json ./
COPY client/package.json client/package.json
RUN npm ci
COPY client client
RUN npm run build -w client

FROM python:3.14-slim-bookworm AS server-deps
COPY --from=ghcr.io/astral-sh/uv:0.11 /uv /usr/local/bin/uv
WORKDIR /app/server
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy
# Same discipline on this side: lock and manifest before sources. --frozen fails the build if
# uv.lock is stale rather than silently resolving something the tests never saw.
COPY server/pyproject.toml server/uv.lock server/.python-version ./
RUN uv sync --frozen --no-install-project --no-dev
COPY server/src src
RUN uv sync --frozen --no-dev --no-editable

FROM python:3.14-slim-bookworm AS runtime
WORKDIR /app/server
ENV PATH="/app/server/.venv/bin:$PATH" \
    PYTHONUNBUFFERED=1 \
    CLIENT_DIST=/app/client/dist
COPY --from=server-deps /app/server /app/server
COPY --from=client-build /app/client/dist /app/client/dist
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --retries=3 --start-period=5s \
  CMD python -c "import sys,urllib.request; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:3000/healthz', timeout=2).status == 200 else 1)"

CMD ["uvicorn", "lnt_v5.app:create_app", "--factory", "--host", "0.0.0.0", "--port", "3000", \
                                                      "--timeout-graceful-shutdown", "120"]

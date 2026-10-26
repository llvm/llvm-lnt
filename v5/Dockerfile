# Where the Docker Hub images below come from. Pass a mirror of Docker Hub's official images to
# build where Docker Hub is out of reach, e.g. --build-arg DOCKER_HUB=mirror.gcr.io/library.
ARG DOCKER_HUB=docker.io/library

FROM ${DOCKER_HUB}/node:24-alpine AS client-build
WORKDIR /app
# Manifests first, so the dependency layer is reused when only sources change.
COPY package.json package-lock.json ./
COPY client/package.json client/package.json
RUN npm ci
COPY client client
RUN npm run build -w client

FROM ${DOCKER_HUB}/python:3.14-slim-trixie AS server-deps
# From PyPI rather than from uv's own image: the dependencies come from PyPI anyway, so every image
# this build needs comes from Docker Hub, and DOCKER_HUB is the only source to redirect.
RUN pip install --no-cache-dir --root-user-action=ignore 'uv==0.12.*'
WORKDIR /app/server
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy
# Same discipline on this side: lock and manifest before sources. --frozen fails the build if
# uv.lock is stale rather than silently resolving something the tests never saw.
COPY server/pyproject.toml server/uv.lock server/.python-version ./
RUN uv sync --frozen --no-install-project --no-dev
COPY server/src src
RUN uv sync --frozen --no-dev --no-editable

FROM ${DOCKER_HUB}/python:3.14-slim-trixie AS runtime
# The user the server runs as (see USER below), created before the sources are copied, so that
# changing them does not create it again.
RUN groupadd --system --gid 10001 lnt \
 && useradd --system --uid 10001 --gid lnt --no-create-home --shell /usr/sbin/nologin lnt
WORKDIR /app/server
ENV PATH="/app/server/.venv/bin:$PATH" \
    PYTHONUNBUFFERED=1 \
    CLIENT_DIST=/app/client/dist
COPY --from=server-deps /app/server /app/server
COPY --from=client-build /app/client/dist /app/client/dist
# Run unprivileged. Nothing under /app is written at runtime, so root keeps owning it.
USER 10001:10001
EXPOSE 3000
# Probe every second during the start period, so that a server that is up within it reports healthy
# at once, rather than after the much longer steady-state interval. In production, nothing waits on
# this status (see deployment/templates/docker-compose.prod.yml.tftpl): `docker compose ps` shows it.
HEALTHCHECK --interval=30s --timeout=3s --retries=3 --start-period=60s --start-interval=1s \
  CMD python -c "import sys,urllib.request; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:3000/healthz', timeout=2).status == 200 else 1)"

# The commit the image is built from, reported by the API index (E1). Passed in, since the build
# context has no .git. Last, so that a new revision rebuilds nothing.
ARG LNT_REVISION=
ENV LNT_REVISION=$LNT_REVISION
LABEL org.opencontainers.image.revision=$LNT_REVISION

CMD ["lnt-v5", "server", "run"]

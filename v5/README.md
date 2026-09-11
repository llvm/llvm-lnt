# LNT v5

A ground-up redesign of LNT's database, REST API, and web UI. See [docs/design](docs/design) for the
authoritative specification of what v5 does and why.

v5 coexists with the legacy v4 Python app in the same repository, but the two are fully disjoint:
different database schemas, different concepts, different deployments. They are both Python, but
they are separate projects — `v5/server` has its own project file and lockfile, v5 code never
imports from `lnt/`, and the v4 lint, typecheck, and test configuration at the repository root does
not cover `v5/`.

## Technology

Two projects in one tree: `client` (Vite + React, TypeScript) and `server` (FastAPI, talking to
Postgres via SQLAlchemy). The npm workspace at the root drives both, so `npm run <task>` is the
entry point regardless of which language the task runs in. We produce a Docker image containing the
server, which also serves the built client. In production, a Docker Compose stack layers an Nginx
reverse proxy on top of that container, and the database is hosted on Amazon RDS.

## Development

### Prerequisites

- Node.js, matching the version in `.nvmrc` (use `nvm use` if you have nvm installed)
- [uv](https://docs.astral.sh/uv/), which manages the Python toolchain and dependencies. It
  installs the interpreter named in `server/.python-version` for you.
- Docker, for running Postgres locally

### Setup

```sh
cd v5
npm ci
npm run install:server
cp .env.example .env
npm run db:up      # starts a local Postgres container on port 5432
```

### Running

```sh
npm run dev
```

This starts the Vite dev server at http://localhost:5173 and the FastAPI server at
http://localhost:3000. Vite proxies `/api`, `/healthz`, and `/llms.txt` through to FastAPI.

The server reads its configuration from the environment; `npm run dev:server` passes `.env` to it
via `uv run --env-file`. Nothing loads `.env` implicitly, so the test suite is unaffected by
whatever you have in it. To create a token against your local database:

```sh
npm run create-key                                # a token named "dev", with admin scope
npm run create-key -- --name bot --scope submit   # anything else
```

The token is printed on stdout and is not recoverable afterwards -- create another if you lose it.
Paste the token into the web UI's Settings panel to use it from the browser.

### Testing and building

```sh
npm run check             # lint + typecheck + test
npm test                  # both test suites
npm run lint
npm run typecheck
npm run format            # autoformat the Python sources
npm run build             # build the client bundle the server serves
npm run test:integration  # builds the Docker image and exercises it end to end
```

Individual halves are available as `:client` / `:server` variants, e.g. `npm run test:server`.

The integration tests are what CI runs against the image; they need Docker, but create and remove
their own database.

Stop the local database with `npm run db:down` when you're done.

### Docker

The `Dockerfile` builds the production image (client build + server, no dev tooling). It is not used
for day-to-day development — use `npm run dev` instead. To build and run it:

```sh
docker build -t lnt-v5 .
npm run db:up   # if not already running
docker run --init --rm -p 3000:3000 --network v5_default \
  -e DATABASE_URL="postgres://lnt:lnt@postgres:5432/lnt" \
  lnt-v5
```

The container always listens on 3000; map it elsewhere with `-p`, e.g. `-p 8080:3000`.

`DATABASE_URL` is overridden because `.env.example` points at `localhost` (for running the server
directly on the host), whereas this container reaches Postgres over the `v5_default` Docker network,
where it is addressable as `postgres`.

Then `curl localhost:3000/healthz` should return `{"ok":true}`, and http://localhost:3000 should
serve the client shell.

### Configuration

| Variable | Default | Meaning |
|----------|---------|---------|
| `DATABASE_URL` | *(required)* | Postgres connection URL. `postgres://` and `postgresql://` are normalized to the psycopg driver. |
| `DATABASE_SSL_CA` | unset | Path to a CA bundle. When set, connections use `sslmode=verify-full`. |
| `BODY_LIMIT` | `134217728` | Maximum request body, in bytes. A reverse proxy in front of the server needs a matching limit; raise both together. |
| `CLIENT_DIST` | derived | Path to the built client. Set explicitly in the Docker image. |
| `WEB_CONCURRENCY` | `1` | Number of worker processes. Each holds its own database connection pool, so this multiplies how many connections the server can open; see the sizing notes in [docs/deployment.md](docs/deployment.md). |

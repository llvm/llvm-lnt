# LNT v5

A ground-up redesign of LNT's database, REST API, and web UI. See [docs/design](docs/design) for the
authoritative specification of what v5 does and why.

v5 coexists with the legacy v4 Python app in the same repository, but the two are fully disjoint:
different database schemas, different concepts, different deployments.

## Technology

An npm-workspaces monorepo: `client` (Vite + React) and `server` (Fastify, talking to Postgres via
Drizzle). We produce a Docker image containing the server, which also serves the built client. In
production, a Docker Compose stack layers an Nginx reverse proxy on top of that container, and the
database is hosted on Amazon RDS.

## Development

### Prerequisites

- Node.js, matching the version in `.nvmrc` (use `nvm use` if you have nvm installed)
- Docker, for running Postgres locally

### Setup

```sh
cd v5
npm install
cp .env.example .env
npm run db:up      # starts a local Postgres container on port 5432
```

### Running

```sh
npm run dev
```

This starts the Vite dev server at http://localhost:5173 and the Fastify server at
http://localhost:3000. Vite proxies `/api`, `/healthz`, and `/llms.txt` through to Fastify.

### Testing and building

```sh
npm test    # runs both workspaces' test suites
npm run lint
npm run build
```

Stop the local database with `npm run db:down` when you're done.

### Docker

The `Dockerfile` builds the production image (client build + server, no dev tooling). It is not used
for day-to-day development — use `npm run dev` instead. To build and run it:

```sh
docker build -t lnt-v5 .
npm run db:up   # if not already running
docker run --init --rm -p 3000:3000 --network v5_default \
  -e DATABASE_URL="postgres://lnt:lnt@postgres:5432/lnt" \
  -e PORT=3000 \
  lnt-v5
```

`DATABASE_URL` is overridden because `.env.example` points at `localhost` (for running the server
directly on the host), whereas this container reaches Postgres over the `v5_default` Docker network,
where it is addressable as `postgres`.

Then `curl localhost:3000/healthz` should return `{"ok":true}`, and http://localhost:3000 should
serve the client shell.

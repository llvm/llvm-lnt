#!/usr/bin/env bash
#
# start_postgres.sh <LOG_FILE>
#
# Start a fresh PostgreSQL container. Sets and outputs KEY=VALUE lines for:
#
#   LNT_PG_CONTAINER     Container name (needed to stop it later)
#   LNT_TEST_DB_URI      Base connection URL (no database), e.g. postgresql://postgres@127.0.0.1:PORT
#   LNT_TEST_DB_NAME     Name of the ready-to-use database ("lnt_test")
#
# Shell callers can capture and eval the output, e.g.:
#   pg_output=$(start_postgres.sh /tmp/pg.log)
#   eval "${pg_output}"
# Python callers can execute it and parse the KEY=VALUE stdout lines.
#
# LOG_FILE receives the PostgreSQL server logs (pass /dev/null to discard).
# The caller is responsible for stopping and removing the container.
#
set -euo pipefail

if ! command -v docker > /dev/null 2>&1; then
    echo 1>&2 "error: Could not find 'docker' -- Docker is required to run the tests"
    exit 1
fi

if [ $# -lt 1 ]; then
    echo 1>&2 "usage: start_postgres.sh <LOG_FILE>"
    exit 1
fi

LOG_FILE="$1"

# ---------------------------------------------------------------------------
# Unique container name — allows parallel test runs without collision.
# ---------------------------------------------------------------------------
CONTAINER_NAME="lnt_pg_$(uuidgen | tr '[:upper:]' '[:lower:]' | tr -d '-')"

# ---------------------------------------------------------------------------
# Start the container in the background and bind a random port from the host
# to the container's 5432 port.
#
# Key flags:
#   POSTGRES_HOST_AUTH_METHOD=trust     no password needed
#   --tmpfs /var/lib/postgresql/data    store data in RAM — faster, no cleanup needed
# ---------------------------------------------------------------------------
echo 1>&2 "Starting container ${CONTAINER_NAME} ..."
docker run \
    --detach \
    --name "${CONTAINER_NAME}" \
    --publish "127.0.0.1::5432" \
    --env POSTGRES_HOST_AUTH_METHOD=trust \
    --tmpfs /var/lib/postgresql/data \
    postgres:17-alpine \
    > /dev/null 2>&1

echo 1>&2 "Streaming PostgreSQL server logs into ${LOG_FILE}"
docker logs --follow "${CONTAINER_NAME}" >> "${LOG_FILE}" 2>&1 &

# ---------------------------------------------------------------------------
# Discover the host port that Docker assigned.
# ---------------------------------------------------------------------------
HOST_PORT=$(docker port "${CONTAINER_NAME}" 5432/tcp | head -1 | sed 's/.*://')
if [ -z "${HOST_PORT}" ]; then
    echo 1>&2 "error: could not determine host port for container ${CONTAINER_NAME}"
    docker logs "${CONTAINER_NAME}" 1>&2
    exit 1
fi

echo 1>&2 "PostgreSQL available at: postgresql://postgres@127.0.0.1:${HOST_PORT}"

# ---------------------------------------------------------------------------
# Wait for PostgreSQL to accept connections (up to 30 seconds).
#
# NOTE: We use '-h localhost' to check via TCP rather than the Unix socket.
# The official postgres image runs a temporary server during initdb that
# listens only on the Unix socket (listen_addresses=''). Without '-h localhost',
# pg_isready can succeed against that temp server, then createdb fails when
# the socket disappears during the transition to the real server.
# ---------------------------------------------------------------------------
MAX_TRIES=30
for i in $(seq 1 "${MAX_TRIES}"); do
    if docker exec "${CONTAINER_NAME}" pg_isready --quiet -h localhost; then
        echo 1>&2 "PostgreSQL ready after ${i} attempt(s)."
        break
    fi
    if [ "${i}" -eq "${MAX_TRIES}" ]; then
        echo 1>&2 "error: PostgreSQL did not become ready after ${MAX_TRIES}s."
        docker logs "${CONTAINER_NAME}" 1>&2
        exit 1
    fi
    sleep 1
done

# ---------------------------------------------------------------------------
# Create a default database for tests to use.
# ---------------------------------------------------------------------------
docker exec "${CONTAINER_NAME}" createdb --username=postgres lnt_test

# ---------------------------------------------------------------------------
# Output machine-readable results to stdout (for callers that capture output,
# e.g. Python subprocess). Shell callers can source this script directly and
# use the variables.
# ---------------------------------------------------------------------------
LNT_PG_CONTAINER="${CONTAINER_NAME}"
LNT_TEST_DB_URI="postgresql://postgres@127.0.0.1:${HOST_PORT}"
LNT_TEST_DB_NAME="lnt_test"

echo "LNT_PG_CONTAINER=${LNT_PG_CONTAINER}"
echo "LNT_TEST_DB_URI=${LNT_TEST_DB_URI}"
echo "LNT_TEST_DB_NAME=${LNT_TEST_DB_NAME}"

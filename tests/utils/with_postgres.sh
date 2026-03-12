#!/usr/bin/env bash
#
# with_postgres.sh <LOG_FILE> <command> [args...]
#
# Start a fresh PostgreSQL container, run the wrapped command, then stop and
# remove the container. The following environment variables are exported before
# the command runs:
#
#   LNT_TEST_DB_URI      Base connection URL (no database), e.g. postgresql://postgres@127.0.0.1:PORT
#   LNT_TEST_DB_NAME     Name of a ready-to-use database ("lnt_test")
#
# Example:
#   with_postgres.sh /tmp/my.log bash my_test.sh "${LNT_TEST_DB_URI}" "${LNT_TEST_DB_NAME}"
#
set -euo pipefail

if ! command -v docker > /dev/null 2>&1; then
    echo "error: Could not find 'docker' -- Docker is required to run the tests"
    exit 1
fi

# ---------------------------------------------------------------------------
# Arguments
# ---------------------------------------------------------------------------
if [ $# -lt 2 ]; then
    echo 1>&2 "usage: $(basename "$0") <LOG_FILE> <command> [args...]"
    exit 1
fi

LOG_FILE="$1"
shift

if [ -f "${LOG_FILE}" ]; then
    echo 1>&2 "error: Log file ${LOG_FILE} already exists"
    exit 1
fi

# ---------------------------------------------------------------------------
# Unique container name — allows parallel test runs without collision.
# ---------------------------------------------------------------------------
CONTAINER_NAME="lnt_pg_$(uuidgen | tr '[:upper:]' '[:lower:]' | tr -d '-')"

# ---------------------------------------------------------------------------
# Cleanup — always stop and remove the container, success or failure.
# ---------------------------------------------------------------------------
cleanup() {
    local exit_code=$?
    echo "Stopping container ${CONTAINER_NAME} ..."
    docker stop  "${CONTAINER_NAME}" > /dev/null 2>&1 || true
    docker rm    "${CONTAINER_NAME}" > /dev/null 2>&1 || true
    exit "${exit_code}"
}
trap cleanup EXIT

# ---------------------------------------------------------------------------
# Start the container in the background and bind a random port from the host
# to the container's 5432 port. Stream the logs of the container into the
# specified log file -- useful for debugging.
#
# Key flags:
#   POSTGRES_HOST_AUTH_METHOD=trust     no password needed
#   --tmpfs /var/lib/postgresql/data    store data in RAM — faster, no cleanup needed
# ---------------------------------------------------------------------------
echo "Starting container ${CONTAINER_NAME} ..."
docker run \
    --detach \
    --name "${CONTAINER_NAME}" \
    --publish "127.0.0.1::5432" \
    --env POSTGRES_HOST_AUTH_METHOD=trust \
    --tmpfs /var/lib/postgresql/data \
    postgres:17-alpine \
    > /dev/null 2>&1

echo "Streaming PostgreSQL server logs into ${LOG_FILE}"
docker logs --follow "${CONTAINER_NAME}" >> "${LOG_FILE}" 2>&1 &

# ---------------------------------------------------------------------------
# Discover the host port that Docker assigned.
# `docker port` output: "n.n.n.n:PORT"
# ---------------------------------------------------------------------------
HOST_PORT=$(docker port "${CONTAINER_NAME}" 5432/tcp | head -1 | sed 's/.*://')
if [ -z "${HOST_PORT}" ]; then
    echo 1>&2 "error: could not determine host port for container ${CONTAINER_NAME}"
    docker logs "${CONTAINER_NAME}" 1>&2
    exit 1
fi

export LNT_TEST_DB_URI="postgresql://postgres@127.0.0.1:${HOST_PORT}"
echo "PostgreSQL available at: ${LNT_TEST_DB_URI}"

# ---------------------------------------------------------------------------
# Wait for PostgreSQL to accept connections (up to 30 seconds).
# pg_isready is available inside the official postgres image.
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
        echo "PostgreSQL ready after ${i} attempt(s)."
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
export LNT_TEST_DB_NAME="lnt_test"

# ---------------------------------------------------------------------------
# Run the wrapped command.
# ---------------------------------------------------------------------------
eval "$@"

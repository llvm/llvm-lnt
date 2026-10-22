#!/usr/bin/env bash
#
# Integration tests for the v5 image.
#
#   ./run.sh [IMAGE]
#
# Starts IMAGE against a throwaway Postgres, behind the Nginx that production puts in front of it
# (deployment/templates), and runs every numbered check in this directory against it, in order.
# Everything is created here and torn down on exit, so this behaves the same on a laptop as on a
# CI runner and needs neither `npm run db:up` nor a Postgres service container.
#
# Each check is run with:
#   CONTAINER     the app container, for checks that signal or restart it
#   DB_CONTAINER  the Postgres container, for checks that take the database away
#   PROXY_URL     where the server is reachable through Nginx, whose certificate is a throwaway one
#                 (so requests to it need `--insecure`)
#
# Checks source lib.sh for strict mode and test helpers, and for BASE_URL, where the server is
# reachable directly. They run in filename order and are independent, with one exception: anything
# that stops the server has to sort last, which is what the numeric prefixes are for.
#
# Several runs can go on at once, from different checkouts say: a run names everything it creates
# after a random identifier, and removes only that. A run killed outright (SIGKILL), or terminated
# while it builds the image, leaves its containers, network or image behind. This removes them,
# along with those of any run in progress, so only use it when none is:
#
#   for container in $(docker ps --all --quiet --filter label=lnt-v5-integration); do
#       docker rm --force "$container"
#   done
#   docker network prune --force --filter label=lnt-v5-integration
#   for image in $(docker images --format '{{.Repository}}:{{.Tag}}' 'lnt-v5:integration-*'); do
#       docker image rm "$image"
#   done

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

ID="$(printf '%04x%04x' "$RANDOM" "$RANDOM")"
NETWORK="lnt-v5-integration-${ID}"
APP="lnt-v5-integration-${ID}-app"
PG="lnt-v5-integration-${ID}-db"
PROXY="lnt-v5-integration-${ID}-proxy"
# What the cleanup commands above look for.
LABEL="lnt-v5-integration"
# Only set if this run builds the image, which it then removes.
BUILT=""
# The proxy's configuration and certificate, before they are copied into its container.
SCRATCH="$(mktemp -d)"

export CONTAINER="$APP"
export DB_CONTAINER="$PG"

cleanup() {
    docker rm --force "$PROXY" "$APP" "$PG" >/dev/null 2>&1 || true
    docker network rm "$NETWORK" >/dev/null 2>&1 || true
    if [ -n "$BUILT" ]; then docker image rm "$BUILT" >/dev/null 2>&1 || true; fi
    rm -rf "$SCRATCH"
}
trap cleanup EXIT

# With no argument, build the image from the tree first, so that `npm run test:integration` is
# a single command from a clean checkout. CI passes the tag it just built, and so skips this.
#
# The tag is this run's own: a run in another checkout could otherwise move it to an image of its
# own in the meantime, which can make this one unreachable. The build cache, which is shared,
# keeps building it again cheap.
if [ $# -ge 1 ]; then
    IMAGE="$1"
else
    IMAGE="lnt-v5:integration-${ID}"
    BUILT="$IMAGE"
    echo "Building ${IMAGE}..."
    docker build --tag "$IMAGE" "${HERE}/.."
fi

echo "Starting Postgres..."
docker network create --label "$LABEL" "$NETWORK" >/dev/null
docker run --detach --name "$PG" --label "$LABEL" --network "$NETWORK" \
    --env POSTGRES_USER=lnt --env POSTGRES_PASSWORD=lnt --env POSTGRES_DB=lnt \
    --health-cmd='pg_isready -U lnt' --health-interval=2s \
    --health-timeout=3s --health-retries=15 \
    postgres:18-alpine >/dev/null

for _ in $(seq 1 60); do
    [ "$(docker inspect -f '{{.State.Health.Status}}' "$PG")" = healthy ] && break
    sleep 1
done
if [ "$(docker inspect -f '{{.State.Health.Status}}' "$PG")" != healthy ]; then
    echo "Postgres never became healthy" >&2
    docker logs "$PG" >&2
    exit 1
fi

echo "Starting ${IMAGE}..."
# The host port is left to Docker (see lib.sh for how the checks find it).
#
# BODY_LIMIT is lowered from its 128 MiB default so that body-size checks can be done without
# having to send huge payloads.
#
# WEB_CONCURRENCY is set to exercise multiple concurrent workers in the integration tests.
#
# The network alias is the name the Nginx configuration reaches the app by, as in production.
docker run --detach --init --name "$APP" --label "$LABEL" --network "$NETWORK" --network-alias app \
    --publish 127.0.0.1::3000 \
    --env DATABASE_URL="postgres://lnt:lnt@${PG}:5432/lnt" \
    --env BODY_LIMIT=1048576 \
    --env WEB_CONCURRENCY=4 \
    "$IMAGE" >/dev/null

echo "Starting Nginx..."
# Production's configuration and Nginx image, with this host's name for the domain and a throwaway
# certificate for it. The configuration is a Terraform template: one that came to use more than the
# domain would not render here, so this refuses whatever it leaves behind.
COMPOSE_TEMPLATE="${HERE}/../deployment/templates/docker-compose.prod.yml.tftpl"
NGINX_IMAGE="$(sed -n 's/^ *image: *\(nginx:.*\)$/\1/p' "$COMPOSE_TEMPLATE")"
if [ -z "$NGINX_IMAGE" ]; then
    echo "No Nginx image found in ${COMPOSE_TEMPLATE}" >&2
    exit 1
fi
sed 's/\${domain}/localhost/g' "${HERE}/../deployment/templates/nginx.conf.tftpl" > "${SCRATCH}/nginx.conf"
if grep -nE '[$%]\{' "${SCRATCH}/nginx.conf" >&2; then
    echo "nginx.conf.tftpl uses template features this script does not render" >&2
    exit 1
fi
mkdir "${SCRATCH}/certs"
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=localhost \
    -keyout "${SCRATCH}/certs/origin.key" -out "${SCRATCH}/certs/origin.pem" 2>/dev/null
# Copied in rather than mounted, which works the same whatever the Docker host can mount.
docker create --name "$PROXY" --label "$LABEL" --network "$NETWORK" \
    --publish 127.0.0.1::443 "$NGINX_IMAGE" >/dev/null
docker cp "${SCRATCH}/nginx.conf" "${PROXY}:/etc/nginx/conf.d/default.conf"
docker cp "${SCRATCH}/certs" "${PROXY}:/etc/nginx/certs"
docker start "$PROXY" >/dev/null

# wait_until_reachable <base URL> <container> -- wait for /healthz to answer there, or show the
# container's log and fail.
wait_until_reachable() {
    for _ in $(seq 1 60); do
        curl --silent --fail --insecure --output /dev/null "$1/healthz" && return 0
        sleep 1
    done
    echo "Server never became reachable at $1/healthz" >&2
    docker logs "$2" >&2
    exit 1
}

BASE_URL="http://$(docker port "$APP" 3000/tcp)"
wait_until_reachable "$BASE_URL" "$APP"
# Unlike the app's, the proxy's port stays the same for the whole run, so the checks are given it.
PROXY_URL="https://$(docker port "$PROXY" 443/tcp)"
wait_until_reachable "$PROXY_URL" "$PROXY"
export PROXY_URL

group_start() { [ -n "${GITHUB_ACTIONS:-}" ] && echo "::group::$1" || echo "--- $1"; }
group_end() { [ -n "${GITHUB_ACTIONS:-}" ] && echo "::endgroup::" || true; }

passed=0
failed=()
for check in "$HERE"/[0-9]*.sh; do
    name="$(basename "$check")"
    group_start "$name"
    # Checks report their own diagnostics on stderr; fold it into stdout so it stays next to
    # the check it belongs to rather than surfacing wherever the two streams happen to meet.
    if bash "$check" 2>&1; then
        group_end
        echo "PASS  $name"
        passed=$((passed + 1))
    else
        group_end
        echo "FAIL  $name"
        failed+=("$name")
    fi
done

# Container logs first, summary last: whatever a failure left on screen should be the list of
# what failed, not fifty lines of request log scrolled past it. The logs are context for a check
# that failed because the *server* or the proxy misbehaved; an assertion that simply did not match
# has already said so above.
if [ ${#failed[@]} -gt 0 ]; then
    group_start "container log (last 20 lines)"
    docker logs --tail 20 "$APP" 2>&1 | sed 's/^/  /'
    group_end
    # Without the line Nginx logs for each worker it starts, one per CPU.
    group_start "proxy log (last 20 lines)"
    docker logs "$PROXY" 2>&1 | { grep -v 'start worker process' || true; } | tail -n 20 | sed 's/^/  /'
    group_end
fi

echo
echo "${passed} passed, ${#failed[@]} failed"
if [ ${#failed[@]} -gt 0 ]; then
    printf '  FAILED: %s\n' "${failed[@]}"
    exit 1
fi

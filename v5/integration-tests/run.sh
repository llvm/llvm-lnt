#!/usr/bin/env bash
#
# Integration tests for the v5 image.
#
#   ./run.sh [IMAGE]
#
# Runs IMAGE in the Compose stack that production runs (deployment/templates): the app behind
# Nginx, each with production's configuration. compose.override.yml adds what the production host
# provides otherwise, a database (here a throwaway Postgres) and ports of its own, and the stack is
# given a throwaway certificate and the settings the checks expect. Every numbered check in this
# directory then runs against it, in order. Everything is created here and torn down on exit, so
# this behaves the same on a laptop as on a CI runner and needs neither `npm run db:up` nor a
# Postgres service container. It needs Docker Compose 2.24.4 or later, for the override's `!reset`
# and `!override`.
#
# The stack's files are written to a temporary directory, which the Docker daemon has to be able to
# mount files from: with a runtime that does not share the default one (Colima, or Docker Desktop
# with custom file sharing), point TMPDIR at a directory that it shares.
#
# Each check is run with:
#   CONTAINER     the app container, for checks that signal or restart it
#   DB_CONTAINER  the Postgres container, for checks that work on the database directly
#   PROXY_URL     where the server is reachable through Nginx, whose certificate is a throwaway one
#                 (so requests to it need `--insecure`)
#
# Checks source lib.sh for strict mode and test helpers, and for BASE_URL, where the server is
# reachable directly. They run in filename order and are independent, with one exception: anything
# that stops the server has to sort last, which is what the numeric prefixes are for.
#
# Several runs can go on at once, from different checkouts say: a run is a Compose project named
# after a random identifier, and removes only that. A run killed outright (SIGKILL), or terminated
# while it builds the image, leaves its containers, network or image behind. This removes them,
# along with those of any run in progress, so only use it when none is:
#
#   for project in $(docker compose ls --all --quiet --filter 'name=^lnt-v5-integration-'); do
#       docker compose -p "$project" down --volumes --remove-orphans
#   done
#   for network in $(docker network ls --quiet --filter 'name=lnt-v5-integration-'); do
#       docker network rm "$network"
#   done
#   for image in $(docker images --format '{{.Repository}}:{{.Tag}}' 'lnt-v5:integration-*'); do
#       docker image rm "$image"
#   done

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATES="${HERE}/../deployment/templates"

ID="$(printf '%04x%04x' "$RANDOM" "$RANDOM")"
PROJECT="lnt-v5-integration-${ID}"
# Only set if this run builds the image, which it then removes.
BUILT=""
# The stack's files, laid out as on the production host (see user_data.sh.tftpl).
SCRATCH="$(mktemp -d)"

# Every Compose command goes through this, cleanup included: without its files, Compose would pick
# up whatever it finds in or above the current directory, or in COMPOSE_FILE.
compose() {
    docker compose -p "$PROJECT" -f "${SCRATCH}/docker-compose.yml" \
        -f "${HERE}/compose.override.yml" "$@"
}

cleanup() {
    compose down --volumes --remove-orphans >/dev/null 2>&1 || true
    if [ -n "$BUILT" ]; then docker image rm "$BUILT" >/dev/null 2>&1 || true; fi
    rm -rf "$SCRATCH"
}
trap cleanup EXIT

# With no argument, build the image from the tree first (below), so that `npm run test:integration`
# is a single command from a clean checkout. CI passes the tag it just built, and so skips this.
#
# The tag is this run's own: a run in another checkout could otherwise move it to an image of its
# own in the meantime, which can make this one unreachable. The build cache, which is shared,
# keeps building it again cheap.
if [ $# -ge 1 ]; then
    IMAGE="$1"
else
    IMAGE="lnt-v5:integration-${ID}"
    BUILT="$IMAGE"
fi

# render <sed script> <template> <file> -- render deployment/templates/<template>.tftpl into the
# stack's <file>.
#
# They are Terraform templates, rendered here with the image under test and this host's name for
# the domain. One that came to use more than that would not render here, so this refuses whatever
# it leaves behind.
render() {
    sed "$1" "${TEMPLATES}/$2.tftpl" > "${SCRATCH}/$3"
    if grep -nE '[$%]\{' "${SCRATCH}/$3" >&2; then
        echo "$2.tftpl uses template features this script does not render" >&2
        exit 1
    fi
}
render "s|\${image}|${IMAGE}|g" docker-compose.prod.yml docker-compose.yml
render 's|\${domain}|localhost|g' nginx.conf nginx.conf
mkdir "${SCRATCH}/certs"
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=localhost \
    -keyout "${SCRATCH}/certs/origin.key" -out "${SCRATCH}/certs/origin.pem" 2>/dev/null
# BODY_LIMIT is lowered from its 128 MiB default so that body-size checks can be done without
# having to send huge payloads. WEB_CONCURRENCY exercises several workers at once.
cat > "${SCRATCH}/.env" <<ENV
DATABASE_URL=postgres://lnt:lnt@postgres:5432/lnt
BODY_LIMIT=1048576
WEB_CONCURRENCY=4
ENV

# For the log, and to fail before the build on a Compose too old for the override.
docker compose version
compose config --quiet
if [ -n "$BUILT" ]; then
    echo "Building ${IMAGE}..."
    docker build --tag "$IMAGE" "${HERE}/.."
fi

echo "Starting the stack..."
if ! compose up --detach --quiet-pull; then
    compose logs --tail 50 >&2
    exit 1
fi

# wait_until_reachable <base URL> <service> -- wait for /healthz to answer there, or show the
# service's log and fail.
wait_until_reachable() {
    for _ in $(seq 1 60); do
        curl --silent --fail --insecure --output /dev/null "$1/healthz" && return 0
        sleep 1
    done
    echo "Server never became reachable at $1/healthz" >&2
    compose logs "$2" >&2
    exit 1
}

CONTAINER="$(compose ps --quiet app)"
DB_CONTAINER="$(compose ps --quiet postgres)"
export CONTAINER DB_CONTAINER
# The app's port changes when a check restarts it, so lib.sh looks it up in each check. The
# proxy's stays the same for the whole run, so the checks are given it.
wait_until_reachable "http://$(compose port app 3000)" app
PROXY_URL="https://$(compose port nginx 443)"
wait_until_reachable "$PROXY_URL" nginx
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
    compose logs --no-log-prefix --tail 20 app 2>&1 | sed 's/^/  /'
    group_end
    # Without the line Nginx logs for each worker it starts, one per CPU.
    group_start "proxy log (last 20 lines)"
    compose logs --no-log-prefix nginx 2>&1 | { grep -v 'start worker process' || true; } \
        | tail -n 20 | sed 's/^/  /'
    group_end
fi

echo
echo "${passed} passed, ${#failed[@]} failed"
if [ ${#failed[@]} -gt 0 ]; then
    printf '  FAILED: %s\n' "${failed[@]}"
    exit 1
fi

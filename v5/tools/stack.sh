#!/usr/bin/env bash
#
# Run a command against the v5 image, in the Compose stack that production runs.
#
#   tools/stack.sh [--env NAME=VALUE]... -- COMMAND [ARG...]
#
# This is what the integration tests (`npm run test:integration`) and the end-to-end tests (`npm run
# test:e2e`) run against. The stack is production's (deployment/templates): the app behind Nginx,
# each with production's configuration. stack.override.yml adds what the production host provides
# otherwise, a database (here a throwaway Postgres) and ports of its own, and the stack is given a
# throwaway certificate and an empty RDS CA bundle. Its .env sets DATABASE_URL, and every NAME=VALUE
# given with --env.
#
# The image is $LNT_V5_IMAGE if set. Otherwise it is built from the tree first, so that the tests
# are a single command from a clean checkout, and removed afterwards. CI passes the image it built.
# Either way, the integration tests expect it to be built with a revision (LNT_REVISION), as CI
# builds it: this builds it with HEAD's, even if the tree has changed since.
#
# COMMAND runs once the app answers, both directly and through Nginx, with:
#   CONTAINER             the app container
#   DB_CONTAINER          the Postgres container
#   PROXY_URL             where the server is reachable through Nginx
#   COMPOSE_PROJECT_NAME  and COMPOSE_FILE, so that `docker compose` commands act on this stack
#   NODE_EXTRA_CA_CERTS   the throwaway certificate (added to any already listed), so that Node
#                         trusts PROXY_URL (anything else needs to skip verification, e.g. curl's
#                         `--insecure`)
#
# This exits with COMMAND's status, once it has torn the stack down; or fails if a container was
# restarted on its own meanwhile, which production's restart policy would otherwise hide.
# Everything is created here and torn down on exit, so this behaves the same on a laptop as on a CI
# runner. It needs Docker Compose 2.24.4 or later, for the override's `!override`, and `openssl`.
#
# The stack's files are written to a temporary directory, which the Docker daemon has to be able to
# mount files from: with a runtime that does not share the default one (Colima, or Docker Desktop
# with custom file sharing), point TMPDIR at a directory that it shares.
#
# Several runs can go on at once, from different checkouts say: a run is a Compose project named
# after a random identifier, and removes only that. A run killed outright (SIGKILL), or terminated
# while it builds the image, leaves its containers, network or image behind, and its directory in
# TMPDIR (`tmp.*`, holding a throwaway key). This removes all but the directory, along with those of
# any run in progress, so only use it when none is:
#
#   for project in $(docker compose ls --all --quiet --filter 'name=^lnt-v5-test-'); do
#       docker compose -p "$project" down --volumes --remove-orphans
#   done
#   for network in $(docker network ls --quiet --filter 'name=lnt-v5-test-'); do
#       docker network rm "$network"
#   done
#   for image in $(docker images --format '{{.Repository}}:{{.Tag}}' 'lnt-v5:test-*'); do
#       docker image rm "$image"
#   done

set -euo pipefail

usage() {
    echo "usage: $0 [--env NAME=VALUE]... -- COMMAND [ARG...]" >&2
    exit 2
}

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATES="${HERE}/../deployment/templates"

ENV_LINES=""
while [ $# -gt 0 ]; do
    case "$1" in
        --env)
            [ $# -ge 2 ] && [[ "$2" == ?*=* ]] || usage
            ENV_LINES+="$2"$'\n'
            shift 2
            ;;
        --)
            shift
            break
            ;;
        *) usage ;;
    esac
done
[ $# -ge 1 ] || usage

ID="$(printf '%04x%04x' "$RANDOM" "$RANDOM")"
PROJECT="lnt-v5-test-${ID}"
# Only set if this run builds the image, which it then removes.
BUILT=""
# The stack's files, laid out as on the production host (see user_data.sh.tftpl).
SCRATCH="$(mktemp -d)"

# Every Compose command goes through this, cleanup included: without its files, Compose would pick
# up whatever it finds in or above the current directory, or in COMPOSE_FILE.
compose() {
    docker compose -p "$PROJECT" -f "${SCRATCH}/docker-compose.yml" \
        -f "${HERE}/stack.override.yml" "$@"
}

# Also run when this is killed by SIGINT or SIGTERM (Ctrl-C reaches COMMAND as well), after which
# bash exits by the same signal. A second one must not cut the cleanup short.
cleanup() {
    trap '' INT TERM
    compose down --volumes --remove-orphans >/dev/null 2>&1 || true
    if [ -n "$BUILT" ]; then docker image rm "$BUILT" >/dev/null 2>&1 || true; fi
    rm -rf "$SCRATCH"
}
trap cleanup EXIT

# The tag is this run's own: a run in another checkout could otherwise move it to an image of its
# own in the meantime, which can make this one unreachable. The build cache, which is shared,
# keeps building it again cheap.
if [ -n "${LNT_V5_IMAGE:-}" ]; then
    IMAGE="$LNT_V5_IMAGE"
else
    IMAGE="lnt-v5:test-${ID}"
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
# With the names PROXY_URL can have, so that a client that trusts it can verify it.
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=localhost \
    -addext 'subjectAltName=DNS:localhost,IP:127.0.0.1' \
    -keyout "${SCRATCH}/certs/origin.key" -out "${SCRATCH}/certs/origin.pem" 2>/dev/null
# Mounted as in production, but never read: there is no TLS to the test Postgres, so .env sets no
# DATABASE_SSL_CA.
touch "${SCRATCH}/certs/rds-global-bundle.pem"
{
    echo "DATABASE_URL=postgres://lnt:lnt@postgres:5432/lnt"
    printf '%s' "$ENV_LINES"
} > "${SCRATCH}/.env"

# A Compose older than 2.24.4 ignores the override's `!override`, and so would publish Nginx on the
# host's 80 and 443 as well, on every interface. Checked on the merged stack, before the build.
docker compose version
merged="$(compose config)"
if grep -Eq '^ *published: "?(80|443)"?$' <<< "$merged"; then
    echo "The stack publishes the host's port 80 or 443: Docker Compose 2.24.4+ is needed" >&2
    exit 1
fi
if [ -n "$BUILT" ]; then
    echo "Building ${IMAGE}..."
    docker build --tag "$IMAGE" \
        --build-arg LNT_REVISION="$(git -C "$HERE" rev-parse --short HEAD)" "${HERE}/.."
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
if [ -z "$CONTAINER" ] || [ -z "$DB_CONTAINER" ]; then
    echo "The app or Postgres is not running" >&2
    compose logs --tail 50 >&2
    exit 1
fi
wait_until_reachable "http://$(compose port app 3000)" app
PROXY_URL="https://$(compose port nginx 443)"
wait_until_reachable "$PROXY_URL" nginx
# Production's restart policy would hide a crash on startup.
if [ "$(docker inspect -f '{{.RestartCount}}' "$CONTAINER")" != 0 ]; then
    echo "The app restarted on its own while starting" >&2
    compose logs --tail 50 app >&2
    exit 1
fi

# Added to whatever certificates NODE_EXTRA_CA_CERTS already adds, rather than replacing them.
CA_CERTS="${SCRATCH}/certs/origin.pem"
if [ -n "${NODE_EXTRA_CA_CERTS:-}" ]; then
    CA_CERTS="${SCRATCH}/certs/ca-bundle.pem"
    { cat "$NODE_EXTRA_CA_CERTS"; echo; cat "${SCRATCH}/certs/origin.pem"; } > "$CA_CERTS"
fi

export CONTAINER DB_CONTAINER PROXY_URL
export COMPOSE_PROJECT_NAME="$PROJECT"
export COMPOSE_FILE="${SCRATCH}/docker-compose.yml:${HERE}/stack.override.yml"
export NODE_EXTRA_CA_CERTS="$CA_CERTS"
status=0
"$@" || status=$?
# Restarting a container by hand (`docker restart`) resets its count, which is what lets the
# integration checks that restart the app pass this.
if [ "$status" -eq 0 ]; then
    for container in $(compose ps --all --quiet); do
        if [ "$(docker inspect -f '{{.RestartCount}}' "$container")" != 0 ]; then
            echo "A container restarted on its own" >&2
            compose logs --tail 50 >&2
            status=1
            break
        fi
    done
fi
exit "$status"

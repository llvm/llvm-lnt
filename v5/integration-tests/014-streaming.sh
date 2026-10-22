#!/usr/bin/env bash
#
# A series' status and headers reach the client before any of its data is read (I2), compressed or
# not, from the server and through the Nginx in front of it in production.
#
# The suite's sample table is locked while the series are requested, which holds back the first
# batch of every series but nothing before it. Each response must start while the lock is held,
# and end, complete, once it is released. Anything that holds a response until it has more of it
# -- the compression middleware holding the status until the body starts, Nginx's proxy buffering
# -- would leave it without a status line until then.

source "$(dirname "$0")/lib.sh"

# Its own key, like every check that needs one (see 010).
token="$(mint_key streaming manage)"
readonly AUTH="Authorization: Bearer ${token}"
readonly JSON='Content-Type: application/json'
readonly QUERY='machine=m&metric=execution_time'
# How the lock's session is found, to release it.
readonly LOCKER="lnt-v5-integration-streaming"

scratch="$(mktemp -d)"
requests=()

release_lock() {
    docker exec "$DB_CONTAINER" psql --quiet --no-align --tuples-only -U lnt -d lnt -c \
        "SELECT pg_cancel_backend(pid) FROM pg_stat_activity WHERE application_name = '${LOCKER}'" \
        >/dev/null
}

# Whatever happens, release the lock and stop the requests: a request left waiting on the lock
# would keep the server's graceful shutdown waiting, and fail 099.
cleanup() {
    release_lock || true
    if [ ${#requests[@]} -gt 0 ]; then kill "${requests[@]}" 2>/dev/null || true; fi
    wait || true
    rm -rf "$scratch"
}
trap cleanup EXIT

request -X POST -H "$AUTH" -H "$JSON" --data \
    '{"name": "streaming", "metrics": [{"name": "execution_time", "type": "real"}]}' \
    "${BASE_URL}/api/suites"
expect_status 201

request -X POST -H "$AUTH" -H "$JSON" --data '{
  "format_version": "5", "machine": {"name": "m"}, "commit": {"value": "c1", "ordinal": 1},
  "tests": [{"name": "a", "samples": [{"execution_time": 1}]},
            {"name": "b", "samples": [{"execution_time": 2}]},
            {"name": "c", "samples": [{"execution_time": 3}]}]}' \
    "${BASE_URL}/api/suites/streaming/runs"
expect_status 201

# The app may have been restarted by an earlier check (010), and Nginx may still be resolving its
# old address.
wait_for_health "$PROXY_URL"

# Held for at most 30 seconds, should this check die without releasing it.
docker exec --env PGAPPNAME="$LOCKER" "$DB_CONTAINER" psql --quiet -U lnt -d lnt -c \
    'BEGIN; LOCK TABLE streaming.sample IN ACCESS EXCLUSIVE MODE; SELECT pg_sleep(30); COMMIT;' \
    >/dev/null 2>&1 &
granted=""
for _ in $(seq 1 50); do
    granted="$(docker exec "$DB_CONTAINER" psql --no-align --tuples-only -U lnt -d lnt -c \
        "SELECT count(*) FROM pg_locks WHERE relation = 'streaming.sample'::regclass
         AND mode = 'AccessExclusiveLock' AND granted")"
    [ "$granted" = 1 ] && break
    sleep 0.2
done
if [ "$granted" != 1 ]; then
    echo "  expected the sample table to be locked" >&2
    exit 1
fi

echo "  every response starts while the series is held back"
readonly VARIANTS=(direct direct-gzip proxy proxy-gzip)
for variant in "${VARIANTS[@]}"; do
    case "$variant" in
        direct) base="$BASE_URL" encoding=--no-compressed ;;
        direct-gzip) base="$BASE_URL" encoding=--compressed ;;
        proxy) base="$PROXY_URL" encoding=--no-compressed ;;
        proxy-gzip) base="$PROXY_URL" encoding=--compressed ;;
    esac
    # The headers to a file of their own: curl writes them there as they come, whereas `--include`
    # holds them until the body starts.
    curl --silent --show-error --no-buffer --max-time 40 --insecure "$encoding" \
        --dump-header "${scratch}/${variant}.headers" --output "${scratch}/${variant}" \
        --write-out '%{http_code}' "${base}/api/suites/streaming/series?${QUERY}" \
        > "${scratch}/${variant}.status" &
    requests+=("$!")
done

for _ in $(seq 1 75); do
    waiting=()
    for variant in "${VARIANTS[@]}"; do
        grep -qs '^HTTP/' "${scratch}/${variant}.headers" || waiting+=("$variant")
    done
    [ ${#waiting[@]} -eq 0 ] && break
    sleep 0.2
done
if [ ${#waiting[@]} -gt 0 ]; then
    echo "  expected a status line while the series was held back, but got none for: ${waiting[*]}" >&2
    exit 1
fi

release_lock

echo "  and each ends, complete, once the series is read"
for i in "${!VARIANTS[@]}"; do
    variant="${VARIANTS[$i]}"
    status=0
    wait "${requests[$i]}" || status=$?
    STATUS="$(cat "${scratch}/${variant}.status")"
    HEADERS="$(cat "${scratch}/${variant}.headers")"
    BODY="$(cat "${scratch}/${variant}")"
    if [ "$status" -ne 0 ]; then
        echo "  ${variant}: expected curl to succeed, it exited with ${status}" >&2
        exit 1
    fi
    expect_status 200
    if [[ "$variant" == *-gzip ]]; then expect_header Content-Encoding gzip; fi
    if [ "$(printf '%s\n' "$BODY" | grep -c '"test":')" != 3 ]; then
        echo "  ${variant}: expected the series' three lines" >&2
        _show_body
        exit 1
    fi
done

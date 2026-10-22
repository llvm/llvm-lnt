#!/usr/bin/env bash
#
# The container stops promptly on SIGTERM, which is how Docker stops it (`docker stop`, `docker
# compose down`, and so a deploy, which replaces the instance), and on SIGINT, which is what Ctrl-C
# on an attached `docker run` sends. A server that ignored either would only be reaped after the
# runtime's shutdown grace period, which looks exactly like a hang during a deploy.
#
# Numbered last: this stops the server, so nothing can run against it afterwards.

source "$(dirname "$0")/lib.sh"

# Production's restart policy would bring it back up, unless Docker deems the signal a manual stop.
docker update --restart=no "$CONTAINER" >/dev/null

# stop_with <signal> -- send it to the server, and fail unless its container stops within 15s.
stop_with() {
    local start elapsed running
    start="$(date +%s)"
    docker kill --signal="$1" "$CONTAINER" >/dev/null
    for _ in $(seq 1 20); do
        [ "$(docker inspect -f '{{.State.Running}}' "$CONTAINER")" = "false" ] && break
        sleep 1
    done
    elapsed=$(( $(date +%s) - start ))
    running="$(docker inspect -f '{{.State.Running}}' "$CONTAINER")"
    echo "  stopped after ${elapsed}s on $1"
    if [ "$running" != "false" ] || [ "$elapsed" -ge 15 ]; then
        echo "  expected the container to stop within 15s (running=${running}, elapsed=${elapsed}s)" >&2
        exit 1
    fi
}

stop_with SIGTERM
restart_server
stop_with SIGINT

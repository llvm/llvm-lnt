#!/usr/bin/env bash
#
# The container stops promptly on SIGINT, which is what Ctrl-C on an attached `docker run`
# sends. A server that ignored it would only be reaped after the runtime's shutdown grace
# period, which looks exactly like a hang during a deploy.
#
# Numbered last: this stops the server, so nothing can run against it afterwards.

source "$(dirname "$0")/lib.sh"

start="$(date +%s)"
docker kill --signal=SIGINT "$CONTAINER" >/dev/null

for _ in $(seq 1 20); do
    [ "$(docker inspect -f '{{.State.Running}}' "$CONTAINER")" = "false" ] && break
    sleep 1
done

elapsed=$(( $(date +%s) - start ))
running="$(docker inspect -f '{{.State.Running}}' "$CONTAINER")"
echo "  stopped after ${elapsed}s"
if [ "$running" != "false" ] || [ "$elapsed" -ge 15 ]; then
    echo "  expected the container to stop within 15s (running=${running}, elapsed=${elapsed}s)" >&2
    exit 1
fi

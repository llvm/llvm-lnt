#!/usr/bin/env bash
#
# stop_postgres.sh <CONTAINER_NAME>
#
# Stop and remove a PostgreSQL container by name. Silently succeeds if the
# container does not exist or has already been removed.
#
set -euo pipefail

if [ $# -lt 1 ]; then
    echo 1>&2 "usage: $(basename "$0") <CONTAINER_NAME>"
    exit 1
fi

docker stop  "$1" > /dev/null 2>&1 || true
docker rm    "$1" > /dev/null 2>&1 || true

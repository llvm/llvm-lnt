#!/usr/bin/env bash
#
# Check that the server runs unprivileged, as the UID and GID the image creates for it.

source "$(dirname "$0")/lib.sh"

# The real, effective, saved and filesystem IDs of every process in the container: the server's,
# its workers' and the init's, and this command's own, which `docker exec` runs as the image's user.
ids="$(docker exec "$CONTAINER" sh -c \
    'for status in /proc/[0-9]*/status; do grep -E "^(Uid|Gid):" "$status"; done 2>/dev/null')"
printf '%s\n' "$ids" | sort | uniq -c | sed 's/^/  /'

if [ -z "$ids" ]; then
    echo "  expected to read the IDs of the container's processes" >&2
    exit 1
fi
if printf '%s\n' "$ids" | grep -Evq '^(Uid|Gid):[[:space:]]+10001[[:space:]]+10001[[:space:]]+10001[[:space:]]+10001$'; then
    echo "  expected every process to run as UID and GID 10001" >&2
    exit 1
fi

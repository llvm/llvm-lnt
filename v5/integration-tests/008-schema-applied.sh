#!/usr/bin/env bash
#
# Check that the server applies the global schema when it starts.

source "$(dirname "$0")/lib.sh"

output="$(docker exec "$CONTAINER" lnt-v5 server migrate)"
echo "  ${output}"

# Applying it a second time has to be a no-op: every start runs it.
if ! printf '%s' "$output" | grep -q "already up to date"; then
    echo "  expected the schema to already be up to date after startup" >&2
    exit 1
fi

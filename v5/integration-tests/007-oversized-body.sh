#!/usr/bin/env bash
#
# An oversized request body is refused rather than accepted or 500ed. run.sh starts the
# container with a lowered BODY_LIMIT so this can send 2 MB rather than 134 MB.
#
# Only the status is asserted. The body an oversized request comes back with is produced by the
# web framework rather than by our own error handling, so pinning its wording here would be
# testing the framework.

source "$(dirname "$0")/lib.sh"

big="$(mktemp)"
trap 'rm -f "$big"' EXIT
head -c 2000000 /dev/zero | tr '\0' 'x' > "$big"

request --header 'Content-Type: application/json' --data-binary "@${big}" "${BASE_URL}/api/anything"
expect_status 413

#!/usr/bin/env bash
#
# A content-hashed asset referenced by index.html is actually served. The asset path is resolved
# from index.html rather than hardcoded: it is the thing most likely to break when the image
# layout changes, and nothing else covers it.

source "$(dirname "$0")/lib.sh"

request "${BASE_URL}/"
expect_status 200
asset="$(printf '%s' "$BODY" | grep -o '/assets/[^"]*\.js' | head -1)"
if [ -z "$asset" ]; then
    echo "  no /assets/*.js reference found in index.html" >&2
    _show_body
    exit 1
fi
echo "  asset: $asset"

request "${BASE_URL}${asset}"
expect_status 200

# A hashed asset that does *not* exist stays a 404. Serving index.html under a script URL turns
# a stale deploy into a MIME-type error rather than a clean miss.
request "${BASE_URL}/assets/index-STALEHASH.js"
expect_status 404

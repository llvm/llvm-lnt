#!/usr/bin/env bash
#
# Compressed request bodies and responses (I4), with curl as a user would send them.
#
# In pytest too, but the image is what a client reaches: this checks that a gzip body a client
# compresses on its own arrives decoded, and that plain curl, which asks for no compression, still
# reads plain JSON.

source "$(dirname "$0")/lib.sh"

# Its own key, like every check that needs one (see 010).
token="$(mint_key compression manage)"
readonly AUTH="Authorization: Bearer ${token}"
readonly JSON='Content-Type: application/json'
readonly GZIP='Content-Encoding: gzip'
readonly RUNS="${BASE_URL}/api/suites/compression/runs"

scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT

request -X POST -H "$AUTH" -H "$JSON" --data \
    '{"name": "compression", "metrics": [{"name": "execution_time", "type": "real"}]}' \
    "${BASE_URL}/api/suites"
expect_status 201

echo "  a gzip-compressed submission is stored"
printf '%s' '{"format_version": "5", "machine": {"name": "m"}, "commit": {"value": "c"},
  "tests": [{"name": "bench", "samples": [{"execution_time": 1.5}]}]}' | gzip -c > "${scratch}/run.gz"
request -X POST -H "$AUTH" -H "$JSON" -H "$GZIP" --data-binary "@${scratch}/run.gz" "$RUNS"
expect_status 201
expect_body '"machine":"m"'

echo "  data that is not gzip is 400, and another coding is 415"
request -X POST -H "$AUTH" -H "$JSON" -H "$GZIP" --data-binary '{"format_version": "5"}' "$RUNS"
expect_status 400
expect_body '"code":"invalid_request"'

request -X POST -H "$AUTH" -H "$JSON" -H 'Content-Encoding: br' \
    --data-binary "@${scratch}/run.gz" "$RUNS"
expect_status 415
expect_body '"code":"unsupported_encoding"'
expect_header Accept-Encoding 'gzip'

echo "  a body that decompresses past BODY_LIMIT is 413, however small it is compressed"
# run.sh lowers BODY_LIMIT to 1 MiB; 4 MB of spaces compress to a few kilobytes.
{ printf '{"format_version": "5", "run_parameters": {"x": "'
  head -c 4000000 /dev/zero | tr '\0' ' '
  printf '"}}'; } | gzip -c > "${scratch}/bomb.gz"
request -X POST -H "$AUTH" -H "$JSON" -H "$GZIP" --data-binary "@${scratch}/bomb.gz" "$RUNS"
expect_status 413

echo "  plain curl gets an uncompressed response, and --compressed a gzip one"
request "${BASE_URL}/api/openapi.json"
expect_status 200
expect_body '"openapi"'
if printf '%s' "$HEADERS" | grep -iq '^content-encoding:'; then
    echo "  expected no Content-Encoding without Accept-Encoding" >&2
    exit 1
fi

request --compressed "${BASE_URL}/api/openapi.json"
expect_status 200
expect_header Content-Encoding 'gzip'
expect_header Vary '.*Accept-Encoding'
# curl decoded it.
expect_body '"openapi"'

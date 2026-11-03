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
readonly RUNS="${BASE_URL}/api/projects/compression/suites/compression/runs"

scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT

create_project compression "$AUTH"
request -X POST -H "$AUTH" -H "$JSON" --data \
    '{"name": "compression", "metrics": [{"name": "execution_time", "type": "real"}]}' \
    "${BASE_URL}/api/projects/compression/suites"
expect_status 201

printf '%s' '{"format_version": "5", "machine": {"name": "m"}, "commit": {"value": "c"},
  "tests": [{"name": "bench", "samples": [{"execution_time": 1.5}]}]}' > "${scratch}/run.json"
gzip -c "${scratch}/run.json" > "${scratch}/run.gz"

echo "  an uncompressed submission is still stored, as existing clients send it"
request -X POST -H "$AUTH" -H "$JSON" --data-binary "@${scratch}/run.json" "$RUNS"
expect_status 201
expect_body '"machine":"m"'

echo "  a gzip-compressed submission is stored"
request -X POST -H "$AUTH" -H "$JSON" -H "$GZIP" --data-binary "@${scratch}/run.gz" "$RUNS"
expect_status 201
expect_body '"machine":"m"'

echo "  a valid run that is not actually gzip-compressed is 400, and another coding is 415"
request -X POST -H "$AUTH" -H "$JSON" -H "$GZIP" --data-binary "@${scratch}/run.json" "$RUNS"
expect_status 400
expect_body '"code":"invalid_request"'
expect_body 'cannot be decoded'

request -X POST -H "$AUTH" -H "$JSON" -H 'Content-Encoding: br' \
    --data-binary "@${scratch}/run.gz" "$RUNS"
expect_status 415
expect_body '"code":"unsupported_encoding"'
expect_header Accept-Encoding 'gzip'

echo "  a body that decompresses past BODY_LIMIT is 413, however small it is compressed"
# `npm run test:integration` lowers BODY_LIMIT to 1 MiB (see run.sh); 4 MB of spaces compress to a
# few kilobytes.
{ printf '{"format_version": "5", "run_parameters": {"x": "'
  head -c 4000000 /dev/zero | tr '\0' ' '
  printf '"}}'; } | gzip -c > "${scratch}/bomb.gz"
request -X POST -H "$AUTH" -H "$JSON" -H "$GZIP" --data-binary "@${scratch}/bomb.gz" "$RUNS"
expect_status 413
expect_header Content-Type 'text/plain'

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

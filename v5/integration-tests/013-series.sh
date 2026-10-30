#!/usr/bin/env bash
#
# A machine's series (E9's `GET /series`), streamed as NDJSON, with curl as a tool would read it.
#
# In pytest too, but only a real HTTP server frames a streamed body: here it is sent in chunks,
# compressed or not, and reads back the same either way.

source "$(dirname "$0")/lib.sh"

# Its own key, like every check that needs one (see 010).
token="$(mint_key series manage)"
readonly AUTH="Authorization: Bearer ${token}"
readonly JSON='Content-Type: application/json'
readonly SERIES="${BASE_URL}/api/projects/series/suites/series/series"

create_project series "$AUTH"
request -X POST -H "$AUTH" -H "$JSON" --data \
    '{"name": "series", "metrics": [{"name": "execution_time", "type": "real"}]}' \
    "${BASE_URL}/api/projects/series/suites"
expect_status 201

# Submitted newest first, so that the order of the series is the server's doing.
for ordinal in 2 1; do
    request -X POST -H "$AUTH" -H "$JSON" --data "{
      \"format_version\": \"5\", \"machine\": {\"name\": \"m\"},
      \"commit\": {\"value\": \"c${ordinal}\", \"ordinal\": ${ordinal}},
      \"tests\": [{\"name\": \"b\", \"samples\": [{\"execution_time\": ${ordinal}.5}]},
                {\"name\": \"a\", \"samples\": [{\"execution_time\": ${ordinal}}]}]}" \
        "${BASE_URL}/api/projects/series/suites/series/runs"
    expect_status 201
done

echo "  the series is chunked NDJSON, by test and then by ordinal"
request -G --data-urlencode machine=m --data-urlencode metric=execution_time "$SERIES"
expect_status 200
expect_header Content-Type 'application/x-ndjson'
expect_header Transfer-Encoding 'chunked'
order="$(printf '%s\n' "$BODY" | sed -E 's/.*"test":"([^"]*)".*"commit":"([^"]*)".*/\1 \2/')"
if [ "$order" != "$(printf 'a c1\na c2\nb c1\nb c2')" ]; then
    echo "  expected four lines in series order" >&2
    _show_body
    exit 1
fi
plain="$BODY"

echo "  --compressed gets it gzip-compressed, and the same once decoded"
request --compressed -G --data-urlencode machine=m --data-urlencode metric=execution_time "$SERIES"
expect_status 200
expect_header Content-Encoding 'gzip'
if [ "$BODY" != "$plain" ]; then
    echo "  expected the same series compressed or not" >&2
    _show_body
    exit 1
fi

echo "  an unknown machine is a JSON 404, before anything is streamed"
request -G --data-urlencode machine=nope --data-urlencode metric=execution_time "$SERIES"
expect_status 404
expect_header Content-Type 'application/json'
expect_body '"code":"not_found"'

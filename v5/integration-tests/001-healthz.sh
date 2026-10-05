#!/usr/bin/env bash
#
# I7: /healthz answers {"ok": true} when the server can reach the database. It is an
# infrastructure probe, deliberately outside the REST API surface, so it must not come back
# wrapped in the I4 error envelope.

source "$(dirname "$0")/lib.sh"

request "${BASE_URL}/healthz"
expect_status 200
expect_body '"ok"[[:space:]]*:[[:space:]]*true'

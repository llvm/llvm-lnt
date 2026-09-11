#!/usr/bin/env bash
#
# An unmatched /api/... path is a genuine 404 and must answer with the JSON error envelope
# rather than falling through to the client. Serving index.html here would turn a typo in an
# API path into a page of HTML that a client parses as a failed request.

source "$(dirname "$0")/lib.sh"

request "${BASE_URL}/api/does-not-exist"
expect_status 404
expect_body '"code":"not_found"'

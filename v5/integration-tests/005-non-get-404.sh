#!/usr/bin/env bash
#
# The client fallback only answers GET and HEAD. A POST to a client route is "nothing here"
# rather than a method mismatch: I4's 405 is for the API alone.

source "$(dirname "$0")/lib.sh"

request --request POST "${BASE_URL}/suites/nts"
expect_status 404
expect_body '"code":"not_found"'

# An API path that exists for other methods is a 405, naming every method it does serve.
request --request PUT "${BASE_URL}/api/suites"
expect_status 405
expect_body '"code":"method_not_allowed"'
expect_header Allow 'GET, POST'

# HEAD on a client route is answered like GET, minus the body.
request --head "${BASE_URL}/suites/nts"
expect_status 200
expect_header Content-Type 'text/html'

# HEAD on an API path is a 404 rather than a 405: no API endpoint serves it (I4).
request --head "${BASE_URL}/api/suites"
expect_status 404

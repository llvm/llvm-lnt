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

# HEAD should be answered exactly like GET, but that is deliberately not asserted here yet: the
# current server tests `method !== 'GET'` and so 404s every HEAD request. Add the assertion
# together with the fix.

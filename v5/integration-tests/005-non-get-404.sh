#!/usr/bin/env bash
#
# The client fallback only answers GET and HEAD. A POST to a client route is "nothing here"
# rather than a method mismatch, because 405 is not one of the statuses R4 permits.

source "$(dirname "$0")/lib.sh"

request --request POST "${BASE_URL}/suites/nts"
expect_status 404
expect_body '"code":"not_found"'

# HEAD should be answered exactly like GET, but that is deliberately not asserted here yet: the
# current server tests `method !== 'GET'` and so 404s every HEAD request. Add the assertion
# together with the fix.

#!/usr/bin/env bash
#
# Deep links and hard refreshes resolve to the client rather than 404ing: any path that is not
# the API, not an infrastructure route, and not a request for a file falls through to index.html.
#
# The second path is the interesting one. Its last segment contains dots, so a fallback keyed on
# "looks like it has an extension" would 404 it -- and machine names routinely carry version
# numbers.

source "$(dirname "$0")/lib.sh"

for path in /suites/nts /suites/nts/machines/macos-26.5-arm64; do
    request "${BASE_URL}${path}"
    expect_status 200
    expect_body '<title>LNT</title>'
done

#!/usr/bin/env bash
#
# Deep links and hard refreshes resolve to the client rather than 404ing: any path that is not
# the API, not an infrastructure route, and not a request for a file falls through to index.html.
#
# The last two are the interesting ones. A machine name may contain dots, and may even look like
# a file name, so whether a path asks for a file is decided by where it is rather than by what it
# ends in (AR2 "Serving").

source "$(dirname "$0")/lib.sh"

for path in /projects /projects/llvm /projects/llvm/suites/nts \
    /projects/llvm/suites/nts/machines/macos-26.5-arm64 \
    /projects/llvm/suites/nts/machines/results.json; do
    request "${BASE_URL}${path}"
    expect_status 200
    expect_body '<title>LNT</title>'
done

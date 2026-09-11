#!/usr/bin/env bash
#
# The image serves the built client at the root. This is what proves the client bundle actually
# made it into the image, rather than the server coming up with nothing to serve.

source "$(dirname "$0")/lib.sh"

request "${BASE_URL}/"
expect_status 200
expect_body '<title>LNT</title>'

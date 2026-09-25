#!/usr/bin/env bash
#
# `/llms.txt` is served by the image (R6).
#
# The point of checking it here rather than only in pytest: the document is a data file inside the
# package, not a Python string, so the in-process suite reads it straight out of the source tree
# and would pass even if the wheel the image installs did not contain it. Everything else about
# the route -- that it never authenticates, that it is out of the OpenAPI document -- is in-process
# behaviour and is covered there.

source "$(dirname "$0")/lib.sh"

echo "  it is served as UTF-8 plain text, with its links intact"
request "${BASE_URL}/llms.txt"
expect_status 200
expect_header Content-Type 'text/plain; ?charset=utf-8'
expect_body '^# LNT v5'
expect_body '/api/openapi.json'

echo "  a trailing slash redirects to the canonical path"
request "${BASE_URL}/llms.txt/"
expect_status 307
expect_header Location '.*/llms\.txt$'

#!/usr/bin/env bash
#
# The API index reports the revision the image was built from (E1), the LNT_REVISION build argument
# that is also its OCI label. A revision is required, so that a CI build that stops passing the
# argument fails here.

source "$(dirname "$0")/lib.sh"

revision="$(docker inspect -f '{{index .Config.Labels "org.opencontainers.image.revision"}}' \
    "$CONTAINER")"
if [ -z "$revision" ]; then
    echo "  the image has no revision: build it with --build-arg LNT_REVISION=<commit>" >&2
    exit 1
fi

echo "  GET /api reports the image's revision, ${revision}"
request "${BASE_URL}/api"
expect_status 200
expect_body "\"revision\":\"${revision}\""

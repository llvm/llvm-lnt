#!/usr/bin/env bash
#
# with_postgres.sh <LOG_FILE> <command> [args...]
#
# Start a fresh PostgreSQL container, run the wrapped command, then stop and
# remove the container. The following environment variables are exported before
# the command runs:
#
#   LNT_TEST_DB_URI      Base connection URL (no database), e.g. postgresql://postgres@127.0.0.1:PORT
#   LNT_TEST_DB_NAME     Name of a ready-to-use database ("lnt_test")
#
# Example:
#   with_postgres.sh /tmp/my.log bash my_test.sh "${LNT_TEST_DB_URI}" "${LNT_TEST_DB_NAME}"
#
set -euo pipefail

# ---------------------------------------------------------------------------
# Arguments
# ---------------------------------------------------------------------------
if [ $# -lt 2 ]; then
    echo 1>&2 "usage: $(basename "$0") <LOG_FILE> <command> [args...]"
    exit 1
fi

LOG_FILE="$1"
shift

if [ -f "${LOG_FILE}" ]; then
    echo 1>&2 "error: Log file ${LOG_FILE} already exists"
    exit 1
fi

# ---------------------------------------------------------------------------
# Start the container via start_postgres.sh (sourced so variables are set
# directly in this shell).
# ---------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "${SCRIPT_DIR}/start_postgres.sh" "${LOG_FILE}"
export LNT_TEST_DB_URI LNT_TEST_DB_NAME

# ---------------------------------------------------------------------------
# Cleanup — always stop and remove the container, success or failure.
# ---------------------------------------------------------------------------
cleanup() {
    local exit_code=$?
    echo "Stopping container ${LNT_PG_CONTAINER} ..."
    "${SCRIPT_DIR}/stop_postgres.sh" "${LNT_PG_CONTAINER}"
    exit "${exit_code}"
}
trap cleanup EXIT

# ---------------------------------------------------------------------------
# Run the wrapped command.
# ---------------------------------------------------------------------------
"$@"

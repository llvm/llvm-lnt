#!/bin/sh
# Setup minimalistic postgres instance in specified directory, start a server,
# run the given command and shutdown the server. Use
# `postgresql://pgtest@localhost:9100` to connect to the server.
#
# Example:
# ./postgres_wrapper /tmp/myinstance 'createdb --maintenance-db=postgresql://pgtest@localhost:9100/postgres mydb; psql postgresql://pgtest@localhost:9100/mydb -c \"CREATE TABLE foo (id integer);\"'
#
# Inspired by https://github.com/tk0miya/testing.postgresql
set -u
TEST_DIR=$1
shift
DB_DIR="$(mktemp -d -t lnt)"
if [ -d "${TEST_DIR}" ]; then
    echo 1>&2 "${TEST_DIR} already exists"
    exit 1
fi

mkdir -p "${TEST_DIR}"
ln -s ${TEST_DIR}/db_root ${DB_DIR}

INITDB_FLAGS+=" --pgdata=${DB_DIR}/db"
INITDB_FLAGS+=" --xlogdir=${DB_DIR}/db"
INITDB_FLAGS+=" --nosync"
INITDB_FLAGS+=" --no-locale"
INITDB_FLAGS+=" --auth=trust"
INITDB_FLAGS+=" --username=pgtest"
echo "$ initdb $INITDB_FLAGS >& ${DB_DIR}/initdb_log.txt"
initdb ${INITDB_FLAGS} >& ${DB_DIR}/initdb_log.txt

POSTGRES_FLAGS+=" -p 9100"
POSTGRES_FLAGS+=" -D ${DB_DIR}/db"
POSTGRES_FLAGS+=" -k ${DB_DIR}/db"
POSTGRES_FLAGS+=" -h 127.0.0.1"
POSTGRES_FLAGS+=" -F"
POSTGRES_FLAGS+=" -c logging_collector=off"
echo "$ postgres $POSTGRES_FLAGS >& ${DB_DIR}/server_log.txt"
postgres ${POSTGRES_FLAGS} >& ${DB_DIR}/server_log.txt &
PG_PID=$!
sleep 1 # Give the server time to start.

# Execute command
eval "$@"
RC=$?

# Kill server
kill -15 ${PG_PID}
[ $? -ne 0 ] && (echo 1>&1 "Error: Could not kill postgres server"; exit 1)
wait ${PG_PID}
[ ${RC} -ne 0 ] && (rm -rf ${DB_DIR})
exit ${RC}


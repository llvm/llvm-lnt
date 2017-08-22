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

DBDIR="$(mktemp -d -t lnt)"
shift
if [ -d "${DBDIR}" ]; then
    echo 1>&2 "${DBDIR} already exists"
    exit 1
fi

mkdir -p "${DBDIR}"

INITDB_FLAGS+=" --pgdata=$DBDIR/db"
INITDB_FLAGS+=" --xlogdir=$DBDIR/db"
INITDB_FLAGS+=" --nosync"
INITDB_FLAGS+=" --no-locale"
INITDB_FLAGS+=" --auth=trust"
INITDB_FLAGS+=" --username=pgtest"
echo "$ initdb $INITDB_FLAGS >& $DBDIR/initdb_log.txt"
initdb $INITDB_FLAGS >& $DBDIR/initdb_log.txt

POSTGRES_FLAGS+=" -p 9100"
POSTGRES_FLAGS+=" -D $DBDIR/db"
POSTGRES_FLAGS+=" -k $DBDIR/db"
POSTGRES_FLAGS+=" -h 127.0.0.1"
POSTGRES_FLAGS+=" -F"
POSTGRES_FLAGS+=" -c logging_collector=off"
echo "$ postgres $POSTGRES_FLAGS >& $DBDIR/server_log.txt"
postgres $POSTGRES_FLAGS >& $DBDIR/server_log.txt &
PG_PID=$!
sleep 1 # Give the server time to start.

# Execute command
eval "$@"
RC=$?

# Kill server
kill -15 $PG_PID
[ $? -ne 0 ] && (echo 1>&1 "Could not kill postgres server"; exit 1)
wait $PG_PID
exit $RC
rm -rf ${DBDIR}

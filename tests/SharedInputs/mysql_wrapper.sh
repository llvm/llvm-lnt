#!/bin/sh
# This works like postgres_wrapper.sh but for mysql.
#
# This will bind to localhost on the specified port. There is a database
# called testdb; user 'root' can login without a password.
#
# Example:
# ./mysql_wrapper /tmp/myinstance 9101 mysql -u root -P 9101 testdb
#
# Inspired by https://github.com/tk0miya/testing.mysqld
set -eu

DBDIR="$1"
shift
if [ -d "${DBDIR}" ]; then
    echo 1>&2 "${DBDIR} already exists"
    exit 1
fi
PORT="$1"
shift

mkdir -p "${DBDIR}"
mkdir -p "${DBDIR}/etc"
mkdir -p "${DBDIR}/data"
cat > "${DBDIR}/etc/my.cnf" << __EOF__
[mysqld]
bind-address = 127.0.0.1
port = ${PORT}
user = $(whoami)
__EOF__

MYSQL_INSTALL_DB_FLAGS+=" --defaults-file=\"${DBDIR}/etc/my.cnf\""
MYSQL_INSTALL_DB_FLAGS+=" --initialize-insecure"
MYSQL_INSTALL_DB_FLAGS+=" --user=$(whoami)"
MYSQL_INSTALL_DB_FLAGS+=" --datadir=\"${DBDIR}/data\""
MYSQL_INSTALL_DB_FLAGS+=" >& \"${DBDIR}/install_db.log\""
#echo "$ mysql_install_db ${MYSQL_INSTALL_DB_FLAGS}"
#eval mysql_install_db ${MYSQL_INSTALL_DB_FLAGS}
echo "$ mysqld ${MYSQL_INSTALL_DB_FLAGS}"
eval mysqld ${MYSQL_INSTALL_DB_FLAGS}


MYSQLD_FLAGS+=" --defaults-file=\"${DBDIR}/etc/my.cnf\""
MYSQLD_FLAGS+=" --datadir=\"${DBDIR}/data\""
MYSQLD_FLAGS+=" --pid-file=\"${DBDIR}/mysqld.pid\""
MYSQLD_FLAGS+=" --log-error=\"${DBDIR}/mysqld.error.log\""
MYSQLD_FLAGS+="&"
echo "$ mysqld ${MYSQLD_FLAGS}"
eval mysqld ${MYSQLD_FLAGS}

MYSQLADMIN_FLAGS+=" --defaults-file=\"${DBDIR}/etc/my.cnf\""
MYSQLADMIN_FLAGS+=" -h 127.0.0.1"
MYSQLADMIN_FLAGS+=" -P ${PORT}"
MYSQLADMIN_FLAGS+=" -u root"

#  Poll server for 10 seconds to see when it is up.
set +e
for i in {1..100}
do
    sleep 0.1
    echo "$ mysqladmin ${MYSQLADMIN_FLAGS} status"
    eval mysqladmin ${MYSQLADMIN_FLAGS} status
    if [ $? -eq 0 ]; then
        break
    fi
done
set -e

set +e
# This may not be there if the test has not been run before.
echo "$ mysqladmin ${MYSQLADMIN_FLAGS} drop testdb"
eval mysqladmin ${MYSQLADMIN_FLAGS} drop --force testdb
set -e

echo "$ mysqladmin ${MYSQLADMIN_FLAGS} create testdb"
eval mysqladmin ${MYSQLADMIN_FLAGS} create testdb


# Execute command
eval "$@"
RC=$?

# Kill server
MYSQLD_PID="$(cat "${DBDIR}/mysqld.pid")"
kill -15 ${MYSQLD_PID}
[ $? -ne 0 ] && (echo 1>&1 "Could not kill mysql server"; exit 1)
wait "${MYSQLD_PID}"
exit $RC

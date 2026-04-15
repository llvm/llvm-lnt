#!/bin/sh

set -u

password="$(cat ${DB_PASSWORD_FILE})"
token="$(cat ${AUTH_TOKEN_FILE})"
DB_PATH="postgres://${DB_USER}:${password}@${DB_HOST}"

INSTANCE_DIR=/var/lib/lnt/instance

# Set up the instance the first time this gets run.
if [ ! -e "${INSTANCE_DIR}/lnt.cfg" ]; then
    lnt-wait-db "${DB_PATH}/${DB_NAME}"
    lnt create "${INSTANCE_DIR}"         \
        --wsgi lnt_wsgi.py               \
        --tmp-dir /tmp/lnt               \
        --db-dir "${DB_PATH}"            \
        --default-db "${DB_NAME}"        \
        --api-auth-token "${token}"      \
        --db-version 5.0
fi

# Run the server under gunicorn.
cd "${INSTANCE_DIR}"
exec gunicorn lnt_wsgi:application                      \
    --bind 0.0.0.0:8000                                 \
    --workers "${GUNICORN_WORKERS:-8}"                   \
    --timeout 300                                       \
    --name lnt_server                                   \
    --access-logfile -                                  \
    --max-requests 250000

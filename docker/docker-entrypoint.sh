#!/bin/sh

if [ -z ${DB_USER+x} ]; then
    echo "Missing DB_USER environment variable"
    exit 1
fi

if [ -z ${DB_HOST+x} ]; then
    echo "Missing DB_HOST environment variable"
    exit 1
fi

if [ -z ${DB_NAME+x} ]; then
    echo "Missing DB_NAME environment variable"
    exit 1
fi

if [ ! -f /run/secrets/lnt-db-password ]; then
    echo "Missing secret lnt-db-password"
    exit 1
fi
DB_PASSWORD="$(cat /run/secrets/lnt-db-password)"

if [ ! -f /run/secrets/lnt-auth-token ]; then
    echo "Missing secret lnt-auth-token"
    exit 1
fi
AUTH_TOKEN="$(cat /run/secrets/lnt-auth-token)"

DB_PATH="postgres://${DB_USER}:${DB_PASSWORD}@${DB_HOST}"

# Set up the instance the first time this gets run.
if [ ! -e /var/lib/lnt/instance/lnt.cfg ]; then
    lnt-wait-db "${DB_PATH}/${DB_NAME}"
    lnt create /var/lib/lnt/instance    \
        --wsgi lnt_wsgi.py              \
        --tmp-dir /tmp/lnt              \
        --db-dir "${DB_PATH}"           \
        --default-db "${DB_NAME}"
    sed -i "s/# \(api_auth_token =\).*/\1 '${AUTH_TOKEN}'/" /var/lib/lnt/instance/lnt.cfg
fi

# Run the server under gunicorn.
cd /var/lib/lnt/instance
exec gunicorn lnt_wsgi:application                      \
    --bind 0.0.0.0:8000                                 \
    --workers 8                                         \
    --timeout 300                                       \
    --name lnt_server                                   \
    --log-file /var/log/lnt/lnt.log                     \
    --access-logfile /var/log/lnt/gunicorn_access.log   \
    --max-requests 250000

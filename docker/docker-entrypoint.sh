#!/bin/sh

set -u

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

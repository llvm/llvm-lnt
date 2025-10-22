#!/bin/sh

DB_PATH=${DB_ENGINE:-postgresql}://${DB_USER:-lntuser}:${DB_PWD:?}@${DB_HOST:?}
DB_BASE=${DB_BASE:-lnt}

if [ ! -r /etc/lnt/lnt.cfg ]; then
    DB_BASE_PATH="${DB_PATH}/${DB_BASE}" wait_db
    lnt create /var/lib/lnt/instance    \
        --config /etc/lnt/lnt.cfg       \
        --wsgi lnt_wsgi.py              \
        --tmp-dir /tmp/lnt              \
        --db-dir "${DB_PATH}"           \
        --default-db "${DB_BASE}"
    if [ -n "${LNT_AUTH_TOKEN:-}" ]; then
        sed -i "s/# \(api_auth_token =\).*/\1 '${LNT_AUTH_TOKEN}'/" /etc/lnt/lnt.cfg
    fi
fi

cd /var/lib/lnt/instance
exec gunicorn lnt_wsgi:application                      \
    --bind 0.0.0.0:8000                                 \
    --workers 8                                         \
    --timeout 300                                       \
    --name lnt_server                                   \
    --log-file /var/log/lnt/lnt.log                     \
    --access-logfile /var/log/lnt/gunicorn_access.log   \
    --max-requests 250000 "$@"

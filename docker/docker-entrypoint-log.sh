#!/bin/sh

# This is the actual entrypoint script, which ensures that we can find the
# logs of the real entrypoint script in /var/log.
docker-entrypoint.sh 2>&1 | tee /var/log/lnt/entrypoint.log

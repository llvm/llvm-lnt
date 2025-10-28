# This Dockerfile defines an image that contains a production LNT server.
# This image is intended to be built from a Docker Compose file, as it
# requires additional information passed as build arguments:
#
#   ARG DB_USER
#     The username to use for logging into the database.
#
#   ARG DB_HOST
#     The hostname to use to access the database.
#
#   ARG DB_NAME
#     The name of the database on the server.
#
#   ARG DB_PASSWORD
#     The password to use for logging into the database.
#
#   ARG AUTH_TOKEN
#     The authentication token used to require authentication
#     to perform destructive actions.

FROM python:3.10-alpine

# Install dependencies
RUN apk update \
  && apk add --no-cache --virtual .build-deps git g++ postgresql-dev yaml-dev \
  && apk add --no-cache libpq

# Install LNT itself, without leaving behind any sources inside the image.
RUN --mount=type=bind,source=.,target=./lnt-source \
    cp -R lnt-source /tmp/lnt-src && \
    cd /tmp/lnt-src && \
    pip3 install -r requirements.server.txt && apk --purge del .build-deps && \
    rm -rf /tmp/lnt-src

# Prepare volumes that will be used by the server
VOLUME /var/lib/lnt /var/log/lnt

# Set up the actual entrypoint that gets run when the container starts.
COPY docker/docker-entrypoint.sh docker/lnt-wait-db /usr/local/bin/
ARG DB_USER DB_HOST DB_NAME DB_PASSWORD AUTH_TOKEN
ENV DB_USER=${DB_USER}
ENV DB_HOST=${DB_HOST}
ENV DB_NAME=${DB_NAME}
ENV DB_PASSWORD=${DB_PASSWORD}
ENV AUTH_TOKEN=${AUTH_TOKEN}
ENTRYPOINT ["docker-entrypoint.sh"]
EXPOSE 8000

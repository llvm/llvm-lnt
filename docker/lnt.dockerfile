# This Dockerfile defines an image that contains a production LNT server.
# It requires additional information passed as environment variables:
#
#   DB_USER
#     The username to use for logging into the database.
#
#   DB_HOST
#     The hostname to use to access the database.
#
#   DB_NAME
#     The name of the database on the server.
#
#   DB_PASSWORD_FILE
#     File containing the password to use for logging into the database.
#
#   AUTH_TOKEN_FILE
#     File containing the authentication token used to require authentication
#     to perform destructive actions.
#
# It also stores information in the following volumes:
#
#   /var/lib/lnt
#     The actual LNT instance data (schema files, configuration files, etc).
#
#   /var/log/lnt
#     Log files for the instance.
#

FROM python:3.10-alpine

COPY pyproject.toml .
COPY lnt/testing/profile lnt/testing/profile

# Install dependencies and build cperf ext-modules.
# Need to temporarily mount .git for sourcetools-scm.
RUN --mount=source=.git,target=.git,type=bind \
  apk update \
  && apk add --no-cache --virtual .build-deps g++ postgresql-dev yaml-dev \
  && apk add --no-cache git libpq \
  && pip install ".[server]" \
  && apk --purge del .build-deps

# Copy over sources and install LNT.
COPY . .
RUN pip install .

# Prepare volumes that will be used by the server
VOLUME /var/lib/lnt /var/log/lnt

# Set up the actual entrypoint that gets run when the container starts.
COPY docker/docker-entrypoint.sh docker/docker-entrypoint-log.sh docker/lnt-wait-db /usr/local/bin/
ENTRYPOINT ["docker-entrypoint-log.sh"]
EXPOSE 8000

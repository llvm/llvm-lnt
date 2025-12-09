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

FROM python:3.10-alpine AS builder

# Install build dependencies
RUN apk update && apk add --no-cache g++ postgresql-dev yaml-dev git libpq
# Fake a version for setuptools so we don't need to COPY .git
ENV SETUPTOOLS_SCM_PRETEND_VERSION=0.1
COPY pyproject.toml .
# pip will build cperf ext-modules so COPY over its sources
COPY lnt/testing/profile lnt/testing/profile
RUN pip install --user ".[server]"

# Copy over sources and install LNT
# Let setuptools_scm use .git to pick the version again
ENV SETUPTOOLS_SCM_PRETEND_VERSION=
COPY . .
RUN pip install --user .

FROM python:3.10-alpine AS final

# Install runtime dependencies
RUN apk update && apk add --no-cache libpq

COPY --from=builder /root/.local /root/.local

# Prepare volumes that will be used by the server
VOLUME /var/lib/lnt /var/log/lnt

# Set up the actual entrypoint that gets run when the container starts.
COPY docker/docker-entrypoint.sh docker/docker-entrypoint-log.sh docker/lnt-wait-db /usr/local/bin/
ENV PATH=/root/.local/bin:$PATH
ENTRYPOINT ["docker-entrypoint-log.sh"]
EXPOSE 8000

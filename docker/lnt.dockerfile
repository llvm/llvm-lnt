# This Dockerfile defines a basic 'llvm-lnt' image that contains an installed
# copy of LNT. That image can be built and run with:
#
#   $ docker build --file docker/lnt.dockerfile --target llvm-lnt .
#   $ docker run -it <sha> /bin/sh
#
# It also defines a 'llvm-lnt-prod' image which is set up to run a production
# LNT server. This image is intended to be built from a Docker Compose file,
# as it requires additional information like secrets and build arguments:
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
#   secret: lnt-db-password
#     The password to use for logging into the database.
#
#   secret: lnt-auth-token
#     The authentication token used to require authentication to
#     perform destructive actions.

FROM python:3.10-alpine AS llvm-lnt

# Install dependencies
RUN apk update \
  && apk add --no-cache --virtual .build-deps git g++ postgresql-dev yaml-dev \
  && apk add --no-cache libpq

# Install LNT itself
COPY . /var/tmp/lnt
WORKDIR /var/tmp/lnt
RUN pip3 install -r requirements.server.txt && apk --purge del .build-deps


FROM llvm-lnt AS llvm-lnt-prod

# Prepare volumes that will be used by the server
VOLUME /var/lib/lnt /var/log/lnt

# Set up the actual entrypoint that gets run when the container starts.
COPY docker/docker-entrypoint.sh docker/lnt-wait-db /usr/local/bin/
ARG DB_USER DB_HOST DB_NAME
ENV DB_USER=${DB_USER}
ENV DB_HOST=${DB_HOST}
ENV DB_NAME=${DB_NAME}
ENTRYPOINT ["docker-entrypoint.sh"]
EXPOSE 8000

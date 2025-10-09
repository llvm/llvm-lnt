FROM python:3.10-alpine

RUN apk update \
  && apk add --no-cache --virtual .build-deps git g++ postgresql-dev yaml-dev \
  && apk add --no-cache libpq

WORKDIR /var/src/lnt

COPY requirements*.txt setup.py .
# setup.py uses lnt.__version__ etc.
COPY lnt/__init__.py lnt/__init__.py
# we build the cperf extension during install
COPY lnt/testing/profile lnt/testing/profile

RUN pip3 install -r requirements.server.txt \
  && apk --purge del .build-deps \
  && mkdir /var/log/lnt

COPY . .
COPY docker/docker-entrypoint.sh docker/wait_db /usr/local/bin/

VOLUME /var/log

EXPOSE 8000

ENV DB_ENGINE= DB_HOST= DB_USER= DB_PWD= DB_BASE=

ENTRYPOINT docker-entrypoint.sh

FROM python:2.7-alpine

RUN apk update \
  && apk add --no-cache --virtual .build-deps git g++ postgresql-dev yaml-dev \
  && apk add --no-cache libpq \
  && git clone https://git.llvm.org/git/lnt /var/src/lnt \
  && python /var/src/lnt/setup.py install --server \
  && rm -rf /var/src \
  && apk --purge del .build-deps \
  && mkdir /var/log/lnt

COPY docker-entrypoint.sh wait_db /usr/local/bin/

VOLUME /var/log

EXPOSE 8000

ENV DB_ENGINE= DB_HOST= DB_USER= DB_PWD= DB_BASE=

ENTRYPOINT docker-entrypoint.sh

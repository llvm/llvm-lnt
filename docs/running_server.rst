.. _running_server:

Running a LNT Server
====================

We provide a Docker Compose service that brings up a LNT web server attached
to a Postgres database. To start the server, run::

   docker compose -f docker/compose.yaml --env-file docker/dev.env up

Once the server is running, you are ready to submit data to it. See the section
on :ref:`importing data <importing_data>` for details.

The ``dev.env`` file provides default secrets suitable for local use. For your
own deployment, create an env file with your own values for ``LNT_DB_PASSWORD``
and ``LNT_AUTH_TOKEN``. Refer to the Docker Compose file for all available
environment variables.

Adding an Nginx Reverse Proxy
-----------------------------

To add an Nginx reverse proxy in front of the webserver (as done for the
lnt.llvm.org deployment), use the ``nginx`` profile::

   docker compose -f docker/compose.yaml --profile nginx --env-file <env-file> up

This starts the Nginx service on port 80 (configurable via
``LNT_NGINX_EXTERNAL_PORT``) in addition to the database and webserver.

Server Architecture
-------------------

The LNT web app is implemented as a Flask WSGI web app, with Jinja2 for the
templating engine. The database layer uses SQLAlchemy for its ORM, backed by
Postgres.

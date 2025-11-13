.. _running_server:

Running a LNT Server
====================

Running a LNT server locally is easy and can be sufficient for basic tasks. To do
so:

#. Install ``lnt`` as explained in the :ref:`installation section <installation>`.

#. Create a LNT installation::

    lnt create path/to/installation

   This will create the LNT configuration file and the default database at the
   specified path.

#. You can then run the server on that installation::

    lnt runserver path/to/installation

   Note that running the server in this way is not recommended for production, since
   this server is single-threaded and uses a SQLite database.

#. You are now ready to submit data to the server. See the section on :ref:`importing data <importing_data>`
   for details.

#. While the above is enough for most use cases, you can also customize your installation.
   To do so, edit the generated ``lnt.cfg``, for example to:

   a. Update the databases list.
   b. Update the public URL the server is visible at.
   c. Update the ``nt_emailer`` configuration.


Server Architecture
-------------------

The LNT web app is currently implemented as a Flask WSGI web app, with Jinja2
for the templating engine. The hope is to eventually move to a more AJAXy web
interface. The database layer uses SQLAlchemy for its ORM, and is typically
backed by SQLite or Postgres.

Running a Production Server on Docker
-------------------------------------

We provide a Docker Compose service that can be used to easily bring up a fully working
production server within minutes. The service can be built and run with::

   docker compose --file docker/compose.yaml --env-file <env-file> up

``<env-file>`` should be the path to a file containing environment variables
required by the containers. Please refer to the Docker Compose file for details.
This service runs a LNT production web server attached to a Postgres database.
For production use, we recommend using this service and tweaking the desired
aspects in your custom setup (for example redirecting ports or changing volume
binds).

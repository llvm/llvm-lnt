.. _migrating_to_v5:

Migrating to v5
===============

LNT v5 is a redesign of LNT whose database, REST API and web UI are not
compatible with v4's. Data held by a v4 instance is moved to a v5 instance in
two steps: ``lnt mirror-v4`` first copies the data of a v4 instance into a local
directory through its REST API, and ``lnt v5 import-v4-mirror`` then imports
that copy into a v5 instance.

.. toctree::
   :maxdepth: 1

   mirror_v4

   import_v4_mirror

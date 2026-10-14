.. _migrating_to_v5:

Migrating to v5
===============

LNT v5 is a redesign of LNT whose database, REST API and web UI are not
compatible with v4's. Data held by a v4 instance is moved to a v5 instance in
three steps: ``lnt mirror-v4`` first copies the data of a v4 instance into a
local directory through its REST API, ``lnt v5 convert-v4-mirror`` then converts
that copy into v5 runs, and ``lnt v5 submit`` submits them to a v5 instance.

.. toctree::
   :maxdepth: 1

   mirror_v4

   convert_v4_mirror

   v5_submit

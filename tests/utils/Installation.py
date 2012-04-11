# Check that installation functions properly (mainly try and catch cases where
# we didn't install package data properly).
#
# RUN: rm -rf %t.venv
# RUN: virtualenv %t.venv
# RUN: %t.venv/bin/python %{src_root}/setup.py install
# RUN: rm -rf %t.installation
# RUN: %t.venv/bin/lnt create %t.installation
#
# Disable this test by default, it is very slow because it does a full install.
#
# REQUIRES: long

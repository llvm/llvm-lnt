# Check that our source distribution is "clean" (includes everything we need it
# to).
#
# RUN: %{src_root}/utils/check-sdist %{src_root}
#
# Disable this test by default, it isn't particularly slow but it is a tad
# invasive.
#
# REQUIRES: long

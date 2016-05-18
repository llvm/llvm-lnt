# Testing for the  LNT view-comparison module.
#
# create temporary instance
# RUN: rm -rf %t.instance
# RUN: python %{shared_inputs}/create_temp_instance.py \
# RUN:   %s %{shared_inputs}/SmallInstance %t.instance
#
# RUN: lnt view-comparison --help
# RUN: lnt view-comparison --dry-run %{shared_inputs}/sample-a-small.plist \
# RUN:     %{shared_inputs}/sample-b-small.plist

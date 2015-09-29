# Testing for the  LNT email commands module.
#
# create temporary instance
# Cleanup temporary directory in case one remained from a previous run - also
# see PR9904.
# RUN: rm -rf %t.instance
# RUN: python %{shared_inputs}/create_temp_instance.py \
# RUN:   %s %{shared_inputs}/SmallInstance %t.instance
#
# RUN: lnt send-run-comparison --dry-run --to some@address.com \
# RUN: --from some.other@address.com  \
# RUN: --host localhost %t.instance 1 2
# RUN: lnt send-daily-report --dry-run --from some.other@address.com \
# RUN: --host localhost --testsuite nts --filter-machine-regex=machine.? \
# RUN: %t.instance some@address.com

# Testing for the  LNT email commands module.
#
# RUN: lnt send-run-comparison --dry-run --to some@address.com \
# RUN: --from some.other@address.com  \
# RUN: --host localhost %{shared_inputs}/SmallInstance/ 1 2
# RUN: lnt send-daily-report --dry-run --from some.other@address.com \
# RUN: --host localhost --testsuite nts \
# RUN: %{shared_inputs}/SmallInstance/ some@address.com

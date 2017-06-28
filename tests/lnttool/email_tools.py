# Testing for the  LNT email commands module.
#
# create temporary instance
# Cleanup temporary directory in case one remained from a previous run - also
# see PR9904.
# RUN: rm -rf %t.instance
# RUN: python %{shared_inputs}/create_temp_instance.py \
# RUN:   %s %{shared_inputs}/SmallInstance %t.instance



# RUN: lnt send-run-comparison --dry-run --to some@address.com \
# RUN: --from some.other@address.com  \
# RUN: --host localhost %t.instance 1 2 | FileCheck %s --check-prefix CHECK0
#
# CHECK0: From: some.other@address.com
# CHECK0: To: some@address.com
# CHECK0: Subject: localhost__clang_DEV__x86_64 test results
# CHECK0: === text/plain report
# CHECK0: http://localhost/perf/v4/nts/2?compare_to=1&amp;baseline=2
# CHECK0: Nickname: localhost__clang_DEV__x86_64:1
# CHECK0: Name: localhost
# CHECK0: Comparing:
# CHECK0:      Run: 2, Order: 152289, Start Time: 2012-04-11 21:13:53, End Time: 2012-04-11 21:14:49
# CHECK0:      To: 1, Order: 154331, Start Time: 2012-04-11 16:28:23, End Time: 2012-04-11 16:28:58
# CHECK0: Baseline: 2, Order: 152289, Start Time: 2012-04-11 21:13:53, End Time: 2012-04-11 21:14:49
# CHECK0: Tests Summary
# ...
# CHECK0: Unchanged Tests: 10 (10 on baseline)
# CHECK0: Total Tests: 10
# ...
# CHECK0: === html report
# CHECK0: <html>
# CHECK0: <head>
# CHECK0:   <title>localhost__clang_DEV__x86_64 test results</title>
# CHECK0: </head>
# ...
# CHECK0: </html>



# RUN: lnt send-daily-report --dry-run --from some.other@address.com \
# RUN: --host localhost --testsuite nts --filter-machine-regex=machine.? \
# RUN: %t.instance some@address.com | FileCheck %s --check-prefix CHECK1
#
# CHECK1: From: some.other@address.com
# CHECK1: To: some@address.com
# CHECK1: Subject: Daily Report: 2012-04-11
# CHECK1: === html report
# CHECK1: <html>
# CHECK1: <head>
# CHECK1:    <title>Daily Report: 2012-04-11</title>
# CHECK1: </head>
# Make sure we see css inlined into the tags.
# CHECK1: <body style="color:#000000; background-color:#ffffff; font-family: Helvetica, sans-serif; font-size:9pt">
# CHECK1: <p>An error was encountered while producing the daily report: no runs to display in selected date range.</p>
# CHECK1: </html>

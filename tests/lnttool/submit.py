# RUN: rm -rf %t.instance
# RUN: python %{shared_inputs}/create_temp_instance.py \
# RUN:   %s %{shared_inputs}/SmallInstance %t.instance
# RUN: %{shared_inputs}/server_wrapper.sh %t.instance 9091 \
# RUN:    lnt submit "http://localhost:9091/db_default/submitRun" --commit=1 \
# RUN:       %{shared_inputs}/sample-report.json | \
# RUN:    FileCheck %s --check-prefix=CHECK-DEFAULT
#
# CHECK-DEFAULT: http://localhost:9091/db_default/v4/nts/3
#
# RUN: rm -rf %t.instance
# RUN: python %{shared_inputs}/create_temp_instance.py \
# RUN:   %s %{shared_inputs}/SmallInstance %t.instance
# RUN: %{shared_inputs}/server_wrapper.sh %t.instance 9091 \
# RUN:    lnt submit "http://localhost:9091/db_default/submitRun" --commit=1 \
# RUN:       %{shared_inputs}/sample-report.json -v | \
# RUN:    FileCheck %s --check-prefix=CHECK-VERBOSE
#
# CHECK-VERBOSE: Import succeeded.
# CHECK-VERBOSE: --- Tested: 10 tests --
#
# CHECK-VERBOSE: Imported Data
# CHECK-VERBOSE: -------------
# CHECK-VERBOSE: Added Machines: 1
# CHECK-VERBOSE: Added Runs    : 1
# CHECK-VERBOSE: Added Tests   : 2
#
# CHECK-VERBOSE: Results
# CHECK-VERBOSE: ----------------
# CHECK-VERBOSE: PASS : 10
# CHECK-VERBOSE: Results available at: http://localhost:9091/db_default/v4/nts/3

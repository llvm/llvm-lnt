# Testing for the rerun feature of LNT nt.
# This test runs two stub test suites. The second one has different values for
# some of the test, so they should be marked as regressions, and reruns should
# be triggered.

# RUN: rm -rf %t.instance
# RUN: mkdir -p %t.instance
# RUN: rsync -av --exclude .svn %S/Inputs/rerun_server_instance/ %t.instance
# RUN: rm -f CHECK-STDOUT CHECK-STDOUT2 CHECK-STDERR CHECK-STDERR2
# RUN: %{shared_inputs}/server_wrapper.sh \
# RUN:   %t.instance 9090 \
# RUN:   lnt runtest nt --submit "http://localhost:9090/db_default/submitRun" \
# RUN:   --sandbox %t.SANDBOX \
# RUN:   --test-suite %S/Inputs/rerun-test-suite1 \
# RUN:   --cc %{shared_inputs}/FakeCompilers/clang-r154331 \
# RUN:   --no-timestamp --rerun --run-order 1 > %t.log 2> %t.err
# RUN: FileCheck --check-prefix CHECK-STDOUT < %t.log %s
# RUN: FileCheck --check-prefix CHECK-STDERR < %t.err %s

# CHECK-STDOUT: Import succeeded.
# CHECK-STDOUT: PASS : 345

# CHECK-STDERR: inferred C++ compiler under test
# CHECK-STDERR: checking source versions
# CHECK-STDERR: using nickname
# CHECK-STDERR: starting test
# CHECK-STDERR: configuring
# CHECK-STDERR: building test-suite tools
# CHECK-STDERR: executing "nightly tests" with -j1
# CHECK-STDERR: loading nightly test data
# CHECK-STDERR: capturing machine information
# CHECK-STDERR: generating report
# CHECK-STDERR: submitting result to
# CHECK-STDERR: Rerunning 0 of 69 benchmarks.

# RUN: %{shared_inputs}/server_wrapper.sh \
# RUN:   %t.instance 9090 \
# RUN:   lnt runtest nt --submit "http://localhost:9090/db_default/submitRun" \
# RUN:   --sandbox %t.SANDBOX2 \
# RUN:   --test-suite %S/Inputs/rerun-test-suite2 \
# RUN:   --cc %{shared_inputs}/FakeCompilers/clang-r154331 \
# RUN:   --no-timestamp --rerun --run-order 4 --verbose \
# RUN:   > %t.2.log 2> %t.2.err || cat %t.2.err
# RUN: echo "Run 2"
# RUN: FileCheck --check-prefix CHECK-STDOUT2 < %t.2.log %s
# RUN: FileCheck --check-prefix CHECK-STDERR2 < %t.2.err %s

# CHECK-STDOUT2: Import succeeded.
# CHECK-STDOUT2: FAIL : 3
# CHECK-STDOUT2: PASS : 342

# CHECK-STDERR2: inferred C++ compiler under test
# CHECK-STDERR2: checking source versions
# CHECK-STDERR2: using nickname
# CHECK-STDERR2: starting test
# CHECK-STDERR2: configuring
# CHECK-STDERR2: building test-suite tools
# CHECK-STDERR2: executing "nightly tests" with -j1
# CHECK-STDERR2: loading nightly test data
# CHECK-STDERR2: capturing machine information
# CHECK-STDERR2: generating report
# CHECK-STDERR2: Rerunning 3 of 69 benchmarks.
# CHCCK-SDTERR2: Rerunning: ms_struct-bitfield [1/3]
# CHCCK-SDTERR2: Rerunning: ms_struct_pack_layout-1 [2/3]
# CHCCK-SDTERR2: Rerunning: vla [3/3]

# CHECK-STDERR2: submitting result to

# Testing for the 'lnt runtest nt' module.
#
# Check a basic nt run.
# RUN: lnt runtest nt \
# RUN:   --sandbox %t.SANDBOX \
# RUN:   --test-suite %S/Inputs/test-suite \
# RUN:   --cc %{shared_inputs}/FakeCompilers/clang-r154331 \
# RUN:   --no-timestamp > %t.log 2> %t.err
# RUN: FileCheck --check-prefix CHECK-STDOUT < %t.log %s
# RUN: FileCheck --check-prefix CHECK-BASIC < %t.err %s
# RUN: FileCheck --check-prefix CHECK-REPORT < %t.SANDBOX/build/report.json %s
# CHECK-REPORT: "run_order": "154331"
#
# CHECK-STDOUT: Import succeeded.
# CHECK-STDOUT: Added Machines: 1
# CHECK-STDOUT: Added Runs    : 1
# CHECK-STDOUT: Added Tests   : 130
#
# CHECK-BASIC: inferred C++ compiler under test
# CHECK-BASIC: checking source versions
# CHECK-BASIC: using nickname
# CHECK-BASIC: starting test
# CHECK-BASIC: configuring
# CHECK-BASIC: building test-suite tools
# CHECK-BASIC: executing "nightly tests" with -j1
# CHECK-BASIC: loading nightly test data
# CHECK-BASIC: capturing machine information
# CHECK-BASIC: generating report
# CHECK-BASIC: submitting result to dummy instance
#
# Use the same sandbox again with --no-configure
# RUN: lnt runtest nt \
# RUN:   --sandbox %t.SANDBOX \
# RUN:   --test-suite %S/Inputs/test-suite \
# RUN:   --cc %{shared_inputs}/FakeCompilers/clang-r154331 \
# RUN:   --no-timestamp --no-configure > %t.log 2> %t.err
# RUN: FileCheck --check-prefix CHECK-NOCONF < %t.err %s
# CHECK-NOCONF-NOT: configuring
#
# Manually set a run order.
# RUN: lnt runtest nt \
# RUN:   --sandbox %t.SANDBOX \
# RUN:   --test-suite %S/Inputs/test-suite \
# RUN:   --cc %{shared_inputs}/FakeCompilers/clang-r154331 \
# RUN:   --no-timestamp --run-order=123 > %t.log 2> %t.err
# RUN: FileCheck --check-prefix CHECK-RESULTS < %t.SANDBOX/build/report.json %s
# CHECK-RESULTS: "run_order": "123"
#
# Change the machine name. Don't use LLVM.
# RUN: lnt runtest nt \
# RUN:   --sandbox %t.SANDBOX \
# RUN:   --test-suite %S/Inputs/test-suite \
# RUN:   --cc %{shared_inputs}/FakeCompilers/clang-r154331 \
# RUN:   --no-auto-name foo > %t.log 2> %t.err
# RUN: FileCheck --check-prefix CHECK-AUTONAME < %t.err %s
# CHECK-AUTONAME: using nickname: 'foo'

# Run without LLVM.
# RUN: lnt runtest nt \
# RUN:   --sandbox %t.SANDBOX \
# RUN:   --test-suite %S/Inputs/test-suite \
# RUN:   --cc %{shared_inputs}/FakeCompilers/clang-r154331 \
# RUN:   --no-timestamp --without-llvm > %t.log 2> %t.err

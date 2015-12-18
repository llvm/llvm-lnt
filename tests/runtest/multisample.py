# Testing for the 'lnt runtest nt' module.
#
# RUN: lnt runtest nt \
# RUN:   --sandbox %t.SANDBOX \
# RUN:   --test-suite %S/Inputs/test-suite \
# RUN:   --cc %{shared_inputs}/FakeCompilers/clang-r154331 \
# RUN:   --no-timestamp --multisample 5 > %t.log 2> %t.err
#
# RUN: FileCheck --check-prefix CHECK-STDOUT < %t.log %s
# RUN: FileCheck --check-prefix CHECK-STDERR < %t.err %s
#
# CHECK-STDOUT: Import succeeded.
# CHECK-STDOUT: Added Machines: 1
# CHECK-STDOUT: Added Runs    : 1
# CHECK-STDOUT: Added Tests   : 130

# CHECK-STDERR: inferred C++ compiler under test
# CHECK-STDERR: (multisample) running iteration 0
# CHECK-STDERR: checking source versions
# CHECK-STDERR: using nickname
# CHECK-STDERR: starting test
# CHECK-STDERR: configuring
# CHECK-STDERR: building test-suite tools
# CHECK-STDERR: executing "nightly tests" with -j1
# CHECK-STDERR: loading nightly test data
# CHECK-STDERR: capturing machine information
# CHECK-STDERR: generating report
# CHECK-STDERR: (multisample) running iteration 1
# CHECK-STDERR: (multisample) running iteration 2
# CHECK-STDERR: (multisample) running iteration 3
# CHECK-STDERR: (multisample) running iteration 4
# CHECK-STDERR: submitting result to dummy instance

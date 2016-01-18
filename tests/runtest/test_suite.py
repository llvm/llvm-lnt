# Testing for the 'lnt runtest test-suite' module.
#
# Check a basic nt run.
# RUN: lnt runtest test-suite \
# RUN:     --sandbox %t.SANDBOX \
# RUN:     --no-timestamp \
# RUN:     --test-suite %S/Inputs/test-suite-cmake \
# RUN:     --cc %{shared_inputs}/FakeCompilers/clang-r154331 \
# RUN:     --use-cmake %S/Inputs/test-suite-cmake/fake-cmake \
# RUN:     --use-make %S/Inputs/test-suite-cmake/fake-make \
# RUN:     --use-lit %S/Inputs/test-suite-cmake/fake-lit \
# RUN:     > %t.log 2> %t.err
# RUN: FileCheck  --check-prefix CHECK-STDOUT < %t.log %s
# RUN: FileCheck  --check-prefix CHECK-BASIC < %t.err %s
# RUN: FileCheck  --check-prefix CHECK-REPORT < %t.SANDBOX/build/report.json %s

# CHECK-REPORT: "run_order": "154331"
# CHECK-REPORT: "Name": "nts.{{[^.]+}}.compile"
# CHECK-REPORT: "Name": "nts.{{[^.]+}}.compile.status"
#
# CHECK-STDOUT: Import succeeded.
# CHECK-STDOUT: Added Machines: 1
# CHECK-STDOUT: Added Runs    : 1
# CHECK-STDOUT: Added Tests   : 1
#
# CHECK-BASIC: inferred C++ compiler under test
# CHECK-BASIC: submitting result to dummy instance
# CHECK-BASIC: Successfully created db_None/v4/nts/1

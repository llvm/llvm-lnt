# Testing for the  --exclude-stat-from-submission command line argument.
#
# Check a basic test-suite run.
# RUN: lnt runtest test-suite \
# RUN:   --sandbox %t.SANDBOX \
# RUN:   --test-suite %S/Inputs/test-suite-cmake \
# RUN:   --cc %{shared_inputs}/FakeCompilers/clang-r154331 \
# RUN:   --use-cmake %S/Inputs/test-suite-cmake/fake-cmake \
# RUN:   --use-make %S/Inputs/test-suite-cmake/fake-make \
# RUN:   --use-lit %S/Inputs/test-suite-cmake/fake-lit \
# RUN:   --exclude-stat-from-submission compile \
# RUN:   --no-timestamp > %t.log 2> %t.err
# RUN: filecheck --check-prefix CHECK-STDOUT < %t.log %s
# RUN: filecheck --check-prefix CHECK-REPORT < %t.SANDBOX/build/report.json %s
# CHECK-STDOUT: Import succeeded.
# CHECK-REPORT:     "Name": "nts.{{[^.]+}}.exec"
# CHECK-REPORT-NOT: "Name": "nts.{{[^.]+}}.compile"

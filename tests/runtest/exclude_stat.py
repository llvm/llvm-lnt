# Testing for the  --exclude-stat-from-submission command line argument.
#
# Check a basic nt run.
# RUN: lnt runtest nt \
# RUN:   --sandbox %t.SANDBOX \
# RUN:   --test-suite %S/Inputs/test-suite \
# RUN:   --cc %{shared_inputs}/FakeCompilers/clang-r154331 \
# RUN:   --exclude-stat-from-submission compile \
# RUN:   --no-timestamp > %t.log 2> %t.err
# RUN: filecheck --check-prefix CHECK-STDOUT < %t.log %s
# RUN: filecheck --check-prefix CHECK-REPORT < %t.SANDBOX/build/report.json %s
# CHECK-STDOUT: Import succeeded.
# CHECK-REPORT:     "Name": "nts.{{[^.]+}}.exec"
# CHECK-REPORT-NOT: "Name": "nts.{{[^.]+}}.compile"

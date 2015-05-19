# Testing for the  --exclude-stat-from-submission command line argument.
#
# Check a basic nt run.
# RUN: lnt runtest nt \
# RUN:   --sandbox %t.SANDBOX \
# RUN:   --test-suite %S/Inputs/test-suite \
# RUN:   --cc %{shared_inputs}/FakeCompilers/clang-r154331 \
# RUN:   --exclude-stat-from-submission compile \
# RUN:   --no-timestamp > %t.log 2> %t.err
# RUN: FileCheck --check-prefix CHECK-STDOUT < %t.log %s
# CHECK-STDOUT: Import succeeded.

# Darwin specific testing for the 'lnt runtest nt' module.

# Run with sandboxing enabled.
# RUN: lnt runtest nt \
# RUN:   --sandbox %t.SANDBOX \
# RUN:   --test-suite %S/Inputs/test-suite \
# RUN:   --cc %{shared_inputs}/FakeCompilers/clang-r154331 \
# RUN:   --no-timestamp --use-isolation > %t.log 2> %t.err
# RUN: filecheck --check-prefix CHECK-SANDBOX < %t.err %s
#
# CHECK-SANDBOX: creating sandbox profile

# REQUIRES: Darwin

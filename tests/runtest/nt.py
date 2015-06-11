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
# CHECK-REPORT: "Name": "nts.{{[^.]+}}.exec"
# CHECK-REPORT: "Name": "nts.{{[^.]+}}.compile"
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

# Check cflag handling

## With a lone cflag
# RUN: lnt runtest nt \
# RUN:   --sandbox %t.SANDBOX \
# RUN:   --test-suite %S/Inputs/test-suite \
# RUN:   --cc %{shared_inputs}/FakeCompilers/clang-r154331 \
# RUN:   --cflag '-Wall' \
# RUN:   --no-timestamp > %t.log 2> %t.err
# RUN: FileCheck --check-prefix CHECK-CFLAG1 < %t.err %s
# CHECK-CFLAG1: inferred C++ compiler under test
# CHECK-CFLAG1: TARGET_FLAGS: -Wall

## With a couple of cflags
# RUN: lnt runtest nt \
# RUN:   --sandbox %t.SANDBOX \
# RUN:   --test-suite %S/Inputs/test-suite \
# RUN:   --cc %{shared_inputs}/FakeCompilers/clang-r154331 \
# RUN:   --cflag '-Wall' \
# RUN:   --cflag '-mfloat-abi=hard' \
# RUN:   --cflag '-O3' \
# RUN:   --no-timestamp > %t.log 2> %t.err
# RUN: FileCheck --check-prefix CHECK-CFLAG2 < %t.err %s
# CHECK-CFLAG2: inferred C++ compiler under test
# CHECK-CFLAG2: TARGET_FLAGS: -Wall -mfloat-abi=hard -O3

## With a cflags
# RUN: lnt runtest nt \
# RUN:   --sandbox %t.SANDBOX \
# RUN:   --test-suite %S/Inputs/test-suite \
# RUN:   --cc %{shared_inputs}/FakeCompilers/clang-r154331 \
# RUN:   --cflags '-Wall -mfloat-abi=hard -O3' \
# RUN:   --no-timestamp > %t.log 2> %t.err
# RUN: FileCheck --check-prefix CHECK-CFLAG3 < %t.err %s
# CHECK-CFLAG3: inferred C++ compiler under test
# CHECK-CFLAG3: TARGET_FLAGS: -Wall -mfloat-abi=hard -O3

## With a cflags with a quoted space and escaped spaces
# RUN: lnt runtest nt \
# RUN:   --sandbox %t.SANDBOX \
# RUN:   --test-suite %S/Inputs/test-suite \
# RUN:   --cc %{shared_inputs}/FakeCompilers/clang-r154331 \
# RUN:   --cflags "-Wall -test=escaped\ space -some-option='stay with me' -O3" \
# RUN:   --no-timestamp > %t.log 2> %t.err
# RUN: FileCheck --check-prefix CHECK-CFLAG4 < %t.err %s
# CHECK-CFLAG4: inferred C++ compiler under test
# CHECK-CFLAG4: TARGET_FLAGS: -Wall '-test=escaped space' '-some-option=stay with me' -O3

## With cflag and cflags
# RUN: lnt runtest nt \
# RUN:   --sandbox %t.SANDBOX \
# RUN:   --test-suite %S/Inputs/test-suite \
# RUN:   --cc %{shared_inputs}/FakeCompilers/clang-r154331 \
# RUN:   --cflag '--target=armv7a-none-eabi' \
# RUN:   --cflag '-Weverything' \
# RUN:   --cflags '-Wall -test=escaped\ space -some-option="stay with me" -O3' \
# RUN:   --no-timestamp > %t.log 2> %t.err
# RUN: FileCheck --check-prefix CHECK-CFLAG5 < %t.err %s
# CHECK-CFLAG5: inferred C++ compiler under test
# CHECK-CFLAG5: TARGET_FLAGS: --target=armv7a-none-eabi -Weverything -Wall '-test=escaped space' '-some-option=stay with me' -O3

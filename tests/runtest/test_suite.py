# Testing for the 'lnt runtest test-suite' module.
#
# RUN: rm -rf  %t.SANDBOX  %t.SANDBOX2 || true
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
# CHECK-BASIC: Inferred C++ compiler under test
# CHECK-BASIC: Configuring
# CHECK-BASIC: Building
# CHECK-BASIC: Testing
# CHECK-BASIC: submitting result to dummy instance
# CHECK-BASIC: Successfully created db_None/v4/nts/1

# Use the same sandbox again with --no-configure
# RUN: lnt runtest test-suite \
# RUN:     --sandbox %t.SANDBOX \
# RUN:     --no-timestamp \
# RUN:     --no-configure \
# RUN:     --test-suite %S/Inputs/test-suite-cmake \
# RUN:     --cc %{shared_inputs}/FakeCompilers/clang-r154331 \
# RUN:     --use-cmake %S/Inputs/test-suite-cmake/fake-cmake \
# RUN:     --use-make %S/Inputs/test-suite-cmake/fake-make \
# RUN:     --use-lit %S/Inputs/test-suite-cmake/fake-lit \
# RUN:     > %t.log 2> %t.err
# RUN: FileCheck --check-prefix CHECK-NOCONF < %t.err %s
# CHECK-NOCONF-NOT: Configuring

# Use a different sandbox with --no-configure
# RUN: lnt runtest test-suite \
# RUN:     --sandbox %t.SANDBOX2 \
# RUN:     --no-timestamp \
# RUN:     --no-configure \
# RUN:     --test-suite %S/Inputs/test-suite-cmake \
# RUN:     --cc %{shared_inputs}/FakeCompilers/clang-r154331 \
# RUN:     --use-cmake %S/Inputs/test-suite-cmake/fake-cmake \
# RUN:     --use-make %S/Inputs/test-suite-cmake/fake-make \
# RUN:     --use-lit %S/Inputs/test-suite-cmake/fake-lit \
# RUN:     > %t.log 2> %t.err
# RUN: FileCheck --check-prefix CHECK-NOCONF2 < %t.err %s
# CHECK-NOCONF2: Configuring

# Manually set a run order.
# RUN: lnt runtest test-suite \
# RUN:     --sandbox %t.SANDBOX \
# RUN:     --no-timestamp \
# RUN:     --no-configure \
# RUN:     --test-suite %S/Inputs/test-suite-cmake \
# RUN:     --cc %{shared_inputs}/FakeCompilers/clang-r154331 \
# RUN:     --use-cmake %S/Inputs/test-suite-cmake/fake-cmake \
# RUN:     --use-make %S/Inputs/test-suite-cmake/fake-make \
# RUN:     --use-lit %S/Inputs/test-suite-cmake/fake-lit \
# RUN:     --run-order=123 > %t.log 2> %t.err
# RUN: FileCheck --check-prefix CHECK-RESULTS < %t.SANDBOX/build/report.json %s
# CHECK-RESULTS: "run_order": "123"

# Change the machine name.
# RUN: lnt runtest test-suite \
# RUN:     --sandbox %t.SANDBOX \
# RUN:     --no-timestamp \
# RUN:     --no-configure \
# RUN:     --test-suite %S/Inputs/test-suite-cmake \
# RUN:     --cc %{shared_inputs}/FakeCompilers/clang-r154331 \
# RUN:     --use-cmake %S/Inputs/test-suite-cmake/fake-cmake \
# RUN:     --use-make %S/Inputs/test-suite-cmake/fake-make \
# RUN:     --use-lit %S/Inputs/test-suite-cmake/fake-lit \
# RUN:     --no-auto-name foo \
# RUN:     > %t.log 2> %t.err
# RUN: FileCheck --check-prefix CHECK-AUTONAME < %t.err %s
# CHECK-AUTONAME: Using nickname: 'foo'

# Check cflag handling

## With a lone cflag
# RUN: lnt runtest test-suite \
# RUN:     --sandbox %t.SANDBOX \
# RUN:     --no-timestamp \
# RUN:     --test-suite %S/Inputs/test-suite-cmake \
# RUN:     --cc %{shared_inputs}/FakeCompilers/clang-r154331 \
# RUN:     --use-cmake %S/Inputs/test-suite-cmake/fake-cmake \
# RUN:     --use-make %S/Inputs/test-suite-cmake/fake-make \
# RUN:     --use-lit %S/Inputs/test-suite-cmake/fake-lit \
# RUN:     --cflag '-Wall' \
# RUN:     > %t.log 2> %t.err
# RUN: FileCheck --check-prefix CHECK-CFLAG1 < %t.err %s
# CHECK-CFLAG1: Inferred C++ compiler under test
# CHECK-CFLAG1: CMAKE_C_FLAGS: '-Wall

## With a couple of cflags
# RUN: lnt runtest test-suite \
# RUN:     --sandbox %t.SANDBOX \
# RUN:     --no-timestamp \
# RUN:     --test-suite %S/Inputs/test-suite-cmake \
# RUN:     --cc %{shared_inputs}/FakeCompilers/clang-r154331 \
# RUN:     --use-cmake %S/Inputs/test-suite-cmake/fake-cmake \
# RUN:     --use-make %S/Inputs/test-suite-cmake/fake-make \
# RUN:     --use-lit %S/Inputs/test-suite-cmake/fake-lit \
# RUN:     --cflag '-Wall' \
# RUN:     --cflag '-mfloat-abi=hard' \
# RUN:     --cflag '-O3' \
# RUN:     > %t.log 2> %t.err
# RUN: FileCheck --check-prefix CHECK-CFLAG2 < %t.err %s
# CHECK-CFLAG2: Inferred C++ compiler under test
# CHECK-CFLAG2: CMAKE_C_FLAGS: '-Wall -mfloat-abi=hard -O3

## With a cflags
# RUN: lnt runtest test-suite \
# RUN:     --sandbox %t.SANDBOX \
# RUN:     --no-timestamp \
# RUN:     --test-suite %S/Inputs/test-suite-cmake \
# RUN:     --cc %{shared_inputs}/FakeCompilers/clang-r154331 \
# RUN:     --use-cmake %S/Inputs/test-suite-cmake/fake-cmake \
# RUN:     --use-make %S/Inputs/test-suite-cmake/fake-make \
# RUN:     --use-lit %S/Inputs/test-suite-cmake/fake-lit \
# RUN:     --cflags '-Wall -mfloat-abi=hard -O3' \
# RUN:     > %t.log 2> %t.err
# RUN: FileCheck --check-prefix CHECK-CFLAG3 < %t.err %s
# CHECK-CFLAG3: Inferred C++ compiler under test
# CHECK-CFLAG3: CMAKE_C_FLAGS: '-Wall -mfloat-abi=hard -O3

## With a cflags with a quoted space and escaped spaces
# RUN: lnt runtest test-suite \
# RUN:     --sandbox %t.SANDBOX \
# RUN:     --no-timestamp \
# RUN:     --test-suite %S/Inputs/test-suite-cmake \
# RUN:     --cc %{shared_inputs}/FakeCompilers/clang-r154331 \
# RUN:     --use-cmake %S/Inputs/test-suite-cmake/fake-cmake \
# RUN:     --use-make %S/Inputs/test-suite-cmake/fake-make \
# RUN:     --use-lit %S/Inputs/test-suite-cmake/fake-lit \
# RUN:     --cflags "-Wall -test=escaped\ space -some-option='stay with me' -O3" \
# RUN:     > %t.log 2> %t.err
# RUN: FileCheck --check-prefix CHECK-CFLAG4 < %t.err %s
# CHECK-CFLAG4: Inferred C++ compiler under test
# CHECK-CFLAG4: CMAKE_C_FLAGS: '-Wall '-test=escaped space' '-some-option=stay with me' -O3

## With cflag and cflags
# RUN: lnt runtest test-suite \
# RUN:     --sandbox %t.SANDBOX \
# RUN:     --no-timestamp \
# RUN:     --test-suite %S/Inputs/test-suite-cmake \
# RUN:     --cc %{shared_inputs}/FakeCompilers/clang-r154331 \
# RUN:     --use-cmake %S/Inputs/test-suite-cmake/fake-cmake \
# RUN:     --use-make %S/Inputs/test-suite-cmake/fake-make \
# RUN:     --use-lit %S/Inputs/test-suite-cmake/fake-lit \
# RUN:   --cflag '--target=armv7a-none-eabi' \
# RUN:   --cflag '-Weverything' \
# RUN:   --cflags '-Wall -test=escaped\ space -some-option="stay with me" -O3' \
# RUN:     > %t.log 2> %t.err
# RUN: FileCheck --check-prefix CHECK-CFLAG5 < %t.err %s
# CHECK-CFLAG5: Inferred C++ compiler under test
# CHECK-CFLAG5: CMAKE_C_FLAGS: '--target=armv7a-none-eabi -Weverything -Wall '-test=escaped space' '-some-option=stay with me' -O3

# Use a run-under command
# RUN: not lnt runtest test-suite \
# RUN:     --sandbox %t.SANDBOX \
# RUN:     --no-timestamp \
# RUN:     --no-configure \
# RUN:     --test-suite %S/Inputs/test-suite-cmake \
# RUN:     --cc %{shared_inputs}/FakeCompilers/clang-r154331 \
# RUN:     --use-cmake %S/Inputs/test-suite-cmake/fake-cmake \
# RUN:     --use-make %S/Inputs/test-suite-cmake/fake-make \
# RUN:     --use-lit %S/Inputs/test-suite-cmake/fake-lit \
# RUN:     --run-under bar \
# RUN:     > %t.log 2> %t.err
# RUN: FileCheck --check-prefix CHECK-RUNUNDER1 < %t.err %s
# CHECK-RUNUNDER1: Run under wrapper not found (looked for bar)

# Use a run-under command
# RUN: lnt runtest test-suite \
# RUN:     --sandbox %t.SANDBOX \
# RUN:     --no-timestamp \
# RUN:     --test-suite %S/Inputs/test-suite-cmake \
# RUN:     --cc %{shared_inputs}/FakeCompilers/clang-r154331 \
# RUN:     --use-cmake %S/Inputs/test-suite-cmake/fake-cmake \
# RUN:     --use-make %S/Inputs/test-suite-cmake/fake-make \
# RUN:     --use-lit %S/Inputs/test-suite-cmake/fake-lit \
# RUN:     --run-under %S/Inputs/test-suite-cmake/fake-make \
# RUN:     > %t.log 2> %t.err
# RUN: FileCheck --check-prefix CHECK-RUNUNDER2 < %t.err %s
# CHECK-RUNUNDER2: TEST_SUITE_RUN_UNDER: '{{.*}}/fake-make'


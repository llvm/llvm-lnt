# Testing for the 'lnt runtest test-suite' module.
#
# RUN: rm -rf  %t.SANDBOX  %t.SANDBOX2 || true
#
# Check a basic test-suite run.
# RUN: lnt runtest test-suite \
# RUN:     --sandbox %t.SANDBOX \
# RUN:     --no-timestamp \
# RUN:     --test-suite %S/Inputs/test-suite-cmake \
# RUN:     --cc %{shared_inputs}/FakeCompilers/clang-r154331 \
# RUN:     --use-cmake %S/Inputs/test-suite-cmake/fake-cmake \
# RUN:     --use-make %S/Inputs/test-suite-cmake/fake-make \
# RUN:     --use-lit %S/Inputs/test-suite-cmake/fake-lit \
# RUN:     --output %t.report \
# RUN:     > %t.out 2> %t.err
# RUN: lnt checkformat %t.report > %t.checkformat
# RUN: FileCheck  --check-prefix CHECK-BASIC < %t.err %s
# RUN: FileCheck  --check-prefix CHECK-REPORT < %t.SANDBOX/build/report.json %s
# RUN: FileCheck  --check-prefix CHECK-XML < %t.SANDBOX/build/test-results.xunit.xml %s
# RUN: FileCheck  --check-prefix CHECK-CSV < %t.SANDBOX/build/test-results.csv %s
# RUN: FileCheck  --check-prefix CHECK-CHECKFORMAT < %t.checkformat %s

# CHECK-REPORT: "no_errors": false,
# CHECK-REPORT: "run_order": "154331"
# CHECK-REPORT: "Name": "nts.{{[^.]+}}.compile"
# CHECK-REPORT: "Name": "nts.{{[^.]+}}.compile.status"
#
# CHECK-BASIC: Inferred C++ compiler under test
# CHECK-BASIC: Configuring
# CHECK-BASIC: Building
# CHECK-BASIC: Testing

# CHECK-XML: <?xml version="1.0" encoding="UTF-8"?>
# CHECK-XML: <testsuite name="foo"
# CHECK-XML:            tests="{{[0-9]+}}"
# CHECK-XML:            errors="0"
# CHECK-XML:            failures="0"
# CHECK-XML:            timestamp="2
# CHECK-XML:     <testcase classname=""
# CHECK-XML:               name="foo" time="1.0">
# CHECK-XML:     </testcase>
# CHECK-XML: </testsuite>

# CHECK-CSV: Program;CC;CC_Time;CC_Hash;Exec;Exec_Time;Score
# CHECK-CSV-NEXT: foo//foo;pass;1.3;xyz;pass;1.4;1.5

# CHECK-CHECKFORMAT: Import succeeded.
# CHECK-CHECKFORMAT: Added Machines: 1
# CHECK-CHECKFORMAT: Added Runs    : 1
# CHECK-CHECKFORMAT: Added Tests   : 1

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
# Ensure that default c flags for build configurations are made empty to avoid
# surprises:
# CHECK-CFLAG1: CMAKE_C_FLAGS_DEBUG: ''
# CHECK-CFLAG1: CMAKE_C_FLAGS_MINSIZEREL: ''
# CHECK-CFLAG1: CMAKE_C_FLAGS_RELEASE: ''
# CHECK-CFLAG1: CMAKE_C_FLAGS_RELWITHDEBINFO: ''

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
# RUN:     --run-under i_do_not_exist \
# RUN:     > %t.log 2> %t.err
# RUN: FileCheck --check-prefix CHECK-RUNUNDER1 < %t.err %s
# CHECK-RUNUNDER1: Run under wrapper not found (looked for i_do_not_exist)

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

# Use a run-under command with an argument
# RUN: lnt runtest test-suite \
# RUN:     --sandbox %t.SANDBOX \
# RUN:     --no-timestamp \
# RUN:     --test-suite %S/Inputs/test-suite-cmake \
# RUN:     --cc %{shared_inputs}/FakeCompilers/clang-r154331 \
# RUN:     --use-cmake %S/Inputs/test-suite-cmake/fake-cmake \
# RUN:     --use-make %S/Inputs/test-suite-cmake/fake-make \
# RUN:     --use-lit %S/Inputs/test-suite-cmake/fake-lit \
# RUN:     --run-under '%S/Inputs/test-suite-cmake/fake-make wibble' \
# RUN:     > %t.log 2> %t.err
# RUN: FileCheck --check-prefix CHECK-RUNUNDER3 < %t.err %s
# CHECK-RUNUNDER3: TEST_SUITE_RUN_UNDER: '{{.*}}/fake-make wibble'

# Check --only-test
# RUN: lnt runtest test-suite \
# RUN:     --sandbox %t.SANDBOX \
# RUN:     --no-timestamp \
# RUN:     --test-suite %S/Inputs/test-suite-cmake \
# RUN:     --cc %{shared_inputs}/FakeCompilers/clang-r154331 \
# RUN:     --use-cmake %S/Inputs/test-suite-cmake/fake-cmake \
# RUN:     --use-make %S/Inputs/test-suite-cmake/fake-make \
# RUN:     --use-lit %S/Inputs/test-suite-cmake/fake-lit \
# RUN:     --only-test subtest \
# RUN:     --cmake-define one=two \
# RUN:     --cmake-define three=four \
# RUN:     --verbose \
# RUN:     > %t.log 2> %t.err
# RUN: FileCheck --check-prefix CHECK-ONLYTEST < %t.err %s
# CHECK-ONLYTEST: Configuring with {
# CHECK-ONLYTEST:   one: 'two'
# CHECK-ONLYTEST:   three: 'four'
# CHECK-ONLYTEST: Execute: {{.*}}/fake-make -k -j 1 VERBOSE=1 subtest

# Check --benchmarking-only
# RUN: lnt runtest test-suite \
# RUN:     --sandbox %t.SANDBOX \
# RUN:     --no-timestamp \
# RUN:     --test-suite %S/Inputs/test-suite-cmake \
# RUN:     --cc %{shared_inputs}/FakeCompilers/clang-r154331 \
# RUN:     --use-cmake %S/Inputs/test-suite-cmake/fake-cmake \
# RUN:     --use-make %S/Inputs/test-suite-cmake/fake-make \
# RUN:     --use-lit %S/Inputs/test-suite-cmake/fake-lit \
# RUN:     --benchmarking-only \
# RUN:     --succinct-compile-output \
# RUN:     --verbose \
# RUN:     > %t.log 2> %t.err
# RUN: FileCheck --check-prefix CHECK-BENCHONLY < %t.err %s
# CHECK-BENCHONLY: Configuring with {
# CHECK-BENCHONLY:   TEST_SUITE_BENCHMARKING_ONLY: 'ON'
# CHECK-BENCHONLY-NOT: VERBOSE=1

# Check --use-perf
# RUN: lnt runtest test-suite \
# RUN:     --sandbox %t.SANDBOX \
# RUN:     --no-timestamp \
# RUN:     --test-suite %S/Inputs/test-suite-cmake \
# RUN:     --cc %{shared_inputs}/FakeCompilers/clang-r154331 \
# RUN:     --use-cmake %S/Inputs/test-suite-cmake/fake-cmake \
# RUN:     --use-make %S/Inputs/test-suite-cmake/fake-make \
# RUN:     --use-lit %S/Inputs/test-suite-cmake/fake-lit \
# RUN:     --use-perf=time \
# RUN:     --verbose \
# RUN:     > %t.log 2> %t.err
# RUN: FileCheck --check-prefix CHECK-USE-PERF < %t.err %s
# CHECK-USE-PERF: Configuring with {
# CHECK-USE-PERF:   TEST_SUITE_USE_PERF: 'ON'

# Check that hash, score, compile_time and exec_time get copied into the LNT
# report.
# RUN: lnt runtest test-suite \
# RUN:     --sandbox %t.SANDBOX \
# RUN:     --no-timestamp \
# RUN:     --test-suite %S/Inputs/test-suite-cmake \
# RUN:     --cc %{shared_inputs}/FakeCompilers/clang-r154331 \
# RUN:     --use-cmake %S/Inputs/test-suite-cmake/fake-cmake \
# RUN:     --use-make %S/Inputs/test-suite-cmake/fake-make \
# RUN:     --use-lit %S/Inputs/test-suite-cmake/fake-lit \
# RUN:     --verbose \
# RUN:     > %t.log 2> %t.err
# RUN: FileCheck --check-prefix CHECK-METRICS < %t.SANDBOX/build/report.json %s
# RUN: FileCheck --check-prefix CHECK-METRICS2 < %t.SANDBOX/build/report.json %s
# CHECK-METRICS-DAG: foo.exec
# CHECK-METRICS-DAG: foo.compile
# CHECK-METRICS-DAG: foo.score
# CHECK-METRICS-DAG: foo.hash
# CHECK-METRICS2-NOT: foo.unknown

# Check that with a failing test, a report is still produced.
# RUN: rm -f %t.SANDBOX/build/report.json
# RUN: lnt runtest test-suite \
# RUN:     --sandbox %t.SANDBOX \
# RUN:     --no-timestamp \
# RUN:     --no-configure \
# RUN:     --test-suite %S/Inputs/test-suite-cmake \
# RUN:     --cc %{shared_inputs}/FakeCompilers/clang-r154331 \
# RUN:     --use-cmake %S/Inputs/test-suite-cmake/fake-cmake \
# RUN:     --use-make %S/Inputs/test-suite-cmake/fake-make \
# RUN:     --use-lit %S/Inputs/test-suite-cmake/fake-lit-fails \
# RUN:     --run-order=123 > %t.log 2> %t.err
# RUN: FileCheck --check-prefix CHECK-RESULTS-FAIL < %t.SANDBOX/build/report.json %s
# CHECK-RESULTS-FAIL: "run_order": "123"

# Check a run of test-suite using a cmake cache
# Also make sure we get: compiler defines, cache, other defines on the cmake
# commandline.
# RUN: lnt runtest test-suite \
# RUN:     --sandbox %t.SANDBOX \
# RUN:     --no-timestamp \
# RUN:     --test-suite %S/Inputs/test-suite-cmake \
# RUN:     --cc %{shared_inputs}/FakeCompilers/clang-r154331 \
# RUN:     --use-cmake %S/Inputs/test-suite-cmake/fake-cmake \
# RUN:     --use-make %S/Inputs/test-suite-cmake/fake-make \
# RUN:     --use-lit %S/Inputs/test-suite-cmake/fake-lit \
# RUN:     --cmake-cache Release \
# RUN:     --cmake-define FOO=BAR \
# RUN:     &> %t.cmake-cache.log
# RUN: FileCheck  --check-prefix CHECK-CACHE < %t.cmake-cache.log %s
# CHECK-CACHE: Execute: {{.*}}cmake -DCMAKE_CXX_COMPILER:FILEPATH={{.*}}/FakeCompilers/clang++-r154331 -DCMAKE_C_COMPILER:FILEPATH={{.*}}FakeCompilers/clang-r154331 -C {{.*}}/Release.cmake {{.*}}-DFOO=BAR


# Check a run of test-suite using a invalid cmake cache
# RUN: lnt runtest test-suite \
# RUN:     --sandbox %t.SANDBOX \
# RUN:     --no-timestamp \
# RUN:     --test-suite %S/Inputs/test-suite-cmake \
# RUN:     --cc %{shared_inputs}/FakeCompilers/clang-r154331 \
# RUN:     --use-cmake %S/Inputs/test-suite-cmake/fake-cmake \
# RUN:     --use-make %S/Inputs/test-suite-cmake/fake-make \
# RUN:     --use-lit %S/Inputs/test-suite-cmake/fake-lit \
# RUN:     --cmake-cache Debug \
# RUN:     &> %t.cmake-cache2.err || true
# RUN: FileCheck  --check-prefix CHECK-CACHE2 < %t.cmake-cache2.err %s
# CHECK-CACHE2: Could not find CMake cache file

# Check importing profiles
# RUN: lnt runtest test-suite \
# RUN:     --sandbox %t.SANDBOX \
# RUN:     --no-timestamp \
# RUN:     --test-suite %S/Inputs/test-suite-cmake \
# RUN:     --cc %{shared_inputs}/FakeCompilers/clang-r154331 \
# RUN:     --use-cmake %S/Inputs/test-suite-cmake/fake-cmake \
# RUN:     --use-make %S/Inputs/test-suite-cmake/fake-make \
# RUN:     --use-lit %S/Inputs/test-suite-cmake/fake-lit-profile \
# RUN:     --use-perf=all \
# RUN:     -j2 \
# RUN:     --exec-multisample=2 \
# RUN:     --verbose \
# RUN:     --commit 1 \
# RUN:     > %t.log 2> %t.err
# RUN: FileCheck --check-prefix CHECK-USE-PERF-ALL < %t.err %s
# CHECK-USE-PERF-ALL: Configuring with {
# CHECK-USE-PERF-ALL:   TEST_SUITE_USE_PERF: 'ON'
# Verify that tests get run sequentially when perf profile gathering is enabled:
# CHECK-USE-PERF-ALL: Overriding -j 2 to -j 1
# CHECK-USE-PERF-ALL: fake-lit-profile -v -j 1 {{.*--param profile=perf}}
# Verify that lit gets invoked twice (--exec-multisample=2), but on the second
# run, no perf profile is gathered:
# CHECK-USE-PERF-ALL: fake-lit-profile -v -j 2
# CHECK-USE-PERF-ALL-NOT: --param profile=perf
# CHECK-USE-PERF-ALL: Importing 1 profiles with
# CHECK-USE-PERF-ALL: Profile /tmp/I/Do/Not/Exist.perf_data does not exist

# Check specifying which linux perf events to measure
# RUN: lnt runtest test-suite \
# RUN:     --sandbox %t.SANDBOX \
# RUN:     --no-timestamp \
# RUN:     --test-suite %S/Inputs/test-suite-cmake \
# RUN:     --cc %{shared_inputs}/FakeCompilers/clang-r154331 \
# RUN:     --use-cmake %S/Inputs/test-suite-cmake/fake-cmake \
# RUN:     --use-make %S/Inputs/test-suite-cmake/fake-make \
# RUN:     --use-lit %S/Inputs/test-suite-cmake/fake-lit-profile \
# RUN:     --use-perf=profile \
# RUN:     --perf-events=cycles,cache_misses \
# RUN:     --verbose \
# RUN:     > %t.log 2> %t.err
# RUN: FileCheck --check-prefix CHECK-USE-PERF-EVENT < %t.err %s
# CHECK-USE-PERF-EVENT: fake-lit-profile -v -j 1 {{.*--param profile=perf --param perf_profile_events=cycles,cache_misses}}

# Check a missing --cc on the command line
# RUN: lnt runtest test-suite \
# RUN:     --sandbox %t.SANDBOX \
# RUN:     --no-timestamp \
# RUN:     --test-suite %S/Inputs/test-suite-cmake \
# RUN:     --use-cmake %S/Inputs/test-suite-cmake/fake-cmake \
# RUN:     --use-make %S/Inputs/test-suite-cmake/fake-make \
# RUN:     --use-lit %S/Inputs/test-suite-cmake/fake-lit \
# RUN:     > %t.log 2> %t.err || true
# RUN: FileCheck  --check-prefix CHECK-MISSING-CC < %t.err %s
# CHECK-MISSING-CC: error: Couldn't find C compiler (). Maybe you should specify --cc?

# Check on conflicting -cc and -cmake-define=CMAKE_C_COMPILER
# options, the right compiler gets stored in the json report
# RUN: lnt runtest test-suite \
# RUN:     --sandbox %t.SANDBOX \
# RUN:     --no-timestamp \
# RUN:     --test-suite %S/Inputs/test-suite-cmake \
# RUN:     --cmake-define=CMAKE_C_COMPILER:STRING=%{shared_inputs}/FakeCompilers/clang-r154332 \
# RUN:     --cc %{shared_inputs}/FakeCompilers/clang-r154331 \
# RUN:     --use-cmake %S/Inputs/test-suite-cmake/fake-cmake \
# RUN:     --use-make %S/Inputs/test-suite-cmake/fake-make \
# RUN:     --use-lit %S/Inputs/test-suite-cmake/fake-lit \
# RUN:     > %t.log 2> %t.err || true
# RUN: FileCheck --check-prefix CHECK-CC-CONFL-CMAKEDEFINE < %t.SANDBOX/build/report.json %s
# CHECK-CC-CONFL-CMAKEDEFINE: "run_order": "154332"

# Check that while cross-compiling, the target architecture is recognized
# correctly.
# RUN: lnt runtest test-suite \
# RUN:     --sandbox %t.SANDBOX \
# RUN:     --no-timestamp \
# RUN:     --test-suite %S/Inputs/test-suite-cmake \
# RUN:     --cmake-define=CMAKE_C_COMPILER_TARGET:STRING=targetarch-linux-gnu \
# RUN:     --cc %{shared_inputs}/FakeCompilers/clang-r154331 \
# RUN:     --use-cmake %S/Inputs/test-suite-cmake/fake-cmake \
# RUN:     --use-make %S/Inputs/test-suite-cmake/fake-make \
# RUN:     --use-lit %S/Inputs/test-suite-cmake/fake-lit \
# RUN:     > %t.log 2> %t.err || true
# RUN: FileCheck --check-prefix CHECK-CROSS-TARGET < %t.SANDBOX/build/report.json %s
# CHECK-CROSS-TARGET: "cc_target": "targetarch-linux-gnu"

# Check running with PGO
# RUN: lnt runtest test-suite \
# RUN:     --sandbox %t.SANDBOX \
# RUN:     --no-timestamp \
# RUN:     --test-suite %S/Inputs/test-suite-cmake \
# RUN:     --cc %{shared_inputs}/FakeCompilers/clang-r154331 \
# RUN:     --use-cmake %S/Inputs/test-suite-cmake/fake-cmake \
# RUN:     --use-make %S/Inputs/test-suite-cmake/fake-make \
# RUN:     --use-lit %S/Inputs/test-suite-cmake/fake-lit-profile \
# RUN:     --verbose \
# RUN:     --pgo \
# RUN:     > %t.pgo.log 2> %t.pgo.err
# RUN: FileCheck --check-prefix CHECK-PGO < %t.pgo.err %s
# CHECK-PGO: TEST_SUITE_PROFILE_GENERATE: 'On'
# CHECK-PGO: TEST_SUITE_PROFILE_GENERATE: 'Off'
# CHECK-PGO: TEST_SUITE_PROFILE_USE: 'On'

# Check running with compile only
# RUN: lnt runtest test-suite \
# RUN:     --sandbox %t.SANDBOX \
# RUN:     --no-timestamp \
# RUN:     --test-suite %S/Inputs/test-suite-cmake \
# RUN:     --cc %{shared_inputs}/FakeCompilers/clang-r154331 \
# RUN:     --use-cmake %S/Inputs/test-suite-cmake/fake-cmake \
# RUN:     --use-make %S/Inputs/test-suite-cmake/fake-make \
# RUN:     --use-lit %S/Inputs/test-suite-cmake/fake-lit-profile \
# RUN:     --verbose \
# RUN:     --only-compile \
# RUN:     > %t.pgo.log 2> %t.compile-only.err
# RUN: FileCheck --check-prefix CHECK-CO < %t.compile-only.err %s
# CHECK-CO: TEST_SUITE_RUN_BENCHMARKS: 'Off'

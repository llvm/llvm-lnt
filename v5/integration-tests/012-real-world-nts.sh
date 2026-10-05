#!/usr/bin/env bash
#
# Submit real `nts` runs from lnt.llvm.org, converted to O1's format, and check that they read
# back through the public API.
#
# The in-process suite covers each endpoint's rules with synthetic data. This is about real data
# end to end instead: test names full of punctuation, kilobytes of multi-line compiler provenance
# in `run_parameters`, metrics that only some tests carry, and repetitions within a run, for three
# machines over three commits. fixtures/nts/README.md says where the data comes from.
#
# Most expectations are derived from the fixtures, so that the check says "what was submitted
# reads back" rather than restating hundreds of values. A few are written out by hand, so that a
# mistake made the same way on both sides of a comparison cannot go unnoticed.

source "$(dirname "$0")/lib.sh"

readonly FIXTURES="$(dirname "$0")/fixtures/nts"
readonly SUITE="${BASE_URL}/api/suites/nts"
readonly RUNS=("$FIXTURES"/runs/*.json)

# Assigned apart from `readonly`, whose own exit status would otherwise hide a failing `mint_key`.
token="$(mint_key real-world manage)"
readonly AUTH="Authorization: Bearer ${token}"
readonly JSON='Content-Type: application/json'

# The samples a test entry stands for (O1): one per array element, with the entry's scalars
# repeated on each, shaped like the samples endpoint's items.
readonly SAMPLES='def samples:
    del(.name) as $metrics
    | ([$metrics[] | arrays | length] | max // 1) as $count
    | range($count) as $i
    | {test: .name, metrics: ($metrics | map_values(if type == "array" then .[$i] end))};'

# fixture [jq options...] <filter> -- evaluate the filter over the array of every fixture run.
fixture() {
    jq --slurp --compact-output "$@" "${RUNS[@]}"
}

echo "  the suite is created from its schema"
request -X POST -H "$AUTH" -H "$JSON" --data-binary "@${FIXTURES}/schema.json" \
    "${BASE_URL}/api/suites"
expect_status 201

echo "  every run is accepted under its own UUID, and reads back as sent, one sample per repetition"
for run in "${RUNS[@]}"; do
    uuid="$(jq --raw-output .uuid "$run")"
    request -X POST -H "$AUTH" -H "$JSON" --data-binary "@${run}" "${SUITE}/runs"
    expect_status 201
    expect_header Location "/api/suites/nts/runs/${uuid}"

    # Read back rather than taken from the 201, so that it may well be another worker answering.
    request "${SUITE}/runs/${uuid}"
    expect_status 200
    expect_json '{uuid, machine, commit, run_parameters} == $sent' --argjson sent \
        "$(jq '{uuid, machine: .machine.name, commit: .commit.value, run_parameters}' "$run")"

    request "${SUITE}/runs/${uuid}/samples?limit=10000"
    expect_status 200
    expect_json '.cursor.next == null and (.items | sort) == $samples' \
        --argjson samples "$(jq "${SAMPLES}"' [.tests[] | samples] | sort' "$run")"
done

echo "  resubmitting a run is refused as a duplicate, and stores nothing"
request -X POST -H "$AUTH" -H "$JSON" --data-binary "@${RUNS[0]}" "${SUITE}/runs"
expect_status 409
expect_body '"code":"duplicate"'

request "${SUITE}/runs?limit=100"
expect_status 200
expect_json '.items | length == $count' --argjson count "${#RUNS[@]}"

echo "  the submissions created the machines"
request "${SUITE}/machines"
expect_status 200
expect_json '.total == ($names | length) and [.items[].name] == $names
    and all(.items[]; .tracked and .last_run_at != null)' \
    --argjson names "$(fixture '[.[].machine.name] | unique')"

echo "  and the commits, in ordinal order, with their revision"
request "${SUITE}/commits?sort=ordinal"
expect_status 200
expect_json '.items == $commits' --argjson commits \
    "$(fixture '[.[].commit | {value, ordinal, tag: null, fields}] | unique | sort_by(.ordinal)')"

read -r -a commits <<< "$(fixture --raw-output '[.[].commit] | unique | sort_by(.ordinal)
    | map(.value) | join(" ")')"
request "${SUITE}/commits/${commits[1]}"
expect_status 200
expect_json '.previous.value == $previous and .next.value == $next' \
    --arg previous "${commits[0]}" --arg next "${commits[2]}"

readonly NAMD='External/SPEC/CFP2017rate/508.namd_r/508.namd_r'
readonly MEMCMP='MicroBenchmarks/MemFunctions/MemFunctions.test:BM_MemCmp<1, EqZero, First>'

echo "  spot checks against values copied by hand from lnt.llvm.org"
uuid="$(jq --raw-output .uuid "${FIXTURES}/runs/r598181-sifive.json")"
request --get "${SUITE}/runs/${uuid}/samples" --data-urlencode "test=${NAMD}"
expect_status 200
expect_json '[.items[].metrics.execution_time] | sort == [77.3951, 77.4685, 77.6171]'
expect_json '[.items[].metrics | del(.execution_time)] | unique
    == [{"code_size": 383518, "hash": "9cfd3c5460f1d1930fe34bf9bc55b91a"}]'

request --get "${SUITE}/runs/${uuid}/samples" --data-urlencode "test=${MEMCMP}"
expect_status 200
expect_json '[.items[].metrics.execution_time] | sort
    == [11881.278538812785, 11882.448840961193, 11884.851777649495]'

request "${SUITE}/commits/dc0abebc8e834bceea9a467f07e124ab944e9be9"
expect_status 200
expect_json '.ordinal == 598181 and .fields.llvm_project_revision == "r598181"'

read -r -a machines <<< "$(fixture --raw-output '[.[].machine.name] | unique | join(" ")')"
readonly MACHINE="${machines[0]}"

echo "  a time series reads back across commits, in ordinal order"
request -X POST -H "$JSON" --data "$(jq --null-input --compact-output \
    --arg machine "$MACHINE" --arg test "$NAMD" \
    '{metric: "execution_time", machine: $machine, test: [$test], sort: "commit", limit: 1000}')" \
    "${SUITE}/query"
expect_status 200
expect_json '[.items[].ordinal] == ([.items[].ordinal] | sort)
    and ([.items[] | {machine, commit, ordinal, value}] | sort) == $points' --argjson points \
    "$(fixture --arg machine "$MACHINE" --arg test "$NAMD" "${SAMPLES}"'
        [.[] | select(.machine.name == $machine) | . as $run
         | .tests[] | select(.name == $test) | samples
         | {machine: $machine, commit: $run.commit.value, ordinal: $run.commit.ordinal,
            value: .metrics.execution_time}]
        | sort')"

echo "  trends are the geomean of each run's per-test medians"
# O9: a test's repetitions reduce to their median, and a run's value is the geomean of those,
# skipping any that are not positive. There is one run per machine and commit here, so each trend
# point is one run's geomean.
machine_args=()
for machine in "${machines[@]}"; do
    machine_args+=(--data-urlencode "machine=${machine}")
done
request --get "${SUITE}/trends" --data metric=execution_time "${machine_args[@]}"
expect_status 200
expect_json '[.items[] | {machine, commit, ordinal}] == [$trends[] | {machine, commit, ordinal}]
    and ([.items, $trends] | transpose
         | all((.[0].value - .[1].value | fabs) <= 1e-9 * .[1].value))' \
    --argjson trends "$(fixture "${SAMPLES}"'
        def median: sort | if length % 2 == 1 then .[length / 2 | floor]
                           else (.[length / 2 - 1] + .[length / 2]) / 2 end;
        [.[] | {machine: .machine.name, commit: .commit.value, ordinal: .commit.ordinal,
                value: ([.tests[] | [samples | .metrics.execution_time // empty]
                         | select(length > 0) | median | select(. > 0) | log]
                        | add / length | exp)}]
        | sort_by(.machine, .ordinal)')"

echo "  tests are listed, and filtered by machine and by metric"
request "${SUITE}/tests?limit=10000"
expect_status 200
expect_json '[.items[].name] | sort == $names' \
    --argjson names "$(fixture '[.[].tests[].name] | unique')"

for metric in execution_time code_size hash; do
    request --get "${SUITE}/tests" --data limit=10000 --data "metric=${metric}" \
        --data-urlencode "machine=${MACHINE}"
    expect_status 200
    expect_json '[.items[].name] | sort == $names' --argjson names "$(fixture \
        --arg machine "$MACHINE" --arg metric "$metric" \
        '[.[] | select(.machine.name == $machine) | .tests[] | select(has($metric)) | .name]
         | unique')"
done

# Declared by the schema, but never reported by lnt.llvm.org's bots.
request "${SUITE}/tests?metric=compile_time"
expect_status 200
expect_json '.items == []'

request --get "${SUITE}/tests" --data-urlencode 'search=eqzero, first'
expect_status 200
expect_json '.items == [{"name": $name}]' --arg name "$MEMCMP"

echo "  deleting the suite removes it"
request -X DELETE -H "$AUTH" "${SUITE}?confirm=true"
expect_status 204

"""The example values I8's document shows (I8).

Swagger UI fills in a sample for every request and response from the document, and makes up values
for any field without an example: `"string"` for most, and random strings matching the pattern for
names. Every example the document carries comes from here instead, so that they all describe one
plausible suite -- libc++'s benchmarks, as `tests/data/libcxx` holds real runs of -- and agree with
each other: the machine a run example names is the machine the machine examples describe, and so
on.

Plain data, with no imports from the rest of the package, so that the models in `suites/` and the
routes can both use it.
"""

from __future__ import annotations

from typing import Any

SUITE = "libcxx"

# `tests/data/libcxx/schema.json`, with every optional key written out, as the API returns it.
METRICS: list[dict[str, Any]] = [
    {
        "name": "execution_time",
        "type": "real",
        "display_name": "Execution Time",
        "unit": "seconds",
        "unit_abbrev": "s",
        "bigger_is_better": False,
    },
    {
        "name": "instructions",
        "type": "real",
        "display_name": "Instructions Retired",
        "unit": "instructions",
        "unit_abbrev": "instr",
        "bigger_is_better": False,
    },
    {
        "name": "max_rss",
        "type": "real",
        "display_name": "Maximum Resident Set Size",
        "unit": "megabytes",
        "unit_abbrev": "mb",
        "bigger_is_better": False,
    },
    {
        "name": "cycles",
        "type": "real",
        "display_name": "Cycles Elapsed",
        "unit": "cycles",
        "unit_abbrev": "cycles",
        "bigger_is_better": False,
    },
    {
        "name": "peak_memory",
        "type": "real",
        "display_name": "Peak Memory Footprint",
        "unit": "megabytes",
        "unit_abbrev": "mb",
        "bigger_is_better": False,
    },
]
MACHINE_FIELDS: list[dict[str, Any]] = [
    {"name": "hardware", "type": "text", "display_name": None, "searchable": True},
    {"name": "os", "type": "text", "display_name": None, "searchable": True},
    {"name": "test_suite_commit", "type": "text", "display_name": None, "searchable": False},
    {"name": "compiler", "type": "text", "display_name": None, "searchable": False},
    {"name": "sdk", "type": "text", "display_name": None, "searchable": False},
]
COMMIT_FIELDS: list[dict[str, Any]] = [
    {
        "name": "svn_revision",
        "type": "text",
        "display_name": None,
        "searchable": True,
        "display": True,
    },
    {
        "name": "commit_info",
        "type": "text",
        "display_name": None,
        "searchable": False,
        "display": False,
    },
]
SUITE_SCHEMA: dict[str, Any] = {
    "name": SUITE,
    "metrics": METRICS,
    "commit_fields": COMMIT_FIELDS,
    "machine_fields": MACHINE_FIELDS,
}

METRIC = "execution_time"
OTHER_METRIC = "instructions"

# Two machines, from the real runs.
MACHINE = "linux-x86_64"
MACHINE_VALUES: dict[str, Any] = {
    "hardware": "AMD EPYC 9654",
    "os": "Ubuntu 24.04",
    "test_suite_commit": "8bb5e216937e6b541f351aa1637c67e85a43ada0",
    "compiler": "clang version 22.1.0",
    "sdk": None,
}
OTHER_MACHINE = "macos-26.5-arm64"
OTHER_MACHINE_VALUES: dict[str, Any] = {
    "hardware": "Apple M4",
    "os": "macOS 26.5 (25F71)",
    "test_suite_commit": "8bb5e216937e6b541f351aa1637c67e85a43ada0",
    "compiler": "Apple clang version 21.0.0 (clang-2100.1.1.101)",
    "sdk": "26.5",
}

# Three commits. The first two are from the real runs; the third is made up, to come after them.
PREVIOUS_COMMIT = "97367d1046a2ec81e9b4e708ae7acdc83d99dcf7"
PREVIOUS_ORDINAL = 554220
COMMIT = "45c41247f82e5691425542de829d568cdc2fb580"
ORDINAL = 554973
COMMIT_VALUES: dict[str, Any] = {
    "svn_revision": "r554973",
    "commit_info": "[libc++] Vectorize std::find_if",
}
NEXT_COMMIT = "b2c7e9f0d14a8b36c5e2f7a90d3e41b6c8a5f217"
NEXT_ORDINAL = 555402
TAG = "llvmorg-22.1.0"

TEST = "std::find_if(vector<char>)_(bail_25%)/8"
OTHER_TEST = "std::stable_sort(vector<int>)_(heap)/8192"

RUN_UUID = "ae93bcbf-4499-4be0-bf2d-0d915fee692a"
RUN_PARAMETERS: dict[str, Any] = {
    "start_time": "2026-08-14T01:57:57",
    "end_time": "2026-08-14T02:41:12",
}
PROFILE_UUID = "6f1c2a9e-3b7d-4e58-9a1f-0c8d2e4b7a63"
REGRESSION_UUID = "c4e1b7a2-9d3f-4a6e-8b5c-2f7e1d9a0b34"
INDICATOR_UUID = "0b7e3f6c-5d2a-4c1e-9f8b-7a6d5c4b3a21"

REGRESSION_TITLE = "std::find_if slowdown on x86-64"
BUG = "https://github.com/llvm/llvm-project/issues/160237"

API_KEY_NAME = "libcxx-ci-linux"
API_KEY_TOKEN = "3f0ac1129b6e4d7a8c5f2e1b0d9a7c6e5f4b3a2918d7c6b5a4f3e2d1c0b9a8f7"

# A test's samples in one run, as a run submission and the sample list carry them.
SAMPLE_METRICS: dict[str, Any] = {
    "execution_time": 3.284,
    "instructions": 14211.0,
    "cycles": 9874.0,
}

# A profile of `TEST`, small enough to read.
PROFILE_COUNTERS: dict[str, int] = {"cycles": 9123456, "instructions": 12000000}
FUNCTION = "std::__1::__find_if<char const*, char const*, Pred>(char const*, char const*, Pred&)"
INSTRUCTION_COUNTERS: dict[str, float] = {"cycles": 1200.0, "instructions": 900.0}
FUNCTION_COUNTERS: dict[str, float] = {"cycles": 4123456.0, "instructions": 5400000.0}
INSTRUCTION_TEXT = "ldrb w8, [x0], #1"
DISASSEMBLY_FORMAT = "llvm-objdump"

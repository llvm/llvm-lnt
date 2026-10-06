# Real-world `nts` runs

Runs of the `nts` suite from LLVM's LNT v4 instance, converted to the v5 submission format (O1).
`tests/test_real_world.py` submits them and reads them back.

## Source

Three machines, each at the same three LLVM commits:

| Machine (v4 machine id) | Commits (LLVM revision) |
|---|---|
| `bpif3-rva22u64_v-ReleaseLTO__clang_DEV__riscv64` (2) | r597917, r597974, r598181 |
| `sifive-p550-rv64gc_zba_zbb-ReleaseLTO__clang_DEV__riscv64` (1) | r597917, r597974, r598181 |
| `spacemit-k3-rva23u64-ReleaseLTO__clang_DEV__riscv64` (6) | r597917, r597974, r598181 |

The runs were started between 2026-09-19 and 2026-09-22; each file's `run_parameters.start_time`
identifies it among the runs of its v4 machine. They were fetched from the v4 REST API into a local
mirror on 2026-09-25, without recording the v4 run ids, and converted from that mirror on
2026-10-05.

## Conversion

- `schema.json` is v4's `schemas/nts.yaml` in D4's format: `Real` metrics are `real`, `Status`
  ones `integer` and `Hash` ones `text`, with the same display names, units and
  `bigger_is_better`. `ignore_same_hash` has no v5 equivalent and is dropped. v4's order field,
  the LLVM revision (`r598181`), describes the commit rather than the run, so it becomes the
  commit's ordinal. The commit field `svn_revision` is new, and so are `searchable` and `display`,
  of which v4 has no notion: `hardware`, `os` and `svn_revision` are searchable, and `svn_revision`
  is the commit's display value, so that the UI shows `r598181` rather than a SHA.
- `machine`: the v4 name. The v4 instance has no `hardware` or `os` for these machines, so `fields`
  is omitted.
- `commit`: `value` is the LLVM commit the compiler was built from (v4's `cc_src_revision`),
  `ordinal` is the number in v4's order field, and `fields` holds `svn_revision`, synthesized from
  the ordinal (`r598181`): LLVM's revision number in the style of its Subversion days, which no SHA
  can contain, so that a search for it only matches the field.
- `run_parameters`: every other v4 run field, verbatim, except v4's bookkeeping (`id`,
  `order_id`, `order_by`).
- `tests`: v4 reports one sample per repetition, so each test's samples are merged into one entry.
  A metric whose value differs between repetitions becomes an array; one that is the same on
  every repetition (`code_size`, `hash`) stays a scalar, which O1 repeats on each sample, so the
  stored samples are the same either way. Metrics v4 reports as null are omitted.
- `uuid` is random, generated once, so that the runs are submitted under client-provided UUIDs.

## Trimming

Each run measured 1464 tests, 3 repetitions each, which comes to about 290 KB per run once
converted. Only 32 tests are kept, the same ones in every run, picked to cover each part of the
test-suite (SPEC, MultiSource, SingleSource, MicroBenchmarks, tools) and the shapes the data
takes: names with `+`, `:`, `<`, `>`, `,` and spaces, Google Benchmark binaries (`code_size` and
`hash`, no `execution_time`) next to the benchmarks they contain (`execution_time` only), and
`tools/fpcmp-target`, which has no `code_size`. That brings each run to about 21 KB, most of it
the run's compiler provenance (`cc_version`, `cc_target_assembly`, ...), which is kept whole.

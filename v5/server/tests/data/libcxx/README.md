# Real-world `libcxx` runs

Thirty-two runs of the `libcxx` suite (libc++'s benchmarks) from [lnt.llvm.org](https://lnt.llvm.org),
which runs LNT v4, converted to the v5 submission format (O1). `tests/test_real_world.py` submits
them and reads them back.

## Source

Three machines, each at the same three consecutive weekly LLVM commits:

| Machine (v4 machine id) | Runs at r552558, r554220, r554973 |
|---|---|
| `linux-x86_64-20260812` (7) | 3, 3, 3 |
| `macos-26.5-arm64-20260812` (5) | 3, 3, 3 |
| `macos-26.5-arm64-hardenedfast-20260821` (8) | 5, 5, 4 |

The `hardenedfast` machine is the same hardware and compiler as the other macOS one, building
libc++ with `_LIBCPP_HARDENING_MODE=fast`; only its name says so. Every run at r554220
(`97367d1046a2`) reported no tests at all, on every machine, so those 11 runs are empty.

Each file's `run_parameters.start_time` identifies it among its machine's runs at
`https://lnt.llvm.org/db_default/v4/libcxx/machine/<v4 machine id>`. They were fetched from the v4
REST API into a local mirror between 2026-08-14 and 2026-09-25, and converted from that mirror on
2026-10-05. At conversion, three of them were checked value for value against lnt.llvm.org:
`r554973-linux-1` is v4 run 339, `r554973-macos-2` run 563 and `r554973-hardenedfast-3` run 1536.

## Conversion

- `schema.json` is libc++'s `libcxx/utils/ci/lnt/schemas/libcxx.yaml` in D4's format: its `Real`
  metrics are `real`, with the same display names and units. v4's run fields describe the commit
  rather than the run: `git_sha` is the commit's identity, and `llvm_project_revision` (the order
  field) and `commit_info` are commit fields. None of these runs reports `commit_info`. v4 has no
  notion of `searchable` or `display`, so those are new: `hardware`, `os` and
  `llvm_project_revision` are searchable, and `llvm_project_revision` is the commit's display value.
- `machine`: the v4 name, and as `fields` whichever v4 machine fields the machine reports. The
  Linux machine has no `hardware`, `os` or `sdk`.
- `commit`: `value` is v4's `git_sha`, `ordinal` is `llvm_project_revision` as an integer, and
  `fields` keeps `llvm_project_revision` itself.
- `run_parameters`: every other v4 run field, verbatim, except v4's bookkeeping (`id`,
  `order_id`, `order_by`).
- `tests`: these bots report one sample per test per run, repeating a commit with several runs
  instead, so every metric is a scalar. Only `execution_time` is reported; v4 reports the other
  metrics as null, and they are omitted.
- `uuid` is random, generated once, so that the runs are submitted under client-provided UUIDs.

## Trimming

Each run measured 5987 tests, plus 24 `BM_from_sys/...` ones that only the Linux machine runs, which
comes to about 700 KB per run. Only 25 tests are kept, the same ones in every run, picked for the
shapes their names take: `"`, `%`, `{}`, `^`, `&`, `+`, `=`, `*`, `:`, `,`, and `/` both inside
parentheses and between underscores; the longest name (103 characters); and two of the
Linux-only tests, so that the machines' test lists differ.

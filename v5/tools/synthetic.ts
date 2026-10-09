/**
 * The synthetic part of the seed data: a libcxx history long enough for the Dashboard and the Graph
 * to draw something meaningful, and the variety the UI has to handle.
 *
 * It continues the history of the real libcxx machines after their newest real commit, starting
 * from the values they measured there, with noise and a few deliberate changes (`EFFECTS`), which
 * the regressions it creates describe. Everything is derived from fixed seeds, so every run of the
 * seed tool submits exactly the same data.
 */

import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import type { components } from '../client/src/api/schema.d.ts'

type Schemas = components['schemas']
export type Submission = Schemas['RunSubmission']
export type RegressionCreate = Schemas['RegressionCreate']
type ProfileDocument = Schemas['ProfileDocument']

// The real machines (see server/tests/data/libcxx/README.md).
export const LINUX = 'linux-x86_64-20260812'
export const MACOS = 'macos-26.5-arm64-20260812'
export const HARDENED = 'macos-26.5-arm64-hardenedfast-20260821'
const TRACKED = [LINUX, MACOS, HARDENED]

/** A configuration of the macOS machine kept out of the Dashboard: `tracked: false` (D5). */
export const UNTRACKED = 'macos-26.5-arm64-O3'

const COMMITS = 40
/** The distance between the ordinals of consecutive synthetic commits. */
const ORDINAL_STEP = 37
const TAGGED_COMMIT = 19
export const TAG = 'llvmorg-22.1.0'
/** An ad-hoc A/B experiment on the newest commit: a commit with no ordinal (D1). */
export const EXPERIMENT = 'experiment-faster-format'

/** A change to some tests' values from commit `from` on, until commit `until` (excluded). */
interface Effect {
  tests: RegExp
  machines?: string[]
  from: number
  until?: number
  factor: number
}

const FORMAT_TESTS = /^std::format\(/
const COPY_TESTS = /operator=\(const_Self&\)|::ctor\(const_Self&/
const PATH_TESTS = /^filesystem::path/
const SORT_TESTS = /make_heap|stable_sort/
const ALL_TESTS = /./

// Most change a few tests, which hardly moves a run's geomean; the one on every test of the
// hardened machine is the step that the Dashboard shows.
const EFFECTS: Effect[] = [
  { tests: PATH_TESTS, machines: [MACOS], from: 6, until: 9, factor: 1.25 },
  { tests: FORMAT_TESTS, from: 12, factor: 1.15 },
  { tests: ALL_TESTS, machines: [HARDENED], from: 22, factor: 1.06 },
  { tests: COPY_TESTS, machines: [LINUX], from: 26, factor: 1.1 },
  { tests: SORT_TESTS, from: 33, factor: 0.88 },
]

const NOISE = 0.015
const NOISY_TEST = 'dynamic_cast_(Chain,_1_level)'
const NOISY_TEST_NOISE = 0.06
const SAMPLES_PER_RUN = 3
const CLOCK_GHZ: Record<string, number> = {
  [LINUX]: 3.0,
  [MACOS]: 4.4,
  [HARDENED]: 4.4,
  [UNTRACKED]: 4.4,
}

/** A deterministic stream of numbers in [0, 1) (mulberry32), seeded by `name`. */
function random(name: string): () => number {
  let state = createHash('sha256').update(name).digest().readUInt32LE(0)
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** A standard normal deviate (Box-Muller). */
function gaussian(rand: () => number): number {
  return Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand())
}

/** A UUID derived from `name`, in the standard format and marked as version 4. */
export function uuidFor(name: string): string {
  const h = createHash('sha256').update(name).digest('hex')
  const variant = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16)
  const groups = [h.slice(0, 8), h.slice(8, 12), `4${h.slice(13, 16)}`, variant + h.slice(17, 20)]
  return [...groups, h.slice(20, 32)].join('-')
}

function round(value: number): number {
  return Number(value.toPrecision(6))
}

/**
 * Each tracked machine's mean `execution_time` per test at the newest real commit that has any,
 * and that commit's ordinal.
 */
function baselines(realRuns: Submission[]) {
  const measured = realRuns.filter((run) => run.tests.length > 0)
  const newest = Math.max(...measured.map((run) => run.commit.ordinal ?? 0))
  const tests = new Map<string, Map<string, number>>()
  for (const machine of TRACKED) {
    const runs = measured.filter(
      (run) => run.commit.ordinal === newest && run.machine.name === machine,
    )
    if (runs.length === 0) throw new Error(`No real libcxx runs of ${machine} to start from`)
    const values = new Map<string, number[]>()
    for (const test of runs.flatMap((run) => run.tests)) {
      values.set(test.name, [...(values.get(test.name) ?? []), test.execution_time as number])
    }
    const mean = (v: number[]) => v.reduce((a, b) => a + b) / v.length
    tests.set(machine, new Map([...values].map(([test, v]) => [test, mean(v)])))
  }
  return { newest, tests }
}

/**
 * The test entries of one run of `machine`: each test's baseline, times `factor(test)`, plus noise.
 * There is deliberately no `peak_memory`, which no run ever reports, so that one Dashboard card has
 * no data at all.
 */
function testEntries(
  machine: string,
  tests: Map<string, number>,
  factor: (test: string) => number,
  seed: string,
): Submission['tests'] {
  return [...tests].map(([test, baseline]) => {
    const rand = random(`${seed}/${test}`)
    const noise = test === NOISY_TEST ? NOISY_TEST_NOISE : NOISE
    const level = baseline * factor(test)
    const value = level * (1 + 0.5 * noise * gaussian(rand))
    const times = Array.from(
      { length: SAMPLES_PER_RUN },
      () => value * (1 + noise * gaussian(rand)),
    )
    const hashed = random(test)
    const ipc = 1.5 + 2.5 * hashed()
    const rss = 1.5 + 38 * hashed()
    const clock = CLOCK_GHZ[machine]
    return {
      name: test,
      execution_time: times.map(round),
      cycles: times.map((time) => round(time * clock * (1 + 0.005 * gaussian(rand)))),
      instructions: round(level * clock * ipc * (1 + 0.002 * gaussian(rand))),
      max_rss: round(rss * (1 + 0.01 * gaussian(rand))),
    }
  })
}

function effectsAt(i: number, machine: string, test: string): number {
  return EFFECTS.filter(
    (effect) =>
      effect.tests.test(test) &&
      (effect.machines === undefined || effect.machines.includes(machine)) &&
      i >= effect.from &&
      (effect.until === undefined || i < effect.until),
  ).reduce((factor, effect) => factor * effect.factor, 1)
}

function runParameters(i: number, run: number): Record<string, unknown> {
  const start = new Date(Date.UTC(2026, 8, 1, 4) + (i * 12 + run) * 3600_000)
  const end = new Date(start.getTime() + 25 * 60_000)
  const iso = (date: Date) => date.toISOString().slice(0, 19)
  return { start_time: iso(start), end_time: iso(end) }
}

/** The synthetic runs to submit, in order, and the regressions to create once they are stored. */
export function libcxxSynthetic(realRuns: Submission[]): {
  runs: Submission[]
  regressions: RegressionCreate[]
} {
  const { newest, tests } = baselines(realRuns)
  const ordinalOf = (i: number) => newest + ORDINAL_STEP * (i + 1)
  const commitOf = (i: number) =>
    createHash('sha1').update(`libcxx/${ordinalOf(i)}`).digest('hex')
  const macosFields = realRuns.find((run) => run.machine.name === MACOS)?.machine.fields
  const runs: Submission[] = []

  /** Add a run of `machine`, measuring like `measured` does, times `factor`. */
  function addRun(
    machine: string,
    commit: Submission['commit'],
    seed: string,
    factor: (test: string) => number,
    options: {
      measured?: string
      profile?: { isa: Isa; speedup: number }
      parameters: Record<string, unknown>
    },
  ) {
    const entries = testEntries(machine, tests.get(options.measured ?? machine)!, factor, seed)
    if (options.profile) addProfiles(entries, options.profile.isa, options.profile.speedup, seed)
    runs.push({
      format_version: '5',
      uuid: uuidFor(seed),
      machine:
        machine === UNTRACKED
          ? { name: machine, tracked: false, fields: macosFields }
          : { name: machine },
      commit,
      run_parameters: options.parameters,
      tests: entries,
    })
  }

  for (let i = 0; i < COMMITS; i++) {
    const commit: Submission['commit'] = {
      value: commitOf(i),
      ordinal: ordinalOf(i),
      tag: i === TAGGED_COMMIT ? TAG : null,
      fields: {
        svn_revision: `r${ordinalOf(i)}`,
        commit_info: `[libc++] Synthetic commit ${i + 1} of ${COMMITS}`,
      },
    }
    // Some commits are measured twice, so that runs need aggregating.
    const repetitions = i % 5 === 0 ? 2 : 1
    for (const machine of [...TRACKED, ...(i >= COMMITS - 10 ? [UNTRACKED] : [])]) {
      // The untracked configuration builds with -O3: the macOS machine's values, a little faster.
      const measured = machine === UNTRACKED ? MACOS : machine
      const base = machine === UNTRACKED ? 0.94 : 1
      for (let run = 0; run < repetitions; run++) {
        const profiled = i === COMMITS - 1 && run === 0 && (machine === LINUX || machine === MACOS)
        const isa = machine === LINUX ? 'x86-64' : 'aarch64'
        const factor = (test: string) => base * effectsAt(i, measured, test)
        addRun(machine, commit, `libcxx/${machine}/${i}/${run}`, factor, {
          measured,
          profile: profiled ? { isa, speedup: 1 } : undefined,
          parameters: runParameters(i, run),
        })
      }
    }
  }

  // The experiment: the newest commit's Linux build, with a faster std::format.
  const experiment: Submission['commit'] = {
    value: EXPERIMENT,
    fields: { commit_info: 'A/B experiment: a faster floating-point path for std::format' },
  }
  for (let run = 0; run < 2; run++) {
    const factor = (test: string) =>
      effectsAt(COMMITS - 1, LINUX, test) * (FORMAT_TESTS.test(test) ? 0.8 : 1)
    addRun(LINUX, experiment, `libcxx/${LINUX}/${EXPERIMENT}/${run}`, factor, {
      profile: run === 0 ? { isa: 'x86-64', speedup: 0.8 } : undefined,
      parameters: { ...runParameters(COMMITS, run), experiment: 'faster-format' },
    })
  }

  return { runs, regressions: regressions(tests, commitOf) }
}

function regressions(
  tests: Map<string, Map<string, number>>,
  commitOf: (i: number) => string,
): RegressionCreate[] {
  const matching = (pattern: RegExp, machine = LINUX) =>
    [...tests.get(machine)!.keys()].filter((test) => pattern.test(test))
  const indicators = (machines: string[], names: string[], metrics = ['execution_time']) =>
    machines.flatMap((machine) =>
      names.flatMap((test) => metrics.map((metric) => ({ machine, test, metric }))),
    )
  return [
    {
      uuid: uuidFor('libcxx/regression/format'),
      title: 'std::format slowdown',
      state: 'active',
      commit: commitOf(12),
      bug: 'https://example.com/bugs/1001',
      notes: 'About 15% slower on every machine, std::format only.\nBisected to this commit.',
      indicators: indicators(TRACKED, matching(FORMAT_TESTS), ['execution_time', 'cycles']),
    },
    {
      uuid: uuidFor('libcxx/regression/hardened'),
      title: 'Everything slower in hardened mode',
      state: 'active',
      commit: commitOf(22),
      notes: 'About 6% slower on every test, on the hardened machine only.',
      indicators: indicators([HARDENED], matching(ALL_TESTS, HARDENED)),
    },
    {
      uuid: uuidFor('libcxx/regression/copy'),
      title: 'Copy operations slower on Linux',
      state: 'detected',
      commit: commitOf(26),
      indicators: indicators([LINUX], matching(COPY_TESTS)),
    },
    {
      uuid: uuidFor('libcxx/regression/path'),
      title: 'filesystem::path construction regressed on macOS',
      state: 'fixed',
      commit: commitOf(6),
      notes: 'The change was reverted three commits later.',
      indicators: indicators([MACOS], matching(PATH_TESTS, MACOS)),
    },
    {
      uuid: uuidFor('libcxx/regression/noise'),
      title: `${NOISY_TEST} jumps around`,
      state: 'false_positive',
      commit: commitOf(17),
      notes: 'This benchmark is noisy on every machine; the change is within its usual spread.',
      indicators: indicators(TRACKED, [NOISY_TEST]),
    },
    {
      uuid: uuidFor('libcxx/regression/hardening'),
      title: 'Hardening overhead in std::find_if',
      state: 'not_to_be_fixed',
      commit: commitOf(0),
      notes: 'The cost of the bounds checks that hardened mode adds. Expected.',
      indicators: indicators([HARDENED], matching(/^std::find_if/, HARDENED)),
    },
    {
      // No title, no commit and no indicators: the least a regression can be.
      uuid: uuidFor('libcxx/regression/untitled'),
      state: 'detected',
      notes: 'Spotted on the dashboard; not investigated yet.',
    },
  ]
}

// ---------------------------------------------------------------------------------------------
// Profiles (O7)
// ---------------------------------------------------------------------------------------------

type Isa = 'x86-64' | 'aarch64'

/** Instructions in one ISA, in llvm-objdump's style. `{target}` is a branch target. */
interface Code {
  base: number
  prologue: string[]
  body: string[]
  skip: string[]
  loop: string[]
  epilogue: string[]
}

const CODE: Record<Isa, Code> = {
  'x86-64': {
    base: 0x401000,
    prologue: ['push   rbp', 'mov    rbp, rsp', 'push   rbx', 'sub    rsp, 0x18'],
    body: [
      'mov    rax, qword ptr [rdi + 0x8]',
      'mov    ecx, dword ptr [rax + 4*rdx]',
      'add    ecx, esi',
      'imul   ecx, ecx, 0x2d',
      'mov    dword ptr [rbx + 4*rdx], ecx',
      'movsd  xmm0, qword ptr [rbp - 0x10]',
      'mulsd  xmm0, xmm1',
      'inc    rdx',
    ],
    skip: ['test   rax, rax', 'je     0x{target}'],
    loop: ['cmp    rdx, r8', 'jne    0x{target}'],
    epilogue: ['add    rsp, 0x18', 'pop    rbx', 'pop    rbp', 'ret'],
  },
  aarch64: {
    base: 0x100004000,
    prologue: ['stp    x29, x30, [sp, #-16]!', 'mov    x29, sp'],
    body: [
      'ldr    x8, [x0, #8]',
      'ldr    w9, [x8, x2, lsl #2]',
      'add    w9, w9, w1',
      'mul    w9, w9, w10',
      'str    w9, [x3, x2, lsl #2]',
      'fmul   d0, d0, d1',
      'ldrb   w8, [x0], #1',
      'add    x2, x2, #1',
    ],
    skip: ['cbz    x8, 0x{target}'],
    loop: ['cmp    x2, x4', 'b.ne   0x{target}'],
    epilogue: ['ldp    x29, x30, [sp], #16', 'ret'],
  },
}

/** One of the tests that carry a profile (see FUNCTIONS). */
export const PROFILED_TEST = 'std::stable_sort(vector<int>)_(heap)/8192'

/**
 * The tests that carry a profile on the newest commit and in the experiment, with their
 * functions, hottest first: each one's share of the counters, and the length of its loop.
 */
const FUNCTIONS: Record<string, [name: string, share: number, body: number][]> = {
  'std::format(double)_(value:_-inf,_fmt:_{:0^17500_0})': [
    ['std::__1::__formatter::__format_floating_point<double, char>(double, context&)', 0.52, 14],
    ['std::__1::__to_chars_floating_point<double>(char*, char*, double, chars_format)', 0.24, 10],
    ['std::__1::__formatter::__write_using_trailing_zeros<char>(char const*, char*)', 0.11, 6],
    // `/` in a function name: it is why function names travel in a query parameter (I1).
    ['std::__1::chrono::operator/<long long, nano, long>(duration const&, long)', 0.05, 3],
    ['memcpy', 0.04, 4],
    ['main', 0.01, 2],
  ],
  [PROFILED_TEST]: [
    ['std::__1::__stable_sort<_ClassicAlgPolicy, __less<>&, int*>(int*, int*, long)', 0.47, 12],
    ['std::__1::__merge_move_assign<_ClassicAlgPolicy, __less<>&, int*>(int*, int*)', 0.31, 10],
    ['std::__1::__insertion_sort<_ClassicAlgPolicy, __less<>&, int*>(int*, int*)', 0.12, 6],
    ['operator new(unsigned long)', 0.03, 3],
    ['main', 0.01, 2],
  ],
}

/** Each counter's total over the listed functions, before a function's `speedup`. */
const TOTALS = { cycles: 3.2e9, instructions: 7.4e9, 'branch-misses': 4.1e6 }
type Counter = keyof typeof TOTALS
const COUNTERS = Object.keys(TOTALS) as Counter[]

/** Give each profiled test among `entries` a profile; `speedup` scales the hottest function. */
function addProfiles(entries: Submission['tests'], isa: Isa, speedup: number, seed: string): void {
  for (const entry of entries) {
    if (entry.name in FUNCTIONS) {
      const document = profileOf(entry.name, isa, speedup, `${seed}/${entry.name}`)
      entry.profile = gzipSync(JSON.stringify(document)).toString('base64')
    }
  }
}

function profileOf(test: string, isa: Isa, speedup: number, seed: string): ProfileDocument {
  const rand = random(seed)
  const code = CODE[isa]
  const functions = FUNCTIONS[test].map(([name, share, bodyLength], f) => {
    // An entry block with an early exit, a loop, and an exit block.
    const body = Array.from({ length: bodyLength }, (_, j) => code.body[j % code.body.length])
    const texts = [...code.prologue, ...code.skip, ...body, ...code.loop, ...code.epilogue]
    const loopStart = code.prologue.length + code.skip.length
    const loopEnd = loopStart + body.length + code.loop.length
    let address = code.base + f * 0x1000
    const addresses = texts.map((_, j) => {
      const at = address
      address += isa === 'aarch64' ? 4 : 2 + ((j * 7) % 5)
      return at
    })
    const isBranch = (j: number) => j === loopStart - 1 || j === loopEnd - 1
    const weights: Record<Counter, number[]> = { cycles: [], instructions: [], 'branch-misses': [] }
    for (let j = 0; j < texts.length; j++) {
      const cycles = j >= loopStart && j < loopEnd ? 10 + 30 * rand() : 0.5 + rand()
      weights.cycles.push(cycles)
      weights.instructions.push(Math.sqrt(cycles))
      weights['branch-misses'].push(j === loopEnd - 1 ? 8 : isBranch(j) ? 2 : 0)
    }
    const scale = f === 0 ? share * speedup : share
    const counts = Object.fromEntries(
      COUNTERS.map((counter) => {
        const sum = weights[counter].reduce((a, b) => a + b, 0)
        const total = TOTALS[counter] * scale
        return [counter, weights[counter].map((weight) => Math.round((total * weight) / sum))]
      }),
    ) as Record<Counter, number[]>
    return {
      name,
      instructions: texts.map((text, j) => {
        const target = j === loopStart - 1 ? addresses[loopEnd] : addresses[loopStart]
        return {
          address: addresses[j],
          counters: Object.fromEntries(COUNTERS.map((counter) => [counter, counts[counter][j]])),
          text: text.replace('{target}', target.toString(16)),
        }
      }),
    }
  })
  // The top-level counters cover the whole program, including the functions not listed.
  const counters = Object.fromEntries(
    COUNTERS.map((counter) => {
      const listed = functions
        .flatMap((fn) => fn.instructions)
        .reduce((sum, instruction) => sum + instruction.counters[counter], 0)
      return [counter, Math.round(listed / 0.9)]
    }),
  )
  return { disassembly_format: 'llvm-objdump', counters, functions }
}

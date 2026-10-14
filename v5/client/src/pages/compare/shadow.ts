/**
 * The shadow traces (CP8): pinned comparisons overlaid as thin lines on the chart, allowing the
 * user to compare several versions of side B against a shared baseline (side A). Up to 5 shadows
 * can be pinned, each with its own colour and chip.
 */

import { useCallback, useEffect, useMemo } from 'react'
import { skipToken, useQueries, type UseQueryResult } from '@tanstack/react-query'
import type { Schemas } from '../../api/client'
import { failuresOf } from '../../api/failures'
import { machinesQuery } from '../../api/machines'
import {
  commitRunsQuery,
  runRefKey,
  uniqueRuns,
  useRunSamples,
  type RunRef,
  type SampleState,
} from '../../api/runs'
import type { SuiteSchema } from '../../api/suites'
import { commitLookupKey, commitLookupQuery } from '../../components/commit-lookup'
import type { Metric } from '../../schema'
import { listParam, type Param } from '../../url-state'
import { chartBars, MAX_SHADOWS, SHADOW_COLORS, type Bar } from './chart'
import type { ShadowLine } from './compare-chart'
import { compareRows, sideSamples, sideValues, type ComparisonRow, type NoiseSettings } from './comparison'
import { hasFailed, sidesRuns } from './loading'
import { offeredMetrics } from './metrics'
import type { Settings } from './settings'
import type { Comparison } from './use-comparison'
import type { Sides } from './use-side'

const NO_BARS: Bar[] = []
/** No noise knob enabled: the shadow's line needs no statuses. */
const NO_NOISE: NoiseSettings = { pct: null, pval: null, floor: null }

export interface ShadowSpec {
  suite: string
  machine: string
  commit: string
  runs: string[]
}

/** The shadow `text` names, as the URL spells it, or null if it is malformed (CP8). */
export function parseShadow(text: string): ShadowSpec | null {
  const parts = text.split('/')
  if (parts.length === 3) {
    const [suite, machine, commit] = parts
    if (!suite || !machine || !commit) return null
    return { suite, machine, commit, runs: [] }
  }
  if (parts.length === 4) {
    const [suite, machine, commit, runsStr] = parts
    if (!suite || !machine || !commit || !runsStr) return null
    const runs = [...new Set(runsStr.split(',').filter(Boolean))].sort()
    if (runs.length === 0) return null
    return { suite, machine, commit, runs }
  }
  return null
}

/** `shadow`, as the URL spells it: repeated parameter (CP8). */
export function formatShadow({ suite, machine, commit, runs }: ShadowSpec): string {
  const base = `${suite}/${machine}/${commit}`
  if (runs.length === 0) return base
  return `${base}/${[...runs].sort().join(',')}`
}

/** The shadows, repeated once per shadow (CP8), up to MAX_SHADOWS; malformed ones are dropped. */
export function shadowParam(): Param<string[]> {
  const list = listParam()
  return {
    ...list,
    parse: (values) =>
      list.parse(values.filter((value) => parseShadow(value) !== null))?.slice(0, MAX_SHADOWS),
  }
}

/** The shadows named by the URL's `values`, each parsed once. */
export function useParsedShadows(values: readonly string[]): ShadowSpec[] {
  return useMemo(
    () => values.flatMap((value) => parseShadow(value) ?? []).slice(0, MAX_SHADOWS),
    [values],
  )
}

function combine<Data>(results: { data?: Data; error: Error | null; refetch: () => unknown }[]) {
  return { data: results.map((result) => result.data), ...failuresOf(results) }
}

export interface ShadowItem {
  spec: ShadowSpec
  color: string
  display: string
  schema: SuiteSchema | undefined
  wanted: string[]
  refs: RunRef[]
  runsQuery: UseQueryResult<Schemas['Run'][]>
  runsListFailed: boolean
  dismiss(): void
}

export interface Shadows {
  items: ShadowItem[]
  specs: ShadowSpec[]
  sampleStates: ReadonlyMap<string, SampleState>
  isPinned(spec: ShadowSpec): boolean
  pin(spec: ShadowSpec): void
  dismiss(formatted: string): void
  runsListError: { error: Error; retry: () => void } | undefined
  failedSamples: SampleState[]
}

/**
 * The shadows, with the settings `all` gives them, which `update` changes, beside sides `a` and `b`.
 * Their samples are asked for apart from the sides', but a run they share is fetched once.
 * A shadow is dropped if its suite, machine or commit is missing or unusable, or if its machine
 * has no run at the commit (CP8).
 */
export function useShadows(
  { a, b }: Pick<Sides, 'a' | 'b'>,
  all: Settings,
  update: (changes: Partial<Settings>) => void,
  suites: UseQueryResult<SuiteSchema[]>,
): Shadows {
  const specs = useParsedShadows(all.shadow)

  const schemas = useMemo(
    () => specs.map((spec) => suites.data?.find((s) => s.name === spec.suite)),
    [specs, suites.data],
  )

  const namedSuites = useMemo(() => [...new Set(specs.map((s) => s.suite))], [specs])
  const knownSuites = useMemo(
    () => namedSuites.filter((suite) => suites.data?.some((s) => s.name === suite)),
    [namedSuites, suites.data],
  )

  const machineLists = useQueries({
    queries: namedSuites.map((suite) => ({
      ...machinesQuery(suite),
      queryFn: knownSuites.includes(suite) ? machinesQuery(suite).queryFn : skipToken,
      staleTime: Infinity,
    })),
    combine,
  })

  const machineKnown = useMemo(
    () =>
      specs.map((spec, i) => {
        if (schemas[i] === undefined) return undefined
        const list = machineLists.data[namedSuites.indexOf(spec.suite)]
        if (list === undefined) return undefined
        return list.some((entry) => entry.name === spec.machine)
      }),
    [specs, schemas, namedSuites, machineLists.data],
  )

  const lookups = useQueries({
    queries: specs.map(({ suite, machine, commit }, i) => {
      const schema = schemas[i]
      return {
        queryKey: commitLookupKey(suite, { machine }, commit),
        queryFn:
          schema && machineKnown[i]
            ? commitLookupQuery(schema, { machine }, commit).queryFn
            : skipToken,
      }
    }),
  })

  const runsQueries = useQueries({
    queries: specs.map(({ suite, machine, commit }, i) => {
      const schema = schemas[i]
      return {
        ...commitRunsQuery(suite, machine, commit),
        queryFn:
          schema && machineKnown[i] !== false
            ? commitRunsQuery(suite, machine, commit).queryFn
            : skipToken,
      }
    }),
  })

  const unusableSpecs = useMemo(() => {
    return specs.filter((_, i) => {
      const suiteMissing = suites.data !== undefined && schemas[i] === undefined
      const machineMissing = machineKnown[i] === false
      const commitMissing = lookups[i]?.isSuccess && lookups[i]?.data === null
      const noRunsAtCommit = runsQueries[i]?.isSuccess && runsQueries[i]?.data?.length === 0
      return suiteMissing || machineMissing || commitMissing || noRunsAtCommit
    })
  }, [specs, suites.data, schemas, machineKnown, lookups, runsQueries])

  useEffect(() => {
    if (unusableSpecs.length > 0) {
      const dropped = new Set(unusableSpecs.map((s) => formatShadow(s)))
      update({ shadow: all.shadow.filter((v) => !dropped.has(v)) })
    }
  }, [unusableSpecs, all.shadow, update])

  useEffect(() => {
    let changed = false
    const updated = all.shadow.map((formatted, i) => {
      const spec = specs[i]
      if (!spec || spec.runs.length === 0) return formatted
      const runsData = runsQueries[i]?.data
      if (!runsData || runsData.length === 0) return formatted
      const existingUuids = new Set(runsData.map((r) => r.uuid))
      const validRuns = spec.runs.filter((uuid) => existingUuids.has(uuid))
      if (validRuns.length === spec.runs.length) return formatted
      changed = true
      return formatShadow({ ...spec, runs: validRuns })
    })
    if (changed) {
      update({ shadow: updated })
    }
  }, [specs, runsQueries, all.shadow, update])

  const dismiss = useCallback(
    (formatted: string) => {
      update({ shadow: all.shadow.filter((s) => s !== formatted) })
    },
    [all.shadow, update],
  )

  const pin = useCallback(
    (spec: ShadowSpec) => {
      const formatted = formatShadow(spec)
      if (all.shadow.length < MAX_SHADOWS && !all.shadow.includes(formatted)) {
        update({ shadow: [...all.shadow, formatted] })
      }
    },
    [all.shadow, update],
  )

  const isPinned = useCallback(
    (spec: ShadowSpec) => all.shadow.includes(formatShadow(spec)),
    [all.shadow],
  )

  const items = useMemo(() => {
    return specs.map((spec, i): ShadowItem => {
      const color = SHADOW_COLORS[i % SHADOW_COLORS.length]
      const schema = schemas[i]
      const commitRuns = runsQueries[i]?.data
      const uuids = commitRuns?.map((r) => r.uuid)
      const askedUuids = spec.runs.length > 0 ? spec.runs : (uuids ?? [])
      const refs: RunRef[] = askedUuids.map((uuid) => ({ suite: spec.suite, uuid }))
      const chosenUuids =
        uuids && spec.runs.length > 0
          ? uuids.filter((uuid) => spec.runs.includes(uuid))
          : askedUuids
      const wanted = chosenUuids.map((uuid) => runRefKey({ suite: spec.suite, uuid }))
      const runsListFailed =
        Boolean(runsQueries[i]?.isError && (machineKnown[i] === true || machineLists.error != null))

      return {
        spec,
        color,
        display: lookups[i]?.data?.text ?? spec.commit,
        schema,
        refs,
        wanted,
        runsQuery: runsQueries[i],
        runsListFailed,
        dismiss: () => dismiss(formatShadow(spec)),
      }
    })
  }, [specs, schemas, runsQueries, machineKnown, machineLists.error, lookups, dismiss])

  const allRefs = useMemo(
    () => uniqueRuns(...items.map((item) => item.refs)),
    [items],
  )
  const allWanted = useMemo(
    () => new Set(items.flatMap((item) => item.wanted)),
    [items],
  )
  const sampleStates = useRunSamples(allRefs, allWanted)

  const failedRunsList = items.find((item) => item.runsListFailed)
  const runsListError = failedRunsList
    ? {
        error: failedRunsList.runsQuery.error!,
        retry: () =>
          items
            .filter((item) => item.runsListFailed)
            .forEach((item) => void item.runsQuery.refetch()),
      }
    : undefined

  const ofSides = sidesRuns(a, b)
  const failedSamples = useMemo(() => {
    const shadowKeys = [...new Set(items.flatMap((item) => item.wanted))]
    return shadowKeys
      .filter((key) => !ofSides.has(key))
      .map((key) => sampleStates.get(key))
      .filter(hasFailed)
  }, [items, ofSides, sampleStates])

  return {
    items,
    specs,
    sampleStates,
    isPinned,
    pin,
    dismiss,
    runsListError,
    failedSamples,
  }
}

/**
 * The shadows' lines: the tests the chart plots, `plotted`, compared between side A and each shadow,
 * sorted by their own ratios. Nothing unless side A's suite and the shadow's both offer `metric` (CP8).
 */
export function useShadowLines(
  shadows: Shadows,
  schemaA: SuiteSchema | undefined,
  metric: Metric | undefined,
  aggregations: Pick<Settings, 'sample_agg' | 'run_agg'>,
  { tests, valuesA, biggerIsBetter }: Comparison,
  plotted: readonly ComparisonRow[],
): ShadowLine[] {
  const { items, sampleStates } = shadows

  return useMemo(() => {
    if (metric === undefined || tests === undefined || valuesA === undefined) {
      return []
    }
    const kept = new Set(plotted.map((row) => row.test))

    return items.map((item): ShadowLine => {
      const offered = offeredMetrics(schemaA, item.schema).some(
        (entry) => entry.name === metric.name,
      )
      if (!offered || item.wanted.length === 0) {
        return { points: NO_BARS, color: item.color }
      }
      const allLoaded = item.wanted.every(
        (key) => sampleStates.get(key)?.samples !== undefined,
      )
      if (!allLoaded) {
        return { points: NO_BARS, color: item.color }
      }
      const runSamples = item.wanted.map((key) => sampleStates.get(key)!.samples!)
      const samples = sideSamples(runSamples, metric.name)
      const values = sideValues(samples, aggregations.sample_agg, aggregations.run_agg)
      const bars = chartBars(
        compareRows(tests, valuesA, values, { biggerIsBetter, noise: NO_NOISE }),
      )
      const points = bars.length === 0 ? NO_BARS : bars.filter((bar) => kept.has(bar.test))
      return { points, color: item.color }
    })
  }, [items, sampleStates, schemaA, metric, aggregations, tests, valuesA, biggerIsBetter, plotted])
}

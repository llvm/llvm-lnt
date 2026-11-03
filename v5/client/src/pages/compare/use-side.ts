/**
 * The sides of the Compare page (CP1): each one's suite, machine, commit and runs, as the URL names
 * them, checked against what the API holds, and the selection among the runs.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useQuery, type UseQueryResult } from '@tanstack/react-query'
import type { Schemas } from '../../api/client'
import {
  commitRunsQuery,
  runRefKey,
  uniqueRuns,
  useRunSamples,
  type RunRef,
  type SampleState,
} from '../../api/runs'
import { isNamed, NO_SUITE, type Suite } from '../../api/suites'
import { useControlledSelection, type RowSelection } from '../../components/range-selection'
import type { Machines } from '../../components/machine-suggestions'
import { useSuiteAndMachine } from '../../components/side-selection'
import { NO_RUNS_SELECTED, runsParam, selectedRuns } from './run-selection'
import {
  CLEARED_WITH,
  sideChanges,
  sideSettings,
  type Settings,
  type SideId,
  type SideSettings,
} from './settings'

type Run = Schemas['Run']

export interface Side {
  id: SideId
  settings: SideSettings
  update(changes: Partial<SideSettings>): void
  /** The side's suite, once the suites are known to hold it. */
  schema: Suite | undefined
  /** The suite's machines, and the suggestions of the combobox picking one. */
  machines: Machines
  /** Whether the side names a suite, a machine and a commit: what its runs are asked for with. */
  named: boolean
  /** The runs of the machine at the commit, in the order they were measured. */
  runs: UseQueryResult<Run[]>
  /** The selection among the runs. */
  selection: RowSelection
  /**
   * The runs selected, once the side's runs are listed: those the URL names, or every run when it
   * names none of them, unless the user has deselected every run. Undefined until then.
   */
  selected: ReadonlySet<string> | undefined
  /**
   * The runs, by `[project, suite, machine, commit]`, of which the user has deselected every one, which the
   * URL cannot say (CP7): null when the side's runs are not those.
   */
  noRunsOf: string | null
  setNoRunsOf(list: string | null): void
  /** The runs whose samples the side asks for: those it lists, or until it does, the URL's. */
  refs: RunRef[]
  /**
   * Those whose samples it wants, by `runRefKey`: those selected, or until the runs are listed,
   * the URL's.
   */
  wanted: string[]
}

const NO_RUNS: string[] = []

/**
 * The side `id`, with the settings `all` gives it: the page's, which `update` changes. `suites`
 * lists the suites of the instance.
 */
export function useSide(
  id: SideId,
  all: Settings,
  update: (changes: Partial<Settings>) => void,
  suites: UseQueryResult<Suite[]>,
): Side {
  const settings = sideSettings(all, id)
  const { suite, machine, commit } = settings
  // What the user changes, from the side's panel or its runs, and what the page drops, as unusable
  // (AR2 "State").
  const updateSide = useCallback(
    (changes: Partial<SideSettings>) => update(sideChanges(id, changes)),
    [id, update],
  )

  const { schema, machines } = useSuiteAndMachine({
    suite,
    machine,
    suites,
    onUnusableSuite: () => updateSide({ suite: NO_SUITE, ...CLEARED_WITH.suite }),
    onUnusableMachine: () => updateSide({ machine: '', ...CLEARED_WITH.machine }),
  })

  // Asked for with the URL's values as they are, without waiting for them to be checked (CP6).
  const named = isNamed(suite) && machine !== '' && commit !== ''
  const runs = useQuery({ ...commitRunsQuery(suite, machine, commit), enabled: named })
  const uuids = useMemo(() => runs.data?.map((run) => run.uuid), [runs.data])

  // The runs selected, as the URL names them, once they are listed.
  const list = [suite.project, suite.suite, machine, commit].join('\0')
  const [noRunsOf, setNoRunsOf] = useState<string | null>(null)
  const none = noRunsOf === list
  const selected = useMemo(
    () => selectedRuns(uuids, settings.runs, none),
    [uuids, settings.runs, none],
  )
  const selection = useControlledSelection(
    selected ?? NO_RUNS_SELECTED,
    uuids ?? NO_RUNS,
    (next) => {
      if (uuids === undefined) return
      setNoRunsOf(next.size === 0 ? list : null)
      updateSide({ runs: runsParam(uuids, next) })
    },
  )

  // The URL's runs that are not listed are dropped, and so is what the side names without what it
  // depends on, as clearing that does (AR2 "State", CP1).
  useEffect(() => {
    if (uuids !== undefined && selected !== undefined)
      updateSide({ runs: runsParam(uuids, selected) })
    else if (suite === NO_SUITE) updateSide(CLEARED_WITH.suite)
    else if (machine === '') updateSide(CLEARED_WITH.machine)
    else if (commit === '') updateSide(CLEARED_WITH.commit)
  }, [suite, machine, commit, selected, uuids, updateSide])

  // The runs whose samples the side needs.
  const asked = named ? (uuids ?? settings.runs) : NO_RUNS
  const refs = useMemo(() => asked.map((uuid) => ({ suite, uuid })), [suite, asked])
  // Those whose samples it wants: once the runs are listed, those selected.
  const chosen = useMemo(
    () => (uuids && selected ? uuids.filter((uuid) => selected.has(uuid)) : asked),
    [uuids, selected, asked],
  )
  const wanted = useMemo(() => chosen.map((uuid) => runRefKey({ suite, uuid })), [suite, chosen])

  return {
    id,
    settings,
    update: updateSide,
    schema,
    machines,
    named,
    runs,
    selection,
    selected,
    noRunsOf,
    setNoRunsOf,
    refs,
    wanted,
  }
}

/** The two sides of the comparison. */
export interface Sides {
  a: Side
  b: Side
  /** Whether the sides have been swapped an odd number of times. */
  swapped: boolean
  /** Swap the sides (CP1). */
  swap(): void
  /** How far the samples of each of their runs are loaded, by `runRefKey`. */
  states: ReadonlyMap<string, SampleState>
}

/**
 * The sides, with the settings `all` gives them, which `update` changes, and their runs' samples,
 * each run's asked for once, even when both sides have it. `suites` lists the suites of the
 * instance.
 */
export function useSides(
  all: Settings,
  update: (changes: Partial<Settings>) => void,
  suites: UseQueryResult<Suite[]>,
): Sides {
  const a = useSide('a', all, update, suites)
  const b = useSide('b', all, update, suites)
  const [swapped, setSwapped] = useState(false)

  const refs = useMemo(() => uniqueRuns(a.refs, b.refs), [a.refs, b.refs])
  const wanted = useMemo(() => new Set([...a.wanted, ...b.wanted]), [a.wanted, b.wanted])
  const states = useRunSamples(refs, wanted)

  // The shadows are kept (CP8).
  const swap = () => {
    update({ ...sideChanges('a', b.settings), ...sideChanges('b', a.settings) })
    a.setNoRunsOf(b.noRunsOf)
    b.setNoRunsOf(a.noRunsOf)
    setSwapped(!swapped)
  }
  return { a, b, swapped, swap, states }
}

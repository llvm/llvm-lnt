/**
 * The sides of the Compare page (CP1): each one's suite, machine, commit and runs, as the URL names
 * them, checked against what the API holds, and the selection among the runs. The shadow (CP8) is
 * read like a side.
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
import type { SuiteSchema } from '../../api/suites'
import { useMachineSuggestions } from '../../components/machine-suggestions'
import type { RowSelection } from '../../components/range-selection'
import { useDropUnusable } from '../../url-state'
import { useRunSelection } from './run-selection'
import {
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
  schema: SuiteSchema | undefined
  /** The suite's machines, and the suggestions of the combobox picking one. */
  machines: ReturnType<typeof useMachineSuggestions>
  /** Whether the side names a suite, a machine and a commit: what its runs are asked for with. */
  named: boolean
  /** The runs of the machine at the commit, in the order they were submitted. */
  runs: UseQueryResult<Run[]>
  /** The selection among the runs. */
  selection: RowSelection
  /**
   * The runs selected, once the selection is known: once the side's runs are listed, and it has
   * been filled for them from the URL. Undefined until then.
   */
  selected: ReadonlySet<string> | undefined
  /** The runs whose samples the side asks for: those it lists, or until it does, the URL's. */
  refs: RunRef[]
  /**
   * Those whose samples it wants, by `runRefKey`: those selected, or until that is known, the
   * URL's.
   */
  wanted: string[]
}

/**
 * Whether the side's runs could not be listed, and that is to be said: not for a machine that does
 * not exist, which has no runs to list, and is about to be dropped (AR2).
 */
export function runsListFailed({ runs, machines, settings }: Side): boolean {
  const known = machines.machines.data?.includes(settings.machine) ?? false
  return runs.isError && (known || machines.machines.isError)
}

/** The runs as the URL holds them: left out when every run is selected. */
function runsParam(uuids: readonly string[], selected: ReadonlySet<string>): string[] {
  return selected.size === uuids.length ? [] : uuids.filter((uuid) => selected.has(uuid))
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
  suites: UseQueryResult<SuiteSchema[]>,
): Side {
  const settings = sideSettings(all, id)
  const { suite, machine, commit } = settings
  const schema = suites.data?.find((entry) => entry.name === suite)
  const updateSide = useCallback(
    (changes: Partial<SideSettings>) => update(sideChanges(id, changes)),
    [id, update],
  )

  // A suite or a machine that does not exist is dropped, and what depends on it (AR2 "State").
  useDropUnusable(
    suites,
    (list) => suite === '' || list.some((entry) => entry.name === suite),
    () => updateSide({ suite: '', machine: '', commit: '', runs: [] }),
  )
  const machines = useMachineSuggestions(suite, schema !== undefined)
  useDropUnusable(
    machines.machines,
    (names) => machine === '' || names.includes(machine),
    () => updateSide({ machine: '', commit: '', runs: [] }),
  )

  // Asked for with the URL's values as they are, without waiting for them to be checked (CP6).
  const named = suite !== '' && machine !== '' && commit !== ''
  const runs = useQuery({ ...commitRunsQuery(suite, machine, commit), enabled: named })
  const uuids = useMemo(() => runs.data?.map((run) => run.uuid), [runs.data])

  // The selection among the runs, filled from the URL for each list of runs.
  const list = [suite, machine, commit].join('\0')
  const runSelection = useRunSelection(uuids, list, settings.runs)
  const { selected } = runSelection

  // The selection, in the URL, unless it is every run, the default. Without a commit, there is
  // none to keep (AR2 "State").
  useEffect(() => {
    if (uuids !== undefined && selected !== undefined) {
      updateSide({ runs: runsParam(uuids, selected) })
    } else if (!named) updateSide({ runs: [] })
  }, [named, selected, uuids, updateSide])

  // The runs whose samples the side needs.
  const asked = named ? (uuids ?? settings.runs) : NO_RUNS
  const refs = useMemo(() => asked.map((uuid) => ({ suite, uuid })), [suite, asked])
  // Those whose samples it wants: once the runs are listed, those selected, or about to be.
  const chosen = named ? (runSelection.chosen ?? asked) : asked
  const wanted = useMemo(() => chosen.map((uuid) => runRefKey({ suite, uuid })), [suite, chosen])

  return {
    id,
    settings,
    update: updateSide,
    schema,
    machines,
    named,
    runs,
    selection: runSelection.rows,
    selected,
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
  suites: UseQueryResult<SuiteSchema[]>,
): Sides {
  // Which side each of these two holds. Swapping the sides swaps them, so that each side keeps
  // what it holds in memory, such as its runs selected, rather than reading it from the URL again,
  // which cannot say that none is.
  const [swapped, setSwapped] = useState(false)
  const first = useSide(swapped ? 'b' : 'a', all, update, suites)
  const second = useSide(swapped ? 'a' : 'b', all, update, suites)
  const [a, b] = swapped ? [second, first] : [first, second]

  const refs = useMemo(() => uniqueRuns(first.refs, second.refs), [first.refs, second.refs])
  const wanted = useMemo(
    () => new Set([...first.wanted, ...second.wanted]),
    [first.wanted, second.wanted],
  )
  const states = useRunSamples(refs, wanted)

  const swap = () => {
    update({ ...sideChanges('a', b.settings), ...sideChanges('b', a.settings) })
    setSwapped(!swapped)
  }
  return { a, b, swapped, swap, states }
}

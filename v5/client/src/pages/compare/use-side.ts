/**
 * One side of the Compare page (CP1): its suite, machine, commit and runs, as the URL names them,
 * checked against what the API holds, and the selection among the runs.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from 'react'
import { useQuery, type UseQueryResult } from '@tanstack/react-query'
import type { Schemas } from '../../api/client'
import { commitRunsQuery, runRefKey, type RunRef } from '../../api/runs'
import type { SuiteSchema } from '../../api/suites'
import { useMachineSuggestions } from '../../components/machine-suggestions'
import { useRangeSelection, type RowSelection } from '../../components/range-selection'
import { useDropUnusable } from '../../url-state'
import { useStoreValue, ValueStore } from '../../value-store'
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

  // The selection among the runs. It is filled once for each list of runs, from the URL, or with
  // every run when the URL names none of them. It is only known once it has been.
  const key = [suite, machine, commit].join('\0')
  const { rows, selected } = useRangeSelection(uuids, uuids ?? NO_RUNS)
  // The runs the selection was last filled for, by `key`. Set by the effect that fills the
  // selection, like the selection itself, and so kept in a store like it, rather than in state.
  const [filledFor] = useState(() => new ValueStore<string | null>(null))
  const filled = useStoreValue(filledFor, (value) => value)
  const fromUrl = settings.runs
  // What the selection is filled with: the runs the URL names, or every run when it names none.
  const fill = useMemo(() => {
    const kept = fromUrl.filter((uuid) => uuids?.includes(uuid))
    return kept.length > 0 ? kept : uuids
  }, [fromUrl, uuids])
  // Before the page is painted, so that the runs never show unselected meanwhile. While there are
  // no runs listed, the selection is filled for none, so that it is filled again for the next ones,
  // even those it was filled for before.
  useLayoutEffect(() => {
    if (fill === undefined) filledFor.set(null)
    else if (filled !== key) {
      filledFor.set(key)
      rows.replace(fill)
    }
  }, [fill, filled, filledFor, key, rows])
  const known = uuids !== undefined && filled === key

  // The selection, in the URL, unless it is every run, the default. Without a commit, there is
  // none to keep (AR2 "State").
  useEffect(() => {
    if (known) updateSide({ runs: runsParam(uuids, selected) })
    else if (!named) updateSide({ runs: [] })
  }, [known, named, selected, uuids, updateSide])

  // The runs whose samples the side needs, as text so that they are the same arrays for as long
  // as they are the same runs.
  const asked = named ? (uuids ?? fromUrl) : NO_RUNS
  const askedText = asked.join(',')
  const refs = useMemo(
    () => (askedText === '' ? [] : askedText.split(',').map((uuid) => ({ suite, uuid }))),
    [suite, askedText],
  )
  // Once the runs are listed, those the selection holds, or is about to be filled with.
  const chosen = known
    ? uuids.filter((uuid) => selected.has(uuid))
    : named
      ? (fill ?? asked)
      : asked
  const wantedText = chosen.join(',')
  const wanted = useMemo(
    () =>
      wantedText === '' ? [] : wantedText.split(',').map((uuid) => runRefKey({ suite, uuid })),
    [suite, wantedText],
  )

  return {
    id,
    settings,
    update: updateSide,
    schema,
    machines,
    named,
    runs,
    selection: rows,
    selected: known ? selected : undefined,
    refs,
    wanted,
  }
}

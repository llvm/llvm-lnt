/** The selection among the runs of a side of the Compare page (CP1). */

import { useLayoutEffect, useMemo, useState } from 'react'
import { useRangeSelection, type RowSelection } from '../../components/range-selection'
import { useStoreValue, ValueStore } from '../../value-store'

const NO_RUNS: string[] = []

export interface RunSelection {
  /** The selection, which the side's run checkboxes change. */
  rows: RowSelection
  /** The runs selected, once the selection is known: once it has been filled for the list. */
  selected: ReadonlySet<string> | undefined
  /**
   * Once the runs are listed, the runs selected, in the order they were submitted, or until the
   * selection is known, those it is about to be filled with (see below).
   */
  chosen: readonly string[] | undefined
}

/**
 * The selection among `uuids`, the runs listed for a side's machine and commit, in the order they
 * were submitted, or undefined while they are not listed. `list` identifies what they are the runs
 * of, and `fromUrl` are the runs the URL names.
 *
 * - The selection is filled once for each list: with the runs `fromUrl` names that are listed, or
 *   every run when it names none of them. It is only known once it has been.
 * - It is filled before the page is painted, so that the runs never show unselected meanwhile.
 * - Once filled, only the user changes it, through `rows`: a URL that names other runs later, as
 *   the page's own writes of the selection do, does not fill it again.
 * - It is filled again for the next list, and for the same one again after its runs have stopped
 *   being listed, so that picking a commit again selects every run of it again.
 */
export function useRunSelection(
  uuids: readonly string[] | undefined,
  list: string,
  fromUrl: readonly string[],
): RunSelection {
  const { rows, selected } = useRangeSelection(uuids, uuids ?? NO_RUNS)
  // The list the selection was last filled for. Set by the effect that fills the selection, like
  // the selection itself, and so kept in a store like it, rather than in state, so that the two
  // always change together.
  const [filledFor] = useState(() => new ValueStore<string | null>(null))
  const filled = useStoreValue(filledFor, (value) => value)
  const fill = useMemo(() => {
    const kept = fromUrl.filter((uuid) => uuids?.includes(uuid))
    return kept.length > 0 ? kept : uuids
  }, [fromUrl, uuids])
  // While no runs are listed, the selection is filled for none, so that it is filled again for the
  // next ones, even those it was filled for before.
  useLayoutEffect(() => {
    if (fill === undefined) filledFor.set(null)
    else if (filled !== list) {
      filledFor.set(list)
      rows.replace(fill)
    }
  }, [fill, filled, filledFor, list, rows])
  const known = uuids !== undefined && filled === list
  const chosen = useMemo(
    () => (known ? uuids.filter((uuid) => selected.has(uuid)) : fill),
    [known, uuids, selected, fill],
  )
  return { rows, selected: known ? selected : undefined, chosen }
}

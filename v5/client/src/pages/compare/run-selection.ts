/** The selection among the runs of a side of the Compare page (CP1), which the URL holds (CP7). */

/** No run selected. */
export const NO_RUNS_SELECTED: ReadonlySet<string> = new Set()

/**
 * The runs selected among `uuids`, the runs listed for a side's machine and commit, or undefined
 * while they are not listed: those `fromUrl` names that are listed, or every run when it names none
 * of them, unless `none` says the user has deselected every run, which the URL cannot say (CP7).
 */
export function selectedRuns(
  uuids: readonly string[] | undefined,
  fromUrl: readonly string[],
  none: boolean,
): ReadonlySet<string> | undefined {
  if (uuids === undefined) return undefined
  if (none) return NO_RUNS_SELECTED
  const kept = uuids.filter((uuid) => fromUrl.includes(uuid))
  return new Set(kept.length > 0 ? kept : uuids)
}

/** The runs as the URL holds them: left out when every run is selected, or none is. */
export function runsParam(uuids: readonly string[], selected: ReadonlySet<string>): string[] {
  return selected.size === uuids.length ? [] : uuids.filter((uuid) => selected.has(uuid))
}

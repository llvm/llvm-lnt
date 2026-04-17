# Regressions Feature - Work Items

Identified during manual testing on 2026-04-16.

## Regression Detail Page

- [x] **Commit combobox suggestions**: Already implemented — uses
  `renderCommitSearch` with API search mode.
- [x] **Hide ordinal in commit combobox**: Removed `#ordinal` fallback from
  `commit-search.ts`.
- [x] **Title as page header**: Shows "Regression: {title}" when title is set,
  falls back to UUID. Updates after title edit.
- [x] **Notes edit button**: Notes section guarded by Edit button with
  Save/Cancel. Ctrl/Cmd+Enter saves.
- [x] **Select-all checkbox for indicators**: Header checkbox with
  bidirectional sync and indeterminate state.
- [x] **Shift+click range selection on indicators**: Shift+click selects range
  in indicator checkbox list. Reusable `checkbox-range.ts` component.
- [x] **Enter key saves edits**: Enter saves title and bug edits.
  Ctrl/Cmd+Enter saves notes.
- [x] **Reorder sections**: Move "Add Indicators" and "Delete Regression" above
  the indicators table (which may be very long).
- [x] **Duplicate "Metric" label**: In "Add Indicators", "Metric" label appears
  twice stacked. Fix the duplicate.
- [x] **Multi-machine selection in Add Indicators**: Machine selector is now a
  checkbox list with filter (like tests). Cross-product indicator creation.
- [x] **Shift+click range select in Add Indicators**: Both machine and test
  lists support shift+click range selection.
- [x] **Commit disappears in create form**: Fixed `selectCommit()` to show
  selected value in input. Cancel clears it.

## Run Detail Page

- [x] Regressions section removed (redundant with Machine/Commit Detail).
  "Delete Run" moved inline with action links.

## Machine Detail Page

- [x] **Regressions above runs table**: Move the regressions section above
  the runs table. "Delete Machine" moved inline with action links.

## Commit Detail Page

- [x] **Regressions above runs table**: Move the regressions section above
  the runs table, consistent with Run Detail and Machine Detail.

## Compare Page

- [ ] **Link to created regression**: After creating a regression from Compare,
  show a clickable link to the regression detail page (not just the UUID).
- [ ] **Only include visible tests**: When creating a regression or adding
  indicators from Compare, only include tests currently visible in the
  comparison table (not noise-hidden, not manually-hidden, not filtered out by
  text filter). Currently uses `lastRows.filter(r => r.sidePresent === 'both')`
  which includes everything.
- [ ] **Floating "Add to Regression" button**: Replace the current `<details>`
  panel at the bottom with a sticky floating button (bottom-right) that expands
  into a panel on click. Current placement below the full table is hard to
  discover.
- [ ] **Noise-hidden tests not removed from table**: The design spec (line 57
  of compare.md) says "Hide noise" should hide noise rows entirely, but the
  implementation only grays them out. Manual click-toggle should gray out (not
  remove). Fix: split `hiddenTests` into `removedTests` (noise-hidden, fully
  removed from DOM) vs `hiddenTests` (click-toggled, grayed out). Geomean and
  stats are already computed correctly (exclude both).

## Graph Page

- [ ] **Regression annotations not showing**: Regressions are not displayed on
  the graph. The design calls for vertical dashed lines at regression commits,
  color-coded by state, with a toggle (Off/Active/All). The code for building
  overlays exists (`buildRegressionOverlays`, `fetchAndApplyRegressionAnnotations`)
  but something is preventing them from appearing. Investigate root cause.

## Regression List: Merge Into Test Suites Tab

- [x] Done (commit 2a68640).

## API Improvements

- [x] **API timestamps lack Z suffix**: Done (timestamps now include `Z`).

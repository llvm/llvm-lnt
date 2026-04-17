# Regressions Feature - Work Items

Identified during manual testing on 2026-04-16.

## Regression Detail Page

- [ ] **Commit combobox suggestions**: The commit input should be a combobox
  with suggestions powered by `/commits?search=`, consistent with other pages.
- [ ] **Hide ordinal in commit combobox**: Currently shows "commit #ordinal".
  Ordinal should not be shown, consistent with other commit comboboxes. Remove
  the `#ordinal` fallback from `commit-search.ts`.
- [ ] **Title as page header**: Title should be "Regression: {title}" with an
  edit button on the right. If no title, show UUID instead. Currently shows
  "Regression: UUID" always.
- [ ] **Notes edit button**: Notes section should be guarded by an edit button
  (like title and bug) instead of always showing an editable textarea.
- [ ] **Select-all checkbox for indicators**: Add a checkbox in the header to
  select/deselect all indicators at once.
- [ ] **Shift+click range selection on indicators**: Shift+clicking checkboxes
  in the indicator list should perform range selection.
- [ ] **Enter key saves edits**: Pressing Enter while editing title, bug, or
  notes should save the changes (currently only mouse click on Save works).
- [x] **Reorder sections**: Move "Add Indicators" and "Delete Regression" above
  the indicators table (which may be very long).
- [x] **Duplicate "Metric" label**: In "Add Indicators", "Metric" label appears
  twice stacked. Fix the duplicate.
- [ ] **Multi-machine selection in Add Indicators**: Allow selecting multiple
  machines at once (like tests), not just one.
- [ ] **Shift+click range select in Add Indicators**: Both machine and test
  multi-selection lists should support shift+click range selection.
- [ ] When adding a regression, I search for a commit in the selection box, and then when I click it to select it, it disappears entirely in the UI. Then if I click "create" it does seem to properly create the regression, but it's weird that the commit disappears after being selected.

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

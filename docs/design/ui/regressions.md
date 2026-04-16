# v5 Web UI: Regressions

Page specifications for the Regression List and Regression Detail pages.

For the SPA architecture and routing, see [`architecture.md`](architecture.md).
Related pages: [Graph](graph.md), [Compare](compare.md),
[Browsing Pages](browsing.md).


## Regression List -- `/v5/{ts}/regressions`

Main triage page for performance regressions.

**Layout**: Filterable, sortable table of regressions.

**Columns**: Title (linked to detail), State (badge), Commit (linked to commit
detail), Machine count, Test count, Bug (external link).

**Filters** (control panel above table):
- State: multi-select chips (detected, active, not_to_be_fixed, fixed, false_positive)
- Machine: combobox with typeahead
- Test: combobox with typeahead
- Metric: dropdown
- Has commit: checkbox (surfaces regressions with unset commit)
- Free-text search on title

**Actions**:
- "New regression" button -> opens create form (inline or modal) with title, bug, state, commit fields. Indicators added after creation from the detail page.
- Row click -> navigates to regression detail page.
- Delete: per-row action with confirmation prompt.

**Pagination**: Cursor-based, consistent with other list pages.

Auth: requires `triage` scope for create/delete actions.


## Regression Detail -- `/v5/{ts}/regressions/{uuid}`

Investigation and management page for a single regression.

**Header section** (editable fields):
- Title: inline-editable text
- State: dropdown selector (detected, active, not_to_be_fixed, fixed, false_positive)
- Bug: URL input (opens in new tab when set)
- Commit: combobox with typeahead (nullable -- the suspected introduction point). Linked to commit detail page when set.
- Notes: expandable textarea for investigation findings, A/B results, root cause analysis, etc.

**Indicators table**:
- Columns: Machine, Test, Metric, remove button (x)
- Multi-select rows for batch remove
- "View on graph" link per indicator: opens Graph page pre-populated with the indicator's machine, test, metric, and the regression's commit as context

**Add indicators panel** (below table):
- Three multi-select comboboxes with typeahead: Metric, Machine, Test
- Test list filtered by selected machines and metrics (only shows tests with data for the selected combination)
- Preview: "This will add N indicators" with expandable list
- "Add" button creates all (machine x test x metric) indicator combinations
- Duplicates (same machine+test+metric already on this regression) are silently ignored

**Actions**:
- Delete regression button (with confirmation)

Auth: requires `triage` scope for all modifications.

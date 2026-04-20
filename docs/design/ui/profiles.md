# v5 Web UI: Profiles Page

Page specification for the Profiles page at `/v5/profiles`.

For the SPA architecture and routing, see [`architecture.md`](architecture.md).
Related pages: [Compare](compare.md), [Browsing Pages](browsing.md).


## Profiles -- `/v5/profiles?suite_a={ts}&run_a={uuid}&test_a={name}&suite_b={ts}&run_b={uuid}&test_b={name}`

A/B profile viewer for hardware performance counter data at the instruction
level. Suite-agnostic page. Each side independently selects its own test
suite, enabling cross-suite profile comparison. Side B is optional -- if
only side A is filled, a single profile is displayed.

URL uses suffix convention (`suite_a`, `run_a`, `test_a`) consistent with the
Compare page's `suite_a`, `commit_a`, etc. All parameters optional. The page
resolves profile UUIDs from the run+test coordinates by calling the listing
endpoint (`GET /runs/{uuid}/profiles`).


### Entry Points

1. **Nav bar**: `[Profiles]` link navigates to `/v5/profiles` with no params.
2. **Compare page**: "Profile" link in the comparison table for tests that
   have profiles on both sides. Pre-populates suite_a, run_a, test_a, suite_b,
   run_b, test_b. Uses the latest run when multiple runs are selected on a side.
3. **Run Detail page**: Tests with profiles show a "Profile" link in the
   samples table, navigating to `/v5/profiles?suite_a={ts}&run_a={uuid}&test_a={test}`.


### A/B Picker

Each side (A and B) has its own cascading selectors. The two sides may
select different test suites. Changing an upstream selector clears
downstream selections:

1. **Suite**: dropdown from `data-testsuites`. Disabled: never.
2. **Machine**: combobox over machine names for the selected suite. Disabled
   until suite is selected.
3. **Commit**: combobox over commits filtered to those with profile-bearing
   runs on the selected machine. Disabled until machine is selected.
4. **Run**: dropdown of runs for the selected machine+commit that contain
   profile data (shows timestamp + short UUID). Disabled until commit is
   selected.
5. **Test**: dropdown over tests that have profiles for the selected run
   (populated from `GET /runs/{uuid}/profiles`). Disabled until run is
   selected.


### Top-Level Counter Comparison (Stats Bar)

When both sides are selected:
- Table showing counter names, value A, value B, and % difference
- Color-coded: green (improvement), red (regression)
- Horizontal bar chart showing % differences per counter

When only side A is selected:
- Simple table of counter names and values (no comparison)


### Function Selector

A combobox for each side, populated from the profile's function list.
- Sorted by hottest-first (highest counter value for the selected counter)
- Each suggestion shows a colored badge with the counter percentage
- A counter dropdown controls which counter is used for sorting and display


### Disassembly View

Two display modes, selectable via dropdown:

**Straight-line view**: HTML table with columns:
- Counter value (heat-map colored: white -> yellow -> red)
- Address (hex)
- Instruction text

**Control-flow graph (CFG) view**: D3-based visualization with:
- Instruction set selector: AArch64, AArch32-T32, RISC-V, X86-64
- Basic blocks as rectangles with left-side weight sidebar
- Instructions listed vertically within blocks
- Edges between blocks (arrows; backward edges in orange)
- Per-block aggregate counter display

Display mode selector options:
- Straight-line
- CFG (AArch64)
- CFG (AArch32-T32)
- CFG (RISC-V)
- CFG (X86-64)

The CFG view requires ISA-specific basic block boundary detection (parsing
instruction semantics to identify branches, jumps, and fall-throughs). The
v4 implementation in `lnt_profile.js` (lines 73-139) provides the reference
regex patterns per ISA.

**Note**: The CFG view is deferred to a future phase. Only the straight-line
display mode is currently implemented.


### Counter Display Modes

A dropdown to control how counter values are displayed:
- **Relative %**: percentage of function total (default)
- **Absolute**: raw counter values
- **Cumulative**: running sum through instructions


### Side-by-Side Layout

When both sides are filled:
- Stats bar across the top (full width)
- Two columns below: left = side A disassembly, right = side B disassembly
- Each column has its own function selector
- Counter dropdown and display mode are shared (global)

When only one side:
- Stats table (single column) across the top
- Single disassembly column (full width)


### Data Flow

1. On page load, read URL params.
2. For each side with a run+test, call `GET /runs/{uuid}/profiles` to find
   the profile UUID for the test.
3. Call `GET /profiles/{uuid}` for metadata + counters (stats bar).
4. When user selects a function, call `GET /profiles/{uuid}/functions/{fn}`
   for disassembly data.
5. Function list is fetched once via `GET /profiles/{uuid}/functions` when
   the profile is loaded.


### URL State

All selection state is encoded as query parameters for shareability:
- `suite_a`, `suite_b`, `run_a`, `test_a`, `run_b`, `test_b`

Auth token is stored in `localStorage`, not in URL state. All URL updates
use `replaceState` (not `pushState`).


**Links out**: Run Detail, Compare.

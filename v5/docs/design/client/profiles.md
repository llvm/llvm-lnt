# v5 Web UI: Profiles Page

Page specification for the Profiles page at `/profiles`.


## Profiles -- `/profiles?suite_a={ts}&...`

A/B viewer of profiles: the hardware performance counters of one test in one
run, per instruction (see O7). This page is suite-agnostic: each side selects
its own suite, so that profiles can be compared across suites. Either side can
show a profile on its own, and when both do, the page compares them. Layout:

```
# Profiles

+-- Side A -------------------------------------------+   +-- Side B -------------------------------------------+
| Suite    [libcxx                       v]           |   | Suite    [libcxx                       v]           |
| Machine  [linux-x86_64                  ]           |   | Machine  [linux-x86_64                  ]           |
| Commit   [0f985af790f8                  ]           |   | Commit   [014621ede7c1                  ]           |
| Run      [2026-08-25, 2:22 PM 573af861 v] 573af861  |   | Run      [2026-08-31, 3:03 PM f1668bea v] f1668bea  |
| Test     [std::stable_sort(vector<int>)_]           |   | Test     [std::stable_sort(vector<int>)_]           |
+-----------------------------------------------------+   +-----------------------------------------------------+

Counter           A                B                Difference
-----------------------------------------------------------------
branch-misses     4555556          4555556          0%
cycles            3555555556       2844444444       -20%    =====
instructions      8222222222       8222222222       0%
-----------------------------------------------------------------
Function cycles   1671111111       1069511111       -36%    =====

Counter [cycles v]   Values [Relative % v]

Function [__stable_sort<...>     ] (47%)         Function [__stable_sort<...>     ] (37.6%)
Hottest [<- Previous] [Next ->]                  Hottest [<- Previous] [Next ->]

cycles    Address     Instruction                cycles    Address     Instruction
          0x401000    push   rbp                           0x401000    push   rbp
          0x401001    mov    rbp, rsp                      0x401001    mov    rbp, rsp
12.3%     0x401018    mov    rax, qword ptr ...  9.8%      0x401018    mov    rax, qword ptr ...
etc...
```


### PF1: Entry Points

1. **Navigation bar**: the `[Profiles]` link, with side A's suite pre-filled
   when it is followed from a suite-scoped page (see AR4).
2. **Compare page**: the "Profile" link of a test in the comparison table (see
   CP2). It fills in both sides when both have a profile of the test, and side
   A with whichever side has one otherwise. On each side, it uses the latest
   of the selected runs (see AR6) that has a profile of the test.
3. **Run Detail page**: the "Profile" link of a test in the samples table (see
   DT2), which fills in side A with the run and the test.

The Compare and Run Detail links fill in each side they set entirely: suite,
machine, commit, run and test.


### PF2: Side Selection

Each side has its own cascading controls, in a controls panel (see AR5). The
two sides are independent: they may select different suites, machines, commits
or tests.

- **Suite**: a dropdown over the test suites defined on the instance. Changing
  the suite clears the side's machine, commit, run and test.
- **Machine**: a combobox (see AR14) over the selected suite's machines. The
  suite's full machine list is fetched once and filtered locally (see AR9).
  Disabled until a suite is selected, showing "Select a suite first". When the
  user picks another machine, the side keeps its commit if the new machine has
  profiles at that commit (checked as AR15 describes). Otherwise, the commit is
  cleared. Clearing the machine clears the commit, the run and the test.
- **Commit**: a commit picker (see AR15) over the commits at which the selected
  machine has runs with profiles. Disabled until a machine is selected, showing
  "Select a machine first". When the machine has no profiles at all, the side
  says so. Clearing the commit clears the run and the test.
- **Run**: a dropdown over the selected machine's runs at the selected commit
  that have profiles, in the order they were measured, each showing its
  measurement time and its shortened UUID. Disabled until a commit is selected,
  showing "Select a commit first". Whenever the user's picks change the side's
  commit or machine, the latest of these runs (see AR6) is selected. Beside the
  dropdown, the selected run's shortened UUID links to its Run Detail page.
- **Test**: a combobox (see AR14) over the tests that have a profile in the
  selected run, sorted by name and filtered locally. Disabled until a run is
  selected, showing "Select a run first".

When the user's picks change a side's run, the side keeps its test if the new
run has a profile of it. Otherwise, it takes the other side's test if the new
run has a profile of that one, and else it has no test. This way, a test
selected once follows the user from commit to commit, and side B starts on the
test side A shows.

A side **shows a profile** once it has a test: the profile of that test in the
selected run.


### PF3: Counter Comparison

Below the sides' controls, a table lists the top-level counters (see O7) of the
profiles shown, sorted by name. Counters are matched by name, even across
suites.

When both sides show a profile, the table has the columns Counter, A, B and
Difference:

- A and B are each side's top-level value, or N/A when its profile has no such
  counter.
- Difference is `(B - A) / A * 100`, as a signed percentage. It is N/A when
  either side has no value, or when A is 0.
- A negative Difference is green and a positive one red, since every counter
  counts events (cycles, instructions, misses...), of which fewer is better.
  The Difference cell also holds a bar of that color, whose length is
  proportional to the Difference's absolute value, and full from 100% up.

Below the counters, a last row compares the functions the two sides show (see
PF4), labelled `Function` and the selected counter's name: A and B are each
side's function's value for the selected counter (see E7), as AR6 shows a
`real`, and Difference is computed and colored as above. A side's value is N/A
when its function does not have the counter, and empty until its function is
known. The functions need not have the same name: the row compares whatever the
two sides show.

When only one side shows a profile, the table has the columns Counter and
Value, holding that profile's top-level counters.

The table's shape depends only on which sides show a profile. While a side's
counters are loading, or if they cannot be fetched, its column is empty, and
the other side's values are shown.


### PF4: Counter and Function Selection

Two controls, shared by both sides, sit in a controls panel below the counter
comparison: the **Counter** and the **Values** (see PF6).

The Counter dropdown offers every top-level counter of the profiles shown,
sorted by name. It starts on the first counter that every profile shown has, or
on the first one offered when they have none in common, and goes back to it
when the profiles shown change so that none of them has the counter selected.
It selects the counter shown everywhere below: in the function selectors and in
the disassembly views. When the profiles shown have no counters at all, the
Counter dropdown says so, functions are sorted by name, and the disassembly
views have no value column. The Counter and the Values are shown once a side
shows a profile.

Each side that shows a profile then has a **function selector**: a combobox
(see AR14) over the functions of its profile, filtered locally (see AR9).

- Functions are sorted hottest first: by their value for the selected counter
  (the sum of that counter over their instructions; see E7), descending. A
  function without the selected counter sorts after every one with it. Ties
  are broken by name.
- Each suggestion shows the function's **share** of the profile's top-level
  value for the selected counter, as a percentage in a badge colored by the
  heat scale (see PF6). A function without the counter, or a profile whose
  top-level value for it is 0, has no badge. The selected function's badge is
  also shown beside the combobox.
- A side starts on its hottest function, unless the URL names another (see
  PF9). When the user's picks change the side's profile to another profile of
  the same test, the side keeps its function if the new profile has a function
  of that name. Otherwise, when both sides show profiles of the same test, it
  takes the other side's function if the new profile has it, and else its
  hottest function.
- Changing the counter re-sorts the suggestions, but does not change the
  functions selected.

A profile that lists no functions has no function selector, and its side says
that the profile lists none. Its counters still count in the counter
comparison.


### PF5: Disassembly View

Below its function selector, each side shows the selected function's
instructions, in the order its profile lists them (see E7), in a table with
three columns:

- The selected counter's value for the instruction, headed by the counter's
  name, shown as the Values setting says (see PF6) and colored by the heat
  scale.
- The instruction's address, in hexadecimal with a `0x` prefix.
- The instruction's text, as submitted, in a fixed-width font that keeps its
  whitespace, since disassemblers align operands with spaces.

The table says so when the function has no instructions, and when it does not
have the selected counter, in which case the value column is empty.

**Hottest instructions.** Above the table, "Previous" and "Next" buttons step
through the function's instructions from the hottest to the coldest: by their
value for the selected counter, descending, ties in the order the profile lists
them, leaving out those whose value is 0. "Next" first moves to the hottest
instruction, then to the next one in that order, and "Previous" moves back.
The instruction moved to is highlighted and scrolled into view. This is how the
hot spots of a long function are found, whose instructions may all be below
the heat scale's 1% (see PF6). Each button is disabled at its end of the order,
and both are when no instruction has a value. Changing the function or the
counter starts again from before the hottest instruction. The position is not
kept in the URL.

A function can have up to 100,000 instructions (see O7). The view shows all of
them, and scrolling through them, or changing the counter or the Values, must
never make the page lag, as AR9 requires of filters.


### PF6: Values

The API serves raw counts only (see E7), so every percentage is computed by the
page. Every percentage on the page, in the counter comparison as well, is shown
with one decimal place, except that whole numbers drop the trailing `.0`, as in
CP4. The **Values** dropdown says how a disassembly view shows an instruction's
value for the selected counter:

- **Relative %** (the default): the instruction's share of the function's
  value for the counter (see PF4), as a percentage.
- **Absolute**: the raw value, as AR6 shows a `real`.
- **Cumulative %**: the running sum of the shares in Relative %, through the
  function's instructions in their order, so that the last instruction shows
  100%. It shows how much of the function the instructions up to each one
  account for.

In Relative % and Absolute, an instruction whose value is 0 shows nothing, so
that the instructions that matter stand out. When the function's value for the
counter is 0, every share is 0.

**Heat scale.** A disassembly cell is colored by the instruction's own share,
whatever the Values setting, so that switching between them never recolors the
table. A function badge (see PF4) is colored by the function's share of the
profile in the same way. A share below 1% is not colored. From 1% to 10%, the
color goes from yellow to red, and a share of 10% or more is red.


### PF7: Layout

The two sides' controls are side by side, A on the left and B on the right,
with the counter comparison below them across the full width, followed by the
Counter and the Values.

When both sides show a profile, the function selectors and the disassembly
views are in two columns below: side A's on the left and side B's on the
right. When only one side shows a profile, whichever it is, its function
selector and disassembly view take the full width. Before either side shows a
profile, the page says that a test is to be selected on either side.


### PF8: Data Flow

- Each side's suite list comes from `GET suites`. A suite's machines come from
  `GET machines`, fetched once per suite and shared by both sides.
- A side's commit picker searches
  `GET commits?machine={name}&has_profiles=true&sort=-first_seen` (see AR15).
- A side's runs come from `GET runs?machine={name}&commit={value}&has_profiles=true`,
  every page of it. The side has no run to select until the whole list has
  loaded, since the latest run is selected.
- A side's tests come from `GET runs/{uuid}/profiles`, which also gives the UUID
  of each test's profile.
- A profile's top-level counters come from `GET profiles/{uuid}`, and its
  functions from `GET profiles/{uuid}/functions`.
- A function's instructions come from
  `GET profiles/{uuid}/disassembly?function={name}`.

What the page fetches of a profile -- its counters, its functions and their
instructions -- is kept while the page is open, and two sides that show the
same profile share it. Changing the counter or the Values therefore never
fetches anything, and neither does going back to a function or a profile
already shown. Leaving the page discards it, so coming back fetches it again.
The lists the side controls offer -- suites, machines, commits, runs and a
run's profiles -- are cached as they are elsewhere in the app.

When the page is loaded from a URL, it sends the requests that the URL's values
call for without first checking that the values are usable. If a value turns
out to be unusable, whatever was fetched for it is discarded, and an error for
it is not reported.

When the page cannot fetch something it needs -- the suites, a suite's machines,
a side's runs, a commit lookup, a run's profiles, a profile, its functions or a
function's instructions -- it says so where that would be shown (see AR7). One
side's failure does not affect the other side, and the counter comparison shows
the profiles whose counters have loaded.


### PF9: URL State

All selection state is encoded as query parameters for shareability:
- `suite_a`, `machine_a`, `commit_a`, `run_a`, `test_a`, `function_a`
- `suite_b`, `machine_b`, `commit_b`, `run_b`, `test_b`, `function_b`
- `counter`
- `values`: `absolute` or `cumulative`

As AR2 "State" describes, a function is left out of the URL when it is its
side's hottest, and the counter and the Values when they are their defaults. A
selected run is always kept, however, although the latest run is selected by
default: which run is the latest can change as runs are submitted, and a link
to a profile must keep showing that profile.

A value the page cannot use is dropped (see AR2 "State"):
- a suite or machine that does not exist, a commit the side's commit picker
  would not offer (see AR15), or a machine named without a suite or a commit
  without a machine, along with whatever PF2 clears when that control is
  cleared;
- a run that is not in the side's run list, which selects the latest run
  instead, or a run named without a commit;
- a test the side's run has no profile of, or a test named without a run,
  along with the side's function;
- a function the side's profile does not have, or a function named without a
  test;
- a counter that the profiles shown do not have, or an unknown Values setting.

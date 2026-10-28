# v5 Web UI: Architecture

This document covers the SPA architecture, how the server serves it,
client-side routing, the page hierarchy, the navigation bar, and the conventions
that every page follows. For individual page specifications, see the other
documents in this directory.


## AR1: Context

LNT v4's web UI is built on Flask/Jinja2 server-rendered pages. It is dated and
difficult to use. The v5 REST API provides full access to the underlying data
contained in a LNT v5 instance. This SPA uses it to provide a more dynamic experience.


## AR2: Single-Page Application

One SPA with client-side routing. Every route in the page hierarchy below
(AR3) is served by the same application; there is no point at which navigating
within the UI causes a full page reload.

- **Routing**: Simple path-based client-side router. No full page reload when
  navigating within the SPA. Modified clicks (Cmd+Click, Ctrl+Click,
  Shift+Click, middle-click) bypass the SPA router and let the browser handle
  them natively (e.g. open in a new tab).
- **Serving**: The server returns the SPA's `index.html` for any path that is
  not `/api/...`, `/llms.txt`, `/robots.txt`, `/healthz`, or a static asset.
  This catch-all is what makes deep links and hard refreshes work -- pasting
  `/suites/nts/runs/{uuid}` or reloading on it must resolve to that route rather
  than 404. A static asset is a path under `/assets/` (see Caching) or whose
  first segment contains a `.`; one the build does not contain is a 404. Every
  page in AR3 must start with a segment containing no `.`. Unmatched `/api/...`
  paths are a genuine 404 and must answer with the API's JSON error envelope
  (see I4) rather than falling through to the SPA.
- **Caching**: The client build gives every file under `/assets/` a
  content-hashed name, so these files are served as immutable
  (`public, max-age=31536000, immutable`). Everything else served for the SPA,
  `index.html` included, is revalidated on every use
  (`no-cache, max-age=0`), so that a deploy takes effect on the next page load.
  A request for a file that does not exist follows I9 instead.
- **Code splitting**: Routes are lazy-loaded so the initial bundle stays small
  (external dependencies are fetched on demand).
- **State**: URL query params for shareable deep-links; the auth token is
  persisted in the browser. A page writes its settings to the URL as they
  change, leaving out those at their default. Changing the path adds a history
  entry, whereas changing only the query parameters replaces the current one,
  so that Back leaves the page rather than stepping back through its settings.
  Conversely, a page loaded from a URL is in the state that URL describes:
  each setting takes effect as if the user had just made it, along with
  everything it drives -- a filter in the URL filters the rows it applies to,
  and every count derived from them, as soon as the page loads. A value the
  page cannot use (a machine or test that does not exist, a metric the page
  does not offer) is dropped, and the page uses its default for that setting
  instead. A value is only found unusable from a complete response: for a
  list, once all of its pages have loaded. Nothing is dropped while a request
  is still loading, or after it has failed. The same goes for a selection that
  depends on a list. For example, when the machines change on the Graph page, a
  selected test that the new test lists don't have is deselected only once
  every machine's test list has loaded. If a request fails for a value that
  turns out to be unusable, the page does not report the failure: it drops the
  value anyway. A setting holding several values repeats its parameter once per
  value, as the API does (see I3). The inputs of a form, such as what a panel is
  about to create or add, are not settings, and are not kept in the URL.


## AR3: Page Hierarchy

```
/                                     Dashboard (landing page -- sparkline trend overview)
/suites                               Test Suites (selects the first suite; see TS1)
/suites/{ts}                          Test Suites (browsing tabs and schema of the selected suite)
/suites/{ts}/machines/{name}          Machine Detail
/suites/{ts}/runs/{uuid}              Run Detail
/suites/{ts}/commits/{value}          Commit Detail
/suites/{ts}/regressions/{uuid}       Regression Detail
/graph?suite={ts}&machine=...         Graph (time series) -- suite-agnostic
/compare?suite_a={ts}&...             Compare -- suite-agnostic
/profiles?suite_a={ts}&...            Profiles (A/B profile viewer) -- suite-agnostic
/admin                                Admin (API keys, suite creation -- suite-agnostic)
```


## AR4: Navigation Bar

```
[LNT] [Test Suites] [Graph] [Compare] [Profiles] [API]  <---->  [Admin] [Settings]
```

All navbar links use SPA navigation. There is no full page reload anywhere in
the app: every route in the page hierarchy above belongs to the same
application, so navigating between a suite-scoped page and a suite-agnostic
one is an ordinary client-side transition. The single exception is [API],
which opens the interactive API documentation viewer at `/api/docs` (see I8) in
a new tab -- that is a separate document, not an SPA route.

Graph, Compare, and Profiles links append `?suite={ts}` / `?suite_a={ts}` when
navigated from a suite-scoped page, pre-filling the current suite. The Test
Suites link targets `/suites/{ts}` to preserve the suite context, and `/suites`
otherwise (see TS1).

Every page ends with a footer in small, muted text, `LNT v5 · {revision}`, where
the revision is the API index's `revision` (E1), linking to
`https://github.com/llvm/llvm-lnt/commit/{revision}` in a new tab. It shows the
revision as of when the page was loaded, the one whose UI is running, and is not
refreshed by navigating. The footer never reports a failure: while the index
loads, if it cannot be fetched, or if `revision` is null, it shows `LNT v5`
alone (unlike AR7).


## AR5: Design Consistency

All pages should share a consistent look and feel -- comboboxes, metric
selectors, table styling, progress/error feedback, color scheme, and layout
spacing. The same components are reused across pages rather than reinvented
per-page. A disabled control looks disabled, the same way whatever its kind:
a button, a dropdown, a combobox or a text input. Pages with selection
controls (dropdowns, filters, aggregation settings) wrap them in a shared
controls panel -- a lightly shaded box with a border -- so the settings area is
visually distinct from the page content.


## AR6: Display Conventions

These hold on every page, unless the page specifies otherwise.

- A commit is shown by its *display value*: the value of the commit field the
  schema marks `display: true` (see D4) when the commit has one, and the commit
  string otherwise, followed by ` (tag)` when the commit has a tag. The display
  value is for display only: links, URL state and API requests use the commit
  string.
- A metric, machine field or commit field is labelled with its `display_name`
  when the schema sets one, and with its `name` otherwise.
- Where a page names a metric's unit, it writes its `unit` followed by its
  `unit_abbrev` in parentheses, as much of either as is set (`seconds (s)`,
  `seconds`, `(s)`), and only once when the two are identical (`cycles`, not
  `cycles (cycles)`). A value shown with its unit is left to the page.
- Timestamps are shown in the browser's local time zone.
- A run is placed in time by when it was measured, its `measured_at` (see D5),
  rather than when it was submitted: runs are listed in that order, the latest
  run is the one measured last, and where a time shown for a run is labelled,
  the label is `Measured`. A page that uses `submitted_at` instead says so.
- A measured `real` value is shown to at most 4 significant digits, but never
  with fewer digits than its integer part has (`1.264`, `66656`, `4123456789`).
  A value that rounds to less than 0.001 in magnitude, other than 0, is shown in
  exponent notation rather than with its leading zeros (`3.75e-10`,
  `-1.235e-4`). Zero is shown as `0`, without a sign.
- Where space is short, a UUID is shortened to its first 8 characters.
- A regression without a title is labelled `(untitled)`.
- A regression's bug, and a machine or commit field's value where it is shown
  as such, are a link opening in a new tab when they are an `http` or `https`
  URL, and plain text otherwise, since the API stores any string. A value is
  such a URL when, ignoring whitespace at either end, it is `http://` or
  `https://`, in any case, followed by at least one character, and contains no
  whitespace: a URL within other text is not one. The link leads to the value
  without that whitespace, even where the value is cut short. A commit's display value, where it names the
  commit, is not a field's value shown as such.


## AR7: Paginated Tables and Fetch Errors

A table that shows a paginated endpoint (see I2) a page at a time has
`[<- Previous]` and `[Next ->]` below it. Pagination is forward-only, so
Previous returns to pages the user has already visited. The position is not kept
in the URL: reloading the page shows the first page again.

When the rows a table should show cannot be fetched -- for another page, search
or filter -- the table and its pager give way to the error, with a way to try
again, rather than leave up the rows of another page or search.

A table that loads every page of a paginated endpoint, showing the rows as they
arrive, gives way to the error in the same way if the first page cannot be
fetched. If a later page cannot be, it keeps the rows it has, says that they are
incomplete, and offers to load the rest.

This also applies outside tables: when a page cannot fetch something it needs,
it says what could not be loaded, offers a way to try again, and keeps showing
everything else it can.

When the cursor of a later page is rejected with `invalid_cursor` (I2),
whatever fetches the pages of a paginated endpoint starts again from the first
page rather than report a failure: a table shown a page at a time goes back to
it, and anything else fetches its pages again. While it does, or while a table
that loads every page or a picker's list of suggestions (see AR9) fetches again
what it failed to load, it keeps the rows it shows, if any, and says that it is
still loading. It reports a failure only if fetching again fails too, such as
when a cursor is rejected again right after starting again.

Wherever a failure offers a way to try again, an error saying that what was
asked for does not exist (I4's `not_found`) does not, since trying again would
get the same answer.


## AR8: Disabled Links

A link that leads nowhere for now -- to a comparison with a commit that does not
exist, say -- is shown disabled: no click follows it, modified or not, and it
says why on hover and to assistive technology.


## AR9: Text Filtering

A client-side text filter -- one that narrows data already loaded in the
browser -- matches its text as a case-insensitive substring.

The test filters of the Graph and Compare pages also have a regex mode, since
they pick out sets of tests: those to plot (with the header checkbox), or those
a whole operation covers (a geomean, an export). A "Regex" checkbox beside the
input switches it between substring and regex matching, both case-insensitive.
While its text is not a valid regex, the input shows the red halo (see AR11),
and the filter keeps applying the last valid filter, or none if there has not
been one yet. Switching to regex mode on text that is not a valid regex
therefore keeps matching that text as a substring.

Typing in a client-side filter must never lag behind the keyboard, even over
thousands of rows -- the test tables of the Graph and Compare pages, or a run's
samples. The rows it filters, and any chart that depends on them, may update
just after.

Inputs that search the server rather than filter data already loaded -- the
Test Suites tabs' searches (TS1), commit pickers (AR15) and the regression
picker (CP9) -- ask the server again as the user types (debounced), from the
first page. A response for earlier text never replaces the one for the current
text, though the previous results may stay up until the current ones arrive.
Pickers load their suggestions a page at a time: scrolling to the end of the
suggestions loads the next page.


## AR10: Range Selection

In a list whose rows are selected with checkboxes, a click toggles a row,
whether by mouse or from the keyboard, and the anchor is the last row clicked,
unless the list refused the click (see GR7). A click with Shift held also gives
every row shown from the anchor to the clicked one, both included, the clicked
row's new state. It never changes a row that a filter hides. Without an anchor
among the rows shown, a click with Shift held acts as a plain click. A checkbox in the list's header selects every row shown,
or deselects them all if they are all selected already. It, and any other change
to the selection than a click on a row, leaves the anchor where it is.


## AR11: Invalid Input

An input whose text is invalid -- an invalid regex in a test filter, a name or a
repository URL the schema editor rejects (TS7), an ordinal that is not an
integer its column can hold (DT3), a machine name that I1 rejects or an empty
one (DT1), or a field value that its type does not allow (DT1) -- shows a red
halo (red border and glow) for as long as its text stays invalid.


## AR12: Inline Editing

A field edited in place shows its value with an Edit button. Clicking Edit
replaces the value with an input, which takes the focus, and Save and Cancel
buttons. Enter saves and Escape cancels, unless the input uses the key itself: a
combobox uses them, for example, to pick a suggestion or close its list, and in
a multi-line input, Enter starts a new line and Ctrl+Enter (Cmd+Enter on a Mac)
saves.

Whitespace at either end of the text is ignored: it is removed before the text
is checked or saved, so text that is only whitespace clears the value, like an
empty input -- unless the field must have a value, such as a machine's name
(DT1), in which case empty text is invalid (see AR11). Saving unchanged text --
the text the input opened with, or the stored value once trimmed -- closes the
input without sending anything, so a stored value with whitespace at either end
keeps it. Invalid text cannot be saved. A field whose changes must be confirmed,
such as a machine's name (DT1), asks for the confirmation when saved, and saves
only once it is given. While the confirmation is asked or a save is in progress,
the input and its buttons cannot be used. If the save fails, the input stays
open with its text and says why. If it succeeds, the input closes and the field
shows the value the API returned, so an edit never appears before the API has
accepted it. When the input closes, the focus returns to the Edit button. Edit
and Save need the scope that the change needs (see AR17). However long the
value, the Edit button, and the input's Save and Cancel, stay in view: a value
too long to show whole scrolls on its own, beside its Edit button.


## AR13: Controls Saving on Change

Some controls, such as a checkbox or a dropdown, save as soon as the user
changes them. Such a control keeps showing the stored value until the API has
accepted the change. While a save is in progress, the control ignores further
changes, but can still be focused. Only picking an option from the open list
changes a dropdown: a closed dropdown does not step through its options, from
the keyboard or otherwise, since each step would be saved. If the save fails,
the control keeps showing the stored value and says why. The control needs the
scope that the change needs (see AR17).


## AR14: Comboboxes

Every combobox follows the standard combobox accessibility conventions, with
manual selection: typing narrows the suggestions, and the value changes only
when the user picks a suggestion, by clicking it or by moving to it with
ArrowDown/ArrowUp and pressing Enter. Leaving the combobox without picking one
puts back the text of its current value, and emptying the input clears the
value. While the input holds text, a button in it empties it, so that a value
can be cleared without editing the text. When no suggestion matches the typed
text, the list says so. The list closes on Escape, on blur, on a click outside
it, once a suggestion is picked, and when the page, or a box holding the
combobox, scrolls. A list too long to show whole stops scrolling at its ends
rather than scrolling the page.

So that a value can be pasted and entered, Enter with no suggestion highlighted
picks the suggestion that the typed text exactly identifies: its shown text, or
the identifier of what it stands for, such as a commit string or a regression's
UUID. The comparison is case-sensitive and ignores surrounding whitespace. The
suggestion must be the only one so identified among the suggestions loaded for
that text -- the first page of them, unless the user has scrolled for more.
Otherwise, the text stays as it is. An Enter pressed before those suggestions
have loaded takes effect once they have, unless the text has changed meanwhile,
as it does when the user leaves the combobox.

A combobox may list some of its suggestions in groups, each under a heading,
after the suggestions in no group. A heading is not a suggestion: it cannot be
picked, and moving through the suggestions skips it. It is shown only while
some suggestion under it is shown, so typing that matches none of a group's
suggestions also hides its heading.


## AR15: Commit Pickers

Every combobox that selects a commit -- on the Compare and Profiles pages, for
Graph baselines, and for a regression's commit -- lists its suggestions highest
ordinal first, followed by the commits without an ordinal (ad-hoc A/B
experiment commits; see D1), most recently seen first, as
`GET commits?sort=-ordinal` returns them with the picker's filters (see E3). A
picker searches the server, as AR9 describes, rather than fetching every commit
and filtering locally: a machine can have tens of thousands of commits. The
search covers the display value the suggestions show only if the schema marks
the display field `searchable` (see O4).

A commit the picker is given rather than
chosen -- restored from the URL, or kept while its filters change -- is looked
up with the picker's filters plus `commit=` (see E3). The lookup returns
the commit, with its display value, only if the picker would offer it.
Otherwise the commit is unusable, and the picker is cleared as if the user had
emptied it (see AR2 "State"). If the lookup fails, the picker keeps the commit,
says that the lookup failed, and offers to try again (see AR7).

If the user types in a commit picker but does not pick one of its suggestions,
the form containing the picker cannot be submitted until they do, or clear the
picker, and the form says so. Otherwise, the form would be submitted with a
commit other than the one the text shows. An empty picker is fine: it means no
commit, which a form may accept.


## AR16: Confirmations and Deletions

Deleting a suite, a machine, a commit, a run or a regression is confirmed by
typing its identifier -- the name of a suite or a machine, the commit string of
a commit, the first 8 characters of the UUID of a run or a regression -- before
the request is sent; the prompt shows the text to type. Saving a schema change
that removes entries (TS7) is confirmed the same way, by typing the suite name,
since it destroys their stored values. Revoking an API key (AD1), which destroys
nothing, asks for a plain confirmation instead, as does renaming a machine
(DT1), since run submissions that still use the old name create a new machine.
Removing indicators from a regression (DT4) is not confirmed at all: it destroys
no measured data, and the indicators can be added again.

Once the entity a page is about has been deleted, the page leaves for the one
its spec names, which takes its place in the history rather than adding an entry
(an exception to AR2 "State"), so that Back from the page shown next does not
return to it. The same goes for the page of a machine once it has been renamed
(DT1), which leaves for the page of the new name. If the user has already left
the page when the deletion or the rename completes, they stay where they are.
Data fetched before a deletion is never used to show the deleted entity again:
not on the page shown next while it loads, and not on the entity's own page if
the user gets back to it through the browser history.


## AR17: Authentication

The v5 API allows unauthenticated reads, except for the API key endpoints, which
require `admin` scope even to read (see I5). No configuration can gate reads, so
the SPA never needs a token merely to browse. It sends the token only with the
requests that need more than `read` scope, and with the check below.

The navigation bar includes a Settings panel with a Bearer token input. The
token is checked through `GET /api/auth` (see E12) when it is entered and
whenever the SPA loads: the panel shows the name and scope of the key it
belongs to, and its suites when it is restricted to some (see I5), that it is
not valid (the API refuses it with a 401, or it cannot be sent at all), or that
the check failed (any other error), which it offers to retry. It can also
clear the token. Until a check succeeds, the SPA behaves as if no token were
set, unless a page specifies otherwise (see AD1).

The token is shared by every tab of the SPA: a change made in one tab takes
effect in the others, which check the new token. It is also checked again
whenever a request sent with it gets a 401, as its key may have been revoked in
the meantime.

Unless a page specifies otherwise, a control whose action needs a scope the
token does not grant -- or any scope above `read`, when no valid token is set --
is disabled, and hovering it says which scope it needs. A token whose key is
restricted to some suites (see I5) grants its scope only for actions on those
suites, and an action on no suite, such as creating one (AD2), needs an
instance-wide token. The hover of a control whose action is on no suite says
that it needs an instance-wide token, and for a restricted token, that of a
control on a suite says in which suite. A request the API nevertheless refuses
with 401 or 403 is reported as
`Permission denied. Set an API token with the required scope in Settings.`


## AR18: Machine Pickers

Every control that picks machines from a suite's machine list lists the tracked
machines first, then the untracked ones (see D5), each in the order the API
lists them (by name; see E2).

A combobox lists the untracked machines in a group headed `Untracked` (see
AR14). A list of machines with checkboxes marks each untracked machine with the
`untracked` badge of the Machines tab (TS3) instead, which assistive technology
reads as part of the machine's name. Filtering, by typing in a combobox or with
a list's filter, covers both tracked and untracked machines.

The Machines tab (TS3) is a listing rather than a picker: it lists every
machine by name.


## AR19: Unsaved Changes

A form whose spec says so asks before the user loses its unsaved changes, as
that spec defines them, by going to another URL within the SPA (another tab or
page, Back or Forward) or by leaving the SPA (reloading, closing the browser
tab, a link out of it). Within the SPA, the user either confirms or stays, with
the URL, the page and the form as they were, and nothing asks again until they
try to leave again; leaving the SPA, the browser asks with its own prompt.
Changes still being saved are unsaved: leaving does not cancel the save, but its
failure could no longer be shown. The form's Cancel, and the form closing on its
own (once saved, or once what it edits is gone), ask nothing.


## AR20: Repository Links

A page may link a commit, or the changes between two commits, into the
repository that the suite's commits come from (see D4's `repository`), where
its spec says so:

- A link to a commit, "View on {label}", leads to the suite's `commit_url`
  filled in with the commit's commit string. A link to the changes between two
  commits, a "Diff ... on {label}" whose text the page gives, leads to its
  `range_url` filled in with two commit strings, and the page says which
  commits fill in `{from}` and `{to}`. Templates are filled in as D4 says.
- When the suite has no `label`, "on {label}" reads "in repository" instead:
  "View in repository", "Diff ... in repository".
- Both kinds of link open in a new tab.
- A link is shown only when the suite sets the template it needs, and that
  template passes D4's rules, which the UI checks again rather than trust the
  API with them. Otherwise, the link is not shown at all, not even disabled. A
  page may show a link to changes disabled (see AR8) while it lacks one of the
  two commits.
- A commit needs only its commit string to be linked, so a commit without an
  ordinal is linked too.


## AR21: Commit Cards

A link to a commit's page has a card about the commit where its page's spec says
so:

- Resting the pointer on the link opens its card beside it, after a short delay.
  The card stays open while the pointer is on the link or on the card, so that
  its links can be followed, and closes once the pointer has left both, after a
  short delay. It also closes on Escape, wherever the focus is, and when the page
  scrolls. Once Escape has closed it, or kept it from opening, it opens again
  only once the pointer has left the link and come back.
- Only hovering opens it: not keyboard focus, so that moving through a table
  from the keyboard does not open a card on every row, and not touch, which has
  no hover. Nothing is lost that way, since everything the card shows is also on
  the page of the commit, where the link leads.
- The card never takes the focus, and does not keep it: when it closes with the
  focus inside, the focus returns to its link. While it is open, assistive
  technology can reach it from the link, as details of the link rather than as
  a description of it, since it holds links.

The card shows:

- at its top, naming it, the commit's display value, with its tag (see AR6);
- a `Commit` row with the commit string, and a button copying it;
- an `Ordinal` row with the commit's ordinal, left out when it has none;
- a row for each commit field that has a value for the commit, in schema order,
  labelled as AR6 says, with the value as DT1 shows a machine's;
- "View on {label}" for the commit (see AR20).

A value longer than two lines is cut short to two, with no hover of its own, and
read whole by assistive technology; the commit's page shows it whole.

The card shows the commit as the page loaded it for the link's text, so that the
two always agree. When the page has not loaded it, because it could not for
instance, the card fetches it when first shown, and never before: a page with
many such links does not fetch their commits in advance. Until it has, the card
says that it is loading, with the commit string at its top. If the commit cannot
be fetched, the card says so and offers to try again (see AR7), and if it no
longer exists, the card says so.

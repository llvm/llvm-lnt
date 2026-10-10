# v5 Web UI: Architecture

This document covers the SPA architecture, how the server serves it,
client-side routing, the page hierarchy, and the navigation bar. For individual
page specifications, see the other documents in this directory.


## AR1: Context

LNT v4's web UI is built on Flask/Jinja2 server-rendered pages. It is dated and
difficult to use. The v5 REST API provides full access to the underlying data
contained in a LNT v5 instance. This SPA uses it to provide a more dynamic experience.


## AR2: Single-Page Application

One SPA with client-side routing. Every route in the page hierarchy below is
served by the same application; there is no point at which navigating within
the UI causes a full page reload.

- **Routing**: Simple path-based client-side router. No full page reload when
  navigating within the SPA. Modified clicks (Cmd+Click, Ctrl+Click,
  Shift+Click, middle-click) bypass the SPA router and let the browser handle
  them natively (e.g. open in a new tab).
- **Serving**: The server returns the SPA's `index.html` for any path that is
  not `/api/...`, `/llms.txt`, `/healthz`, or a static asset. This catch-all is
  what makes deep links and hard refreshes work -- pasting
  `/suites/nts/runs/{uuid}` or reloading on it must resolve to that route rather
  than 404. Unmatched `/api/...` paths are a genuine 404 and must answer with
  the API's JSON error envelope (see I4) rather than falling through to the
  SPA.
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
  change. Changing the path adds a history entry, whereas changing only the
  query parameters replaces the current one, so that Back leaves the page
  rather than stepping back through its settings. Conversely, a page loaded
  from a URL is in the state that URL describes: each setting takes effect as
  if the user had just made it, along with everything it drives -- a filter in
  the URL filters the rows it applies to, and every count derived from them,
  as soon as the page loads. A value the page cannot use (a machine or test
  that does not exist, a metric the page does not offer) is dropped, and the
  page uses its default for that setting instead. Only a successful response
  can show that a value is unusable: a failed request drops nothing. A setting
  holding several values repeats its parameter once per value, as the API does
  (see I3).

**Design consistency**: All pages should share a consistent look and feel --
comboboxes, metric selectors, table styling, progress/error feedback, color
scheme, and layout spacing. The same components are reused across pages rather
than reinvented per-page. Pages with selection controls (dropdowns, filters,
aggregation settings) wrap them in a shared controls panel -- a lightly shaded
box with a border -- so the settings area is visually distinct from the page
content.

**Display conventions**: These hold on every page, unless the page specifies
otherwise.

- A commit is shown by its *display value*: the value of the commit field the
  schema marks `display: true` (see D4) when the commit has one, and the commit
  string otherwise, followed by ` (tag)` when the commit has a tag. The display
  value is for display only: links, URL state and API requests use the commit
  string.
- A metric, machine field or commit field is labelled with its `display_name`
  when the schema sets one, and with its `name` otherwise.
- Timestamps are shown in the browser's local time zone.
- A measured `real` value is shown to at most 6 significant digits, but never
  with fewer digits than its integer part has (`1.26432`, `66655.7`,
  `4123456789`).
- Where space is short, a UUID is shortened to its first 8 characters.
- A regression without a title is labelled `(untitled)`.
- A regression's bug is a link opening in a new tab when it is an `http` or
  `https` URL, and plain text otherwise, since the API stores any string.

**Paginated tables**: A table that shows a paginated endpoint (see I2) a
page at a time has `[<- Previous]` and `[Next ->]` below it. Pagination is
forward-only, so Previous returns to pages the user has already visited. The
position is not kept in the URL: reloading the page shows the first page again.

When the rows a table should show cannot be fetched -- for another page, search
or filter -- the table and its pager give way to the error, with a way to try
again, rather than leave up the rows of another page or search.

A table that loads every page of a paginated endpoint, showing the rows as they
arrive, gives way to the error in the same way if the first page cannot be
fetched. If a later page cannot be, it keeps the rows it has, says that they are
incomplete, and offers to load the rest.

Wherever a failure offers a way to try again, an error saying that what was
asked for does not exist (I4's `not_found`) does not, since trying again would
get the same answer.

**Disabled links**: A link that leads nowhere for now -- to a comparison with a
commit that does not exist, say -- is shown disabled: no click follows it,
modified or not, and it says why on hover and to assistive technology.

**Text filtering**: A client-side text filter -- one that narrows data already
loaded in the browser -- matches its text as a case-insensitive substring.

The test filters of the Graph and Compare pages also have a regex mode, since
they select the tests that a whole operation covers (plotting, a geomean, an
export). A "Regex" checkbox beside the input switches it between substring and
regex matching, both case-insensitive. While its text is not a valid regex, the
input shows the red halo (see Invalid input), and the filter keeps applying the
last valid one, or none if there has not been one yet.

Inputs that search the server rather than filter data already loaded -- the
Test Suites tabs' searches (TS1), commit pickers (see below) and the regression
picker (CP9) -- ask the server again as the user types (debounced), from the
first page. A response for earlier text never replaces the one for the current
text, though the previous results may stay up until the current ones arrive.

**Text filtering performance**: Typing in a client-side filter must never lag
behind the keyboard, even over thousands of rows -- the test tables of the Graph
and Compare pages, or a run's samples. The rows it filters, and any chart that
depends on them, may update just after.

**Invalid input**: An input whose text is invalid -- an invalid regex in a test
filter, a name the schema editor rejects (AD3), an ordinal that is not an
integer its column can hold (DT3) -- shows a red halo (red border and glow) for
as long as its text stays invalid.

**Inline editing**: A field edited in place shows its value with an Edit button.
Edit replaces the value with an input, which takes the focus, and Save and
Cancel buttons. Enter saves and Escape cancels, unless the input uses the key
itself, as a combobox does, or is a multi-line input, where Enter starts a new
line and Ctrl+Enter (Cmd+Enter on a Mac) saves. Surrounding whitespace is
ignored, and emptying the input clears the value. Saving the text as the input
opened with changes nothing, whatever whitespace the stored value has. While the
input's text is invalid, it cannot be saved. While a save is under way, neither
the input nor its buttons can be used. A save that fails leaves the input open
with its text, and says why it failed. One that succeeds closes the input, and
the field shows the value the API returned: an edit is never shown before the
API has accepted it. Once the input closes, the focus goes back to the Edit
button. Edit and Save need the scope the change needs (see "Authentication").

**Controls saving on change**: A control that saves as soon as it is changed --
a checkbox, or a dropdown -- shows the value the API holds, not the one picked,
until the API has accepted the change. While a change is under way, the control
ignores further changes, but can still take the focus. Only a deliberate pick is
a change: a dropdown does not step through its options from the keyboard while
it is closed, which would save each of them on the way. A change that fails
leaves the control showing the stored value, and says why it failed. The control
needs the scope the change needs (see "Authentication").

**Comboboxes**: Every combobox follows the standard combobox accessibility
conventions, with manual selection: typing narrows the suggestions, and the
value changes only when the user picks a suggestion, by clicking it or by moving
to it with ArrowDown/ArrowUp and pressing Enter. Leaving the combobox without
picking one puts back the text of its current value, and emptying the input
clears the value. While the input holds text, a button in it empties it, so
that a value can be cleared without editing the text. When no suggestion
matches the typed text, the list says so.
The list closes on Escape, on blur, on a click outside it and once a suggestion
is picked.

So that a value can be pasted and entered, Enter with no suggestion highlighted
picks the suggestion that the typed text exactly identifies: its shown text, or
the identifier of what it stands for, such as a commit string or a regression's
UUID. The comparison is case-sensitive and ignores surrounding whitespace. The
suggestion must be the only one so identified among the suggestions loaded for
that text -- the first page of them, unless the user has scrolled for more.
Otherwise, the text stays as it is. An Enter pressed before those suggestions
have loaded takes effect once they have, unless the text has changed meanwhile,
as it does when the user leaves the combobox.

**Commit pickers**: Every combobox that selects a commit -- on the Compare and
Profiles pages, for Graph baselines, and for a regression's commit -- lists its
suggestions most recently seen first, as `GET commits?sort=-first_seen` returns
them with the picker's filters (see E3). That order keeps commits without an
ordinal (ad-hoc A/B experiment commits; see D1) selectable, placed by recency
among the ordered ones, whereas `sort=-ordinal` would drop them. A picker
searches the server as above rather than fetching every commit and filtering
locally: a machine can have tens of thousands of commits. The search covers the
display value the suggestions show only if the schema marks the display field
`searchable` (see O4).

A page of matches need not hold every matching commit: scrolling to the end of
the suggestions loads the next page. A commit the picker is given rather than
chosen -- restored from the URL, or kept while its filters change -- is looked
up with the picker's filters plus `commit=` (see E3). The lookup returns
the commit, with its display value, only if the picker would offer it.
Otherwise the commit is unusable, and the picker is cleared as if the user had
emptied it (see "State").

If the user types in a commit picker but does not pick one of its suggestions,
the form containing the picker cannot be submitted until they do, or clear the
picker, and the form says so. Otherwise, the form would be submitted with a
commit other than the one the text shows. An empty picker is fine: it means no
commit, which a form may accept.

**Deletions**: Deleting a suite, a machine, a commit, a run or a regression is
confirmed by typing its identifier -- the name of a suite or a machine, the
commit string of a commit, the first 8 characters of the UUID of a run or a
regression -- before the request is sent; the prompt shows the text to type.
Saving a schema change that removes entries (AD3) is confirmed the same way, by
typing the suite name, since it destroys their stored values. Revoking an API
key (AD1), which destroys nothing, asks for a plain confirmation instead.

Once the entity a page is about has been deleted, the page leaves for the one its
spec names, which takes its place in the history rather than adding an entry (an
exception to "State"), so that Back does not lead to the deleted entity. If the
user has already left the page by then, it stays where they are. Once deleted,
the entity is not shown again from data fetched before the deletion, even while
the page shown next fetches its own.

**Authentication**: The v5 API allows unauthenticated reads, except for the API
key endpoints, which require `admin` scope even to read (see I5). No
configuration can gate reads, so the SPA never needs a token merely to browse.
It sends the token only with the requests that need more than `read` scope, and
with the check below.

The navigation bar includes a Settings panel with a Bearer token input. The
token is checked through `GET /api/auth` (see E12) when it is entered and
whenever the SPA loads: the panel shows the name and scope of the key it
belongs to, that it is not valid (the API refuses it with a 401, or it cannot be
sent at all), or that the check failed (any other error), which it offers to
retry. It can also clear the token. Until a check succeeds, the SPA behaves as
if no token were set.

The token is shared by every tab of the SPA: a change made in one tab takes
effect in the others, which check the new token. It is also checked again
whenever a request sent with it gets a 401, as its key may have been revoked in
the meantime.

Unless a page specifies otherwise, a control whose action needs a scope the
token does not grant -- or any scope above `read`, when no valid token is set --
is disabled, and hovering it says which scope it needs. A request the API
nevertheless refuses with 401 or 403 is reported as
`Permission denied. Set an API token with the required scope in Settings.`


## AR3: Page Hierarchy

```
/                                     Dashboard (landing page -- sparkline trend overview)
/suites                               Test Suites (suite picker, no suite selected)
/suites/{ts}                          Test Suites (browsing tabs for the selected suite)
/suites/{ts}/machines/{name}          Machine Detail
/suites/{ts}/runs/{uuid}              Run Detail
/suites/{ts}/commits/{value}          Commit Detail
/suites/{ts}/regressions/{uuid}       Regression Detail
/graph?suite={ts}&machine=...         Graph (time series) -- suite-agnostic
/compare?suite_a={ts}&...             Compare -- suite-agnostic
/profiles?suite_a={ts}&...            Profiles (A/B profile viewer) -- suite-agnostic
/admin                                Admin (API keys, schemas -- suite-agnostic)
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
Suites link targets `/suites/{ts}` to preserve the suite context.

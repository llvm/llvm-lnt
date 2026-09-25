# v5 Database Layer: Operations

This document covers how data flows through the v5 database: submission, metadata
management, search, time-series queries, and ordinal management.


## D6: Submission Format

Runs are submitted as JSON via `POST /api/suites/{testsuite}/runs`.

Machine and Commit are each submitted as an entity object of the same shape:
the identity attribute, any built-in attributes, and a `fields` dict holding
the schema-declared metadata. Keeping declared metadata in its own namespace
means a field can never collide with an identity or built-in key, and makes the
object identical to the one the entity's own creation endpoint accepts (see D7).

```json
{
  "format_version": "5",
  "uuid": "550e8400-e29b-41d4-a716-446655440000",
  "machine": {
    "name": "my-machine",
    "tracked": true,
    "fields": {
      "hardware": "x86_64",
      "os": "linux"
    }
  },
  "commit": {
    "value": "abc123def456",
    "ordinal": 593922,
    "fields": {
      "git_sha": "abc123def456789...",
      "author": "Jane Doe",
      "commit_message": "Fix vectorizer regression"
    }
  },
  "run_parameters": {
    "build_config": "Release"
  },
  "tests": [
    {
      "name": "test.suite/benchmark",
      "execution_time": 1.23,
      "compile_time": 0.45,
      "profile": "<base64-encoded profile data>"
    }
  ]
}
```

- `format_version`: Required, must be `"5"`.
- `uuid`: Optional. Client-provided UUID for the run, in standard `8-4-4-4-12`
  hyphenated hex format (e.g., output of `uuidgen`). Case-insensitive on input;
  normalized to lowercase for storage. Any UUID version is accepted (v4, v5,
  v7, etc.) -- only the format is validated. If a run with the same UUID
  already exists in the test suite, the server returns 409 `duplicate` (see R4),
  which a submitting bot recovers from by retrying with a fresh one. If omitted,
  the server generates a random UUID v4.
- `machine`: Required object identifying the machine this run was measured on.
  - `name`: Required string. The machine's identity.
  - `fields`: Optional. Every key must be declared in the schema's
    `machine_fields`. See D7 for undeclared keys and for how metadata is
    reconciled when the machine already exists.
  - `tracked`: Optional boolean, a built-in attribute rather than a
    `machine_field`. Controls whether the machine participates in automatic
    machine selection. It applies only when the machine is created
    (first-write-wins) and defaults to `true` when omitted; submitting it for a
    machine that already exists is ignored. Use
    `PATCH /api/suites/{testsuite}/machines/{name}` to change it afterwards.
- `commit`: Required object identifying the commit this run belongs to.
  - `value`: Required string. The commit's identity.
  - `fields`: Optional. Every key must be declared in the schema's
    `commit_fields`. See D7 for undeclared keys and for how metadata is
    reconciled when the commit already exists.
  - `ordinal`: Optional integer, a built-in attribute rather than a
    `commit_field`. Places the commit in the suite's total order. It is set
    when the commit has no ordinal yet; when the commit already has a
    different one, the submission is rejected with 409 `ordinal_conflict` (see
    R4). Use `PATCH /api/suites/{testsuite}/commits/{value}` to change an ordinal
    once set. Ordinals are unique within a suite, so a value already held by a
    different commit is rejected with `ordinal_conflict` too (see D11).
  - A run submission never sets `tag`: it is an editorial label applied after
    the fact, not something a submitter knows in advance (see D5).
- `run_parameters`: Optional. Stored as JSONB on the Run. Run has no declared
  field list, so this is a free-form blob rather than a `fields` dict. Nothing in
  it is validated against anything, with one exception: D3's rule about a value
  the stored representation cannot hold reaches into it, at any depth and in an
  object key as much as in a value. Nothing else about it is inspected.
- `tests`: Required list of test entries, at most one per test. It may be empty
  -- a run that measured nothing is still a run -- but it may not be omitted.
  Each entry has `name` plus metric values. The list is deliberately not capped
  the way every other list the API accepts is: a real submission carries tens of
  thousands of entries, and D13 requires resolving them in a fixed number of
  round trips precisely so that it can. The same goes for `run_parameters`. What
  bounds a submission is the deployment's request-body limit (413, see R4),
  which is a property of the deployment rather than of this format.
  - `name` is required, non-empty, and at most the length `{suite}.test.name`
    allows (see D5). Unlike a machine name or a commit value it is not required
    to be usable as a URL path segment: test names legitimately contain `/`, and
    R1 exempts them.
  - Two entries naming the same test are rejected with 400. The format already
    expresses a test measured several times with an array value, and D5 permits
    at most one profile per run+test pair, so two entries for one test could not
    both be stored; refusing up front is better than an integrity failure
    discovered halfway through writing the run.
  - Metric values may be scalars or arrays. An array value (e.g.
    `"execution_time": [0.1, 0.2]`) creates one Sample row per element. All
    arrays in a single test entry must have the same length -- they describe the
    same repetitions -- and scalar values are repeated across the resulting rows.
  - An empty array is rejected with 400. It would produce no rows at all,
    silently discarding every scalar metric in the same entry, which is never
    what a producer meant.
  - An entry therefore yields `max(1, array length)` Sample rows: one when it
    carries no arrays, and one also when it carries nothing but a `name`, or
    nothing but a `name` and a `profile`. That row records that the test ran in
    this run even when it carries no metric values.
  - Every metric key must be declared in the schema's `metrics`; an undeclared
    one is rejected with 400. Values are typed per D3.
  - Metrics with null values must be omitted from the test entry (not sent as
    `"metric": null`); only include metrics that have actual values. A null
    *element* inside an array is rejected for the same reason.
  - An optional `profile` field may contain base64-encoded profile binary data;
    if present, a Profile row is created and linked to the run+test (see D12).
    Null is accepted there and means the entry carries no profile, exactly as
    omitting the key does.
  - `name` and `profile` are reserved keys within a test entry, so neither may
    be a metric name -- this is enforced when the schema is created rather than
    at submission (see D5), so a suite can never hold a metric that no submission
    could populate.

An explicit `null` means "omitted" exactly where the key is both optional and
nullable, and is rejected with 400 everywhere else. A null never selects a
default: `machine.tracked`, either `fields` dict and `run_parameters` all have
defaults, and none of them is nullable, so sending any of them as `null` is a bad
request rather than a request for the default. The keys where a null does mean
"omitted" are `uuid`, `commit.ordinal` and a test entry's `profile`, along with
the individual entries of `machine.fields` and `commit.fields`.

That last case is the one worth spelling out. Inside a submission's
`machine.fields` and `commit.fields`, an explicit `null` is neither written nor
compared against the stored value, exactly as if the key had been omitted. The
key must still be declared, so a misspelled one is rejected whether its value is
null or not. This differs from `PATCH`, where an explicit null clears a stored
value, and the difference is deliberate: a submission never overwrites metadata
(see D7), so there is no clearing for it to express, and R4 has every `fields`
dict in a response carry a `null` for each field the entity has no value for --
so a tool that reads an entity and then submits a run for it would otherwise be
rejected for echoing back the document the API just gave it.


## D7: Machine and Commit Metadata Population

Machine and Commit are the two entities that carry schema-declared metadata
(`machine_fields` and `commit_fields`, see D4) and that a run submission may
create implicitly. Both are represented by an entity object of the same shape
-- identity attribute, built-in attributes, and a `fields` dict of declared
metadata -- and that same object is what every write path accepts:

1. **Inline during run submission**: the payload's `machine` and `commit`
   objects populate the record when it is first created. If the record already
   exists, its metadata is NOT overwritten, and the submitted values must match
   the stored ones (otherwise the submission is rejected).
2. **Explicit creation**: `POST /api/suites/{testsuite}/machines` and
   `POST /api/suites/{testsuite}/commits` take the same entity object, creating
   the record directly without a run.
3. **Via PATCH**: `PATCH /api/suites/{testsuite}/machines/{name}` and
   `PATCH /api/suites/{testsuite}/commits/{value}` set or update metadata at any
   time, overwriting existing values.

**Declared keys only**: on every path, each metadata key must be declared in
the suite's schema; an undeclared key is rejected with 400. Neither entity has
a catch-all blob, so the schema states exactly what may be stored on it.
Declaring a new field is a schema change (`PATCH /api/suites/{name}/schema`,
see D2), not something a submission can do implicitly.

**Matching on re-submission**: the match in path 1 considers only the keys
present in the submission, and a key present with an explicit `null` counts as
absent (see D6). A key the submission omits is not compared, so its stored value
is left alone and can never cause a rejection. Submitters that send different
subsets of a record's metadata therefore coexist, and a field introduced by a
schema change does not break producers that do not send it yet.

A key the submission does send has one of three outcomes. If the record holds no
value for it, the submission fills it in -- which is how a producer that starts
sending a newly declared field populates the records that predate it. If the
stored value equals the submitted one, there is nothing to do. If the stored
value is anything else, the submission is rejected: stored metadata is never
overwritten, and `PATCH` is the only way to change it. The rejection is 409
`conflict` for a declared field and 409 `ordinal_conflict` for a commit's
`ordinal` (see R4), a distinction R4 draws because a client cannot recover from
the second by retrying. Either way the message names the key, the stored value
and the submitted one, so that a submitter can correct its configuration without
reading the database.

Per-entity specifics:

| | Machine | Commit |
|---|---|---|
| Identity attribute | `name` | `value` |
| Declared metadata | `fields`, per `machine_fields` | `fields`, per `commit_fields` |
| Built-in mutable attributes | `tracked` | `ordinal`, `tag` |
| Settable during run submission | `tracked` (first-write-wins) | `ordinal` (must match if already set) |
| Settable at explicit creation | `tracked` | `ordinal` |
| Settable only via PATCH | -- | `tag` |
| Renameable via PATCH | yes | no |

Built-in mutable attributes sit beside the identity attribute rather than
inside `fields`. `tracked` is excluded from the match above: it is a
non-nullable policy flag that operators are expected to change, so
re-submitting it for an existing machine is never a mismatch. `ordinal` is
nullable and factual, so it matches like `fields` do -- set when unset,
rejected when it contradicts. `tag` is an editorial label applied after the
fact, which is why it is PATCH-only. See D5 for their columns and D11 for
ordinal assignment.

D3's typing rule covers these built-in attributes as well as the declared
metadata inside `fields`, on every write path: the JSON representation is the
only one accepted, so `"5"` and `true` are not an `ordinal` and `"true"` is not
a `tracked`, while a number with no fractional part is read as the integer it
is. An `ordinal` outside the range of its column (D5 makes it an `INTEGER`) is
likewise rejected with 400 rather than left to fail in the database, which would
be a 500 for a value the caller supplied.

Run metadata is deliberately not covered here: `run_parameters` is written once
at submission and never updated, so there is no reconciliation to specify.


## D8: No Regression Auto-Detection

All Regressions and their indicators are created, updated, and deleted via the
API. There is no auto-detection in LNT v5 -- it provides CRUD only.

Regression detection is the responsibility of an external process (a separate
tool or AI agent) that analyzes time-series data and creates Regressions via
the API when it detects significant changes.


## D9: Search

List endpoints for commits, machines, tests, runs, and regressions support a
unified `?search=` parameter.

- `GET /api/suites/{testsuite}/commits?search=abc` matches `commit` column, `tag` column, OR any
  `searchable` commit_field via case-insensitive substring matching (OR
  semantics).
- `GET /api/suites/{testsuite}/machines?search=x86` matches `name` column OR any `searchable`
  machine_field via case-insensitive substring matching (OR semantics).
- `GET /api/suites/{testsuite}/tests?search=bench` matches the `name` column via case-insensitive
  substring matching.
- `GET /api/suites/{testsuite}/runs?search=x86` matches the run's associated machine's
  `name` column OR any searchable machine_field via case-insensitive substring
  matching (OR semantics) -- the same predicate as the Machines `search=`
  above, applied through the run's machine.
- `GET /api/suites/{testsuite}/regressions?search=slowdown` matches the `title`
  column via case-insensitive substring matching.

Server-side `search=` always performs plain substring matching, with no
wildcards: `%` and `_` are ordinary characters in a term, so `?search=100%`
finds the rows containing `100%` rather than every row. It does not interpret
the client's `re:` regex-mode convention (see client
architecture.md) -- that convention is a client-side-only affordance for text
filters that operate over data already loaded in the browser, not for any
`search=` value sent to the API.


## D10: Time-Series Queries

The primary query pattern is: "give me metric values for (machine, test, metric)
ordered by commit ordinal."

This is `Sample JOIN Run JOIN Commit` filtered by `machine_id` and `test_id`,
ordered by `Commit.ordinal`.

When sorting by ordinal, commits without ordinals are excluded (they have no
meaningful position). When not sorting by ordinal, all runs are included
regardless of their commit's ordinal.

Cursor-based pagination requires a deterministic, non-repeating row ordering.
The server appends an internal unique tiebreaker to the caller's sort
specification to guarantee this. The tiebreaker is opaque to clients; cursors
are treated as opaque tokens. When no sort parameter is provided, results are
returned in an arbitrary but deterministic order suitable for pagination, and
no data is excluded.

A cursor names a *position* in that ordering -- the sort key values of the last
row served -- rather than the row it was produced from. A resumption therefore
stays correct when that row is deleted before the next request arrives, which an
implementation storing the row's identity and re-reading its sort values could
not manage. Pagination is forward-only (R2), so a row inserted before the
position a cursor names is not served and one inserted after it is; no row whose
sort values stay put for the length of the traversal is ever skipped or served
twice. A row whose sort values *change* mid-traversal can be, and no cursor
scheme prevents it: reassigning an ordinal (D11) while a client is paging by
ordinal can move a commit from behind the cursor to ahead of it, and the client
sees it twice.

A sort key must be a value no matching row can be missing, either because it is
never null or because the endpoint excludes the rows where it is -- as sorting
by ordinal does. A null compares as unknown against a cursor's value, so a row
carrying one would fall on neither side of the position and vanish from every
page.


## D11: Ordinal Management

- Ordinals can be set on three paths: inline as `commit.ordinal` during run
  submission, at creation via `POST /api/suites/{testsuite}/commits`, or
  assigned/updated at any time via `PATCH /api/suites/{testsuite}/commits/{value}`.
- Inline submission sets the ordinal when the commit has none, and is rejected
  with 409 when the commit already has a different one. `PATCH` is the only way
  to change an ordinal once set.
- A commit whose ordinal is never set on any of those paths stays `NULL`, which
  means unordered.
- Even numeric commit strings (e.g., `"311066"`) do not auto-assign ordinals
  -- an ordinal must be explicitly provided via one of the three paths above.
- The unique constraint on ordinal is a regular (non-deferred) constraint.
  Ordinals are assigned once and are not expected to be commonly reassigned. A
  write that would give two different commits the same ordinal is rejected with
  409, including when it arrives inline with a run submission.
- `previous` and `next` navigation on a commit is computed by querying for
  the nearest lower/higher ordinal (not a linked list).


## D12: Profile Submission and Storage

Profiles are submitted inline as part of run submission. Each test entry in
the submission JSON may include a `"profile"` field containing base64-encoded
profile binary data.

On submission:
1. The `profile` field is recognized as a reserved key (not a metric) and
   excluded from metric name validation.
2. The base64 data is decoded to raw bytes. ASCII whitespace is insignificant
   and is removed first -- the `base64` command-line tool wraps at 76 columns by
   default, as does every MIME encoder, and a wrapped profile is a perfectly
   ordinary thing for a producer to send. What is left is then decoded strictly:
   the standard alphabet, correctly padded, and everything outside the alphabet
   an error rather than something discarded. Both halves matter, and the second
   is the point of the first being spelled out as *whitespace* rather than as
   "skip what does not fit": a lenient decoder that drops every unrecognized
   character turns a payload which is not base64 at all into whatever happened to
   survive. Invalid base64 is rejected with 400.
3. The decoded blob is capped at 50 MB -- 52,428,800 bytes, see D5; a larger one
   is rejected with 400. This caps one profile, not the request carrying it: an
   oversized request *body* is refused at the transport layer with 413 (see R4),
   and one submission may legitimately carry many profiles. An implementation may
   refuse an over-long *encoded* string before decoding it, since base64 spends
   four characters on every three bytes, but must measure it after removing the
   whitespace of step 2 -- line breaks are not payload, and a cap applied to them
   would refuse a wrapped profile for a size it does not have.
4. The format version byte is validated (must be 2). Invalid format is
   rejected with 400, and so is an empty blob, which is the degenerate case of
   the same check: it carries no version byte to validate. Nothing beyond that
   first byte is parsed at submission time: the binary format has a reader of its
   own, and accepting a run must not depend on it.
5. A Profile row is created with `(run_id, test_id, created_at, data)`.
6. The unique constraint on `(run_id, test_id)` prevents duplicate profiles.
   Two test entries in one submission naming the same test are already rejected
   by D6, so this constraint only ever sees profiles from different submissions.

Profiles are read-only after creation -- there is no PATCH endpoint.
Deleting a run cascades to its profiles.

Profile data is stored as Postgres BYTEA. Postgres automatically applies
TOAST compression for large values. The blob is excluded from default query
results and is only loaded when a request explicitly needs it.

### The version 2 binary format

A profile is produced elsewhere and stored verbatim, so the format is not this
system's to choose; it is stated here because it is the one thing in v5 that
cannot be re-implemented from the rest of these documents.

A blob is built from exactly two primitives. An **integer** is ULEB128-encoded:
groups of seven bits, least significant group first, the high bit of every byte
but the last one set. A **string** is UTF-8 bytes terminated by a newline
(`0x0A`), which a string therefore cannot contain. Everything below is one or the
other -- including a **float**, which is stored as the integer whose value is the
number's IEEE-754 single-precision bit pattern read as an unsigned 32-bit
quantity.

A blob begins with the format version, as an integer. It is 2, which encodes as
the single byte `0x02` -- which is what step 4 above reads without parsing any
further.

Next comes the section table: eight headers in a fixed order, one per section,
each an offset and a size in bytes, both integers. **Offsets are relative to the
end of the table**, so the whole table has to be read before any of them can be
resolved, and once it has been, every section can be located without reading any
other. The TextPool header carries one field the others do not, after its size: a
string naming an external file that the pool lives in instead of this blob. The
mechanism was scaffolded and never implemented, so that name is empty in every
profile that exists, and a blob that names one holds text that is not in it and
cannot be read.

The eight sections are, in the order their headers appear (a reader must locate
each through the table rather than assume the bodies are laid out in that order
too, even though in practice they are):

1. **Header** -- one string: the disassembly format, for example `llvm-objdump`.
2. **CounterNamePool** -- a count, then that many strings. Every other section
   names a counter by its index into this list.
3. **TopLevelCounters** -- a count, then that many pairs of a counter index and
   an integer value. These are the profile's aggregate counters, and the only
   integer-valued counters it has.
4. **LineCounters** -- per-instruction counter values (see below).
5. **LineAddresses** -- per-instruction addresses (see below).
6. **LineText** -- per-instruction offsets into TextPool (see below).
7. **TextPool** -- a string pool: strings one after another, each addressed by
   its byte offset within the section. The first begins at offset zero, so zero
   is an ordinary offset like any other. (The reference implementation's comment
   claims a sentinel makes zero invalid; its own code overwrites the sentinel, and
   what it writes is what is described here.)
8. **Functions** -- a count, then that many entries. Each is the function's name,
   its instruction count, its starting offset within LineCounters, within
   LineAddresses and within LineText in that order, and then a count of the
   function's own counters followed by that many pairs of a counter index and a
   float value.

Sections 4 to 7 -- LineCounters, LineAddresses, LineText and TextPool -- are each
an independent bz2 stream; the other four are stored as written. That split is the
point of the whole layout: sections 1, 2, 3 and 8 are the index, so the
disassembly format, the top-level counters, and every function's name, aggregate
counters and instruction count are all readable **without decompressing
anything**. The read endpoints depend on it (see the endpoints spec): listing a
profile's functions costs no decompression, and only a request for one function's
disassembly pays for it.

The three per-instruction sections carry no counts or delimiters of their own.
Each is read from the function's own offset into it, for exactly as many
instructions as the function's index entry declares. **Those offsets, and
TextPool's, address the section's decompressed bytes**, not the compressed bytes
the section table locates -- the table says where a section's bz2 stream lives in
the blob, and every offset after that is an index into what the stream expands to:

- **LineCounters** holds one float per counter *of that function*, per
  instruction, in ascending order of counter name -- by Unicode code point, not by
  any locale's collation. A function measured with fewer counters than the pool
  holds therefore spends less per instruction than one measured with all of them,
  and nothing in the section says which counters those are: the order comes from
  the function's own counter list in the index. (The reference implementation's
  module docstring says there is one value per counter in the *pool*; its code
  writes one per counter of the function, and that is what is described here.)
- **LineAddresses** holds one integer per instruction, each the delta from the
  previous address. A function's addresses start from zero, so its first entry is
  the first address itself. Deltas are what makes the section compress: on a RISC
  target every one of them is the same number.
- **LineText** holds one integer per instruction: the byte offset within TextPool
  of that instruction's disassembly text. A zero follows each function's
  offsets, left over from a terminator the writer emits; a reader never sees it,
  since the index says how many instructions to read, but it is why a function's
  offset into this section is not simply the sum of the lengths before it.

### Reading a profile

An implementation must bound the memory that reading one profile can cost, along
two dimensions: the total expansion of the blob's compressed sections, and the
number of instructions a single function may claim.

Neither follows from D5's 50 MB cap on the stored blob. bz2 reaches ratios beyond
200,000:1 on data as repetitive as these sections hold, so a blob comfortably
inside the cap can still expand without limit, and one byte of address delta
expands into an instruction object hundreds of times its size. Nor can either be
caught earlier: step 4 above deliberately does not parse the body, so a blob that
cannot be read within these bounds is accepted, stored, and discovered only when
something reads it.

Exceeding either bound is reported exactly as corruption is, with `internal_error`
(500, see R4). From the read path a blob that expands without limit is not
distinguishable from one that is malformed, and neither is anything the caller did.

The bounds are stated as floors, so that an implementation may be more generous
than another without either being wrong: at least 320 MB of total expansion for
one profile, and at least 1,000,000 instructions in one function, must be
readable.

The expansion floor is set to dominate D5's store cap at the ratios these sections
reach on real data -- measured between roughly 3:1 and 6:1, since the counters are
floats and only the addresses are highly repetitive -- so that a well-formed
profile the server accepted is one it can still read. It cannot guarantee that,
and this is the one place where the two caps are genuinely independent: bz2's
ratio has no upper bound, so a sufficiently compressible blob will always be
acceptable at 50 MB stored and unreadable once expanded. Raising the floor further
only moves that line; it does not remove it. The consequence is worth stating
plainly, since a client cannot tell it from corruption: such a profile is accepted,
stored, and then permanently answered with `internal_error`.


## D13: Concurrent Submission

Run submission (`POST /api/suites/{testsuite}/runs`) is atomic from the API user's perspective: it
either fully succeeds (201) or fully fails with no partial side effects.

Machines, commits, and tests are created via a get-or-create pattern, so two
concurrent submissions naming the same entity race to create it. Whatever an
implementation does about that, it must provide these guarantees:

- **A lost identity race resolves to the winner's row.** The submission that
  loses the race for a machine, a commit, or a test name ends up using the row
  the winner created. It does not fail, and the client is never asked to retry.
- **Work done earlier in the same transaction survives.** Losing the race for a
  commit must not discard the machine the same submission created a moment
  earlier, nor any other row it has already written.
- **Every integrity failure that is not a lost identity race surfaces as
  itself.** A commit's INSERT can equally violate the unique constraint on
  `ordinal`, which is not a lost race at all: no re-read would find the commit,
  and the caller is owed `ordinal_conflict` (see D11 and R4) rather than a retry
  against a different problem.
- **Test-name resolution costs a fixed number of round trips.** However many
  names a submission carries, resolving them must not cost a statement per name,
  nor one per chunk of names.
- **Concurrent submissions cannot deadlock against each other.** A submission
  takes row locks on the machine it names, on the commit it names, and on each
  test name it creates, and two submissions touching the same rows must not each
  end up holding what the other is waiting for. An implementation must therefore
  acquire them in one order that every submission follows: the entities in a
  fixed sequence, and the names within the set in a fixed order. PostgreSQL
  breaks a cycle by killing one of the transactions, which would be a 500 on a
  request that did nothing wrong.
- **Stored metadata is never overwritten, including by a concurrent
  submission.** D7's rule is that a submitted value either fills in a NULL,
  matches what is stored, or is rejected. Two submissions can read the same NULL
  before either writes, so an implementation that decides what to fill from an
  unlocked read and then writes it has the second one overwriting a value it
  never compared against -- D7 holding usually rather than always. The
  reconciliation that decides a write must be the one made against the row as
  locked for that write.

The rest of this section is how PostgreSQL meets them.

The payload may be validated before any of this, outside the write transaction
and before it opens, and an implementation is encouraged to do so. Nothing in
reading a submission needs stored state (see D6), and a submission legitimately
carries tens of thousands of test entries and tens of megabytes of base64
profile: doing that work inside the transaction holds a database connection and
an open transaction -- which pins the vacuum horizon -- for the whole of it, for
no benefit. The cost is that the suite's schema is read twice, once to validate
against and again as the first statement of the write transaction, where D2 wants
the freshness check. A schema that changed between the two readings is answered
the same way any other stale read is, with D2's retryable 409, rather than
written against a schema that has since gone away.

Machines and commits are resolved one row at a time, with **savepoint-based
retry**:

1. The INSERT is wrapped in a Postgres SAVEPOINT.
2. On a violation of the entity's *identity* constraint -- the unique constraint
   on a machine's name or a commit's value -- only the savepoint is rolled back,
   so prior work in the same transaction (e.g., a machine created earlier) is
   preserved.
3. The row is re-read by its identity and the winner's row is returned. Only a
   row that was already there is then reconciled (see D7): one this transaction
   created itself holds exactly what was submitted.
4. If that reconciliation has nothing to fill in -- the common case, since a
   submission usually re-sends metadata the record already holds -- the entity is
   resolved and no lock is taken. If it does, the same columns are re-read `FOR
   UPDATE` and reconciled again, and it is the second reconciliation that
   decides. By the time the lock is granted, a competing submission has either
   committed, in which case its value is now the stored one and a submission
   disagreeing with it is the 409 D7 requires, or rolled back, in which case the
   column is still NULL and the fill is correct. Taking the lock only on the fill
   path is what keeps the ordinary submission lock-free.

The recovery is limited to the identity constraint, and any other integrity
failure raised by the same INSERT must surface rather than be absorbed, which is
what tells a taken `ordinal` apart from a lost race. Note that the unique
constraint on `ordinal` does not make step 4 unnecessary: it catches a
*different* commit holding the ordinal, not two submissions handing *this* commit
two different ones.

The machine is resolved before the commit, and both before the test names. That
sequence is what gives the deadlock guarantee above its fixed order for the
entity rows, and it is load-bearing rather than incidental: two submissions
naming the same machine and the same commit in opposite orders would each hold
what the other waits for.

Tests are resolved as a whole set rather than one at a time, in O(1) database
round trips regardless of how many names a submission carries. The set is
resolved by reading the names that already exist, inserting the remainder while
skipping the rows a concurrent transaction has already written, and re-reading
the skipped names, which is what picks up the winner's rows. An implementation
may pass the names as a single array parameter rather than one parameter each,
which is what keeps the round trip count fixed rather than bounded by Postgres's
parameter limit. The rows are inserted in a single agreed order -- ascending by
name -- so that two submitters whose test sets overlap cannot each hold the
speculative insertion lock the other is waiting for. A name still unresolved
after all that is a fault rather than a result, since nothing deletes a test
(see D5).

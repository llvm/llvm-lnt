# V5 — Work Items

## API Design & Consistency

### Samples

- [ ] Check whether `GET /runs/{uuid}/samples` should accept a metric
  filter parameter to reduce data transfer.
- [ ] Check whether filtering `GET /runs/{uuid}/samples` by test name
  would eliminate the need for the `/runs/{uuid}/tests/{name}/samples` endpoint.
- [ ] Check whether `/runs/{uuid}/samples` should become a top-level
  `/samples?run=UUID` endpoint.
- [ ] Understand whether the `/query` API can be folded into a top-level
  `/samples` endpoint for time-series data extraction.
- [ ] Check whether `before`/`after` should be renamed to
  `submitted_before`/`submitted_after`. Audit all time-filter parameters across
  the API for consistency (including `before_time`/`after_time` on `/trends`).

### Machines

- [ ] Allow searching machines by machine fields, not just name.
- [ ] Document supported sort orders on `/machines/{name}/runs`.
- [ ] Understand whether the machines list endpoint should use cursor pagination
  instead of offset pagination.
- [ ] Understand whether both `GET /machines/{name}/runs` and
  `GET /runs?machine=x` are needed, or if the `/runs` endpoint suffices.
- [ ] Add ordinal-based sorting to the machines endpoint. The Graph page
  currently passes an invalid sort parameter that is silently ignored; it should
  error instead.

### Tests

- [ ] Understand whether `GET /tests` should use `?search` instead of
  `?name_contains` and `?name_prefix`. Update Swagger UI accordingly.
- [ ] Understand whether `GET /tests/{name}` is useful or should be removed.

### Commits & Orders

- [ ] Understand commit deletion behavior: does it cascade to regressions?
  Revisit whether commits should be deletable now that they can be ordinal-free.
- [ ] Allow including an ordinal when making a data submission.
- [ ] Understand whether filtering `/commits` by machine and other properties
  would simplify baseline selection and other queries. Audit calls to `/tests`,
  `/machines`, and `/runs` for similar simplification opportunities.

### General

- [ ] Add count endpoints (or a count mode) for commits, runs, machines, etc.
- [ ] Audit sort orders across all API endpoints for consistency. For example,
  should `/machines/{name}/runs` allow sorting on commit order?
- [ ] Understand whether the regression detection tool would benefit from a
  richer time-series endpoint.

## UI — Compare Page

- [ ] Show a clickable link to the regression detail page after creating a
  regression (not just the UUID).
- [ ] Clear the title input after successfully creating a regression.
- [ ] Replace the `<details>` "Add to Regression" panel with a sticky floating
  button (bottom-right) that expands into a panel on click.
- [ ] Understand whether the Compare page should allow inputting an arbitrary
  local run.
- [ ] Understand how to surface tests with high vs. low confidence when multiple
  samples are present.

## UI — Graph Page

- [ ] Fix: regression annotations are not showing. The code exists
  (`buildRegressionOverlays`, `fetchAndApplyRegressionAnnotations`) but
  something prevents them from appearing.
- [ ] Fix: when adding new traces after selecting a baseline, the baselines for
  the newly-added traces are not added to the graph.
- [ ] Reconsider select-all checkbox behavior: when some tests are selected,
  clicking the top checkbox currently selects everything. Consider toggling to
  "unselect all" first, then "select all" on a second click.
- [ ] Ensure `display: short sha` has an easy way to be populated. Without it,
  the default Graph x-axis display is poor.
- [ ] Allow clicking inside the tooltip to enable clickable links (e.g. to the
  commit detail page).
- [ ] Allow plotting the geomean. Clicking a dashboard sparkline should navigate
  to a geomean graph.
- [ ] Allow toggling between revisions and dates on the x-axis. Note: commits
  may not always map to dates.

## UI — Graph / Compare Shared

- [ ] Experiment with placing the search bar just above the table rows instead
  of its current position.

## UI — General

- [ ] Fix: Machines list page search is broken
  (`Unknown query parameter(s): name_contains`). Audit other pages for similar
  issues (Runs detail also broken, returns empty results).
- [ ] Machine detail page: allow searching the run history by run UUID or by
  commit.
- [ ] Improve test suites sub-tab filters: first survey which filters exist
  today and what they filter on. Then move to fuzzy matching instead of prefix
  match. Consider infinite scrolling with filters applying to all results,
  not just the current page. NOTE: The `?search=` parameter already searches
  across commit, tag, and searchable commit_fields.

## Cleanup & Tech Debt

- [ ] Undo changes made to the v4 layer (e.g. new migrations).
- [ ] Reorganize `combobox.ts` and `machine-combobox.ts` — remnants of the
  Compare page being standalone. Either unify into a single combobox component
  or rename for clarity.

## Use Cases

- [ ] Look into Parquet integration for regression analysis.
- [ ] Investigate the production of a daily report.
- [ ] Look into providing an easier way to compare a run with the previous run.

## Performance

### P0 — Critical

- [ ] **Add pagination/limit to `POST /trends`** (impact: prevents unbounded
  queries). The trends endpoint returns ALL matching data points with no limit.
  The `EXP(AVG(LN(metric)))` geomean scans the entire Sample table — O(N) on
  100M+ rows. Without pagination, responses can contain tens of thousands of
  items and take 30+ seconds.

- [ ] **Gate `dump_response()` validation on debug mode** (impact: halves
  marshmallow serialization cost). `dump_response()` in `helpers.py` runs both
  `schema.dump()` and `schema.validate()` on every serialized item. The validate
  call re-parses the just-dumped output as a safety net. For the query endpoint
  at limit=10,000, this adds ~1–2 seconds of pure Python overhead. The validate
  step should be skipped in production.

### P1 — High

- [ ] **Remove `ordered = True` from BaseSchema.Meta** (impact: eliminates
  `OrderedDict` overhead across all schemas). All schemas inherit
  `ordered = True`, forcing marshmallow to use `OrderedDict` instead of plain
  `dict`. Since Python 3.7+ dicts maintain insertion order, this is unnecessary
  and adds 2–3x overhead on dict construction in tight serialization loops.

- [ ] **Add Cache-Control headers to immutable endpoints** (impact: eliminates
  repeat fetches entirely). No v5 API endpoint (except `/llms.txt`) sets
  Cache-Control headers. Immutable resources — run detail, test detail, test
  suite schemas — should have `Cache-Control: public, max-age=86400, immutable`.
  Slowly-changing resources (machines, commits) should have short-lived caching
  (60–300s).

- [ ] **Fix N+1 `run.commit_obj` in MachineRuns endpoint** (impact: eliminates
  up to 500 lazy-load queries per page). `GET /machines/{name}/runs`
  (`machines.py:275`) accesses `run.commit_obj.commit` in serialization without
  eager loading. Each run in the page triggers a separate SELECT. Fix: add
  `.options(joinedload(ts.Run.commit_obj))` to the query.

- [ ] **Replace regression list indicator subqueryload with SQL COUNT(DISTINCT)**
  (impact: avoids loading thousands of indicator objects). The regression list
  endpoint (`regressions.py:199`) uses `subqueryload(ts.Regression.indicators)`
  to load ALL indicator rows for every regression on the page, then iterates them
  in Python just to compute `machine_count` and `test_count`. A single SQL
  aggregation query would be dramatically more efficient.

- [ ] **Cache schema version check with TTL** (impact: eliminates 1 DB
  round-trip per request). `ensure_fresh()` (`middleware.py:60`) queries
  `v5_schema_version` on every single request. Schema changes are extremely rare
  (suite creation/deletion). A time-based cache (e.g., 5–10 seconds) would skip
  the query on most requests.

- [ ] **Use INSERT ON CONFLICT DO NOTHING for batch indicator addition** (impact:
  avoids O(existing_count) Python-side dedup). `add_regression_indicators_batch`
  (`__init__.py:1162`) loads ALL existing indicators for a regression into Python
  to build a dedup set before inserting new ones. PostgreSQL's
  `INSERT ... ON CONFLICT (regression_id, machine_id, test_id, metric) DO NOTHING`
  eliminates this entirely.

- [ ] **Raise max commit page size and audit client-side limits** (impact: fewer
  requests for full enumeration). The server hard cap is 500 items per page
  (`pagination.py:60`); iterating 21K commits requires 44+ requests. The Graph
  and Compare page commit pickers also request only 500. Raise the server max to
  5,000–10,000 for bulk consumers and audit client-side page size choices.

### P2 — Medium

- [ ] **Cache API key lookups in-process with short TTL** (impact: eliminates
  1 DB round-trip per authenticated request). Every authenticated request hashes
  the bearer token and queries the `api_key` table. An in-process LRU cache
  keyed on `key_hash` with a short TTL (e.g., 60 seconds) would avoid the
  query on most requests. Caveat: revoked keys remain valid for up to TTL
  seconds.

- [ ] **Replace ORM `session.delete()` with bulk SQL DELETE for machines/runs**
  (impact: prevents potential OOM on large cascades). `delete_machine`
  (`__init__.py:628`) uses `session.delete(machine)` which can cascade through
  10K runs × 7,500 samples = 75M rows. While `passive_deletes=True` should
  prevent loading, it is fragile. A direct
  `session.query(ts.Machine).filter(...).delete()` or raw SQL DELETE is safer
  and faster.

- [ ] **Use EXISTS subquery instead of JOIN+DISTINCT for regression indicator
  filters** (impact: more efficient semi-join for large indicator tables). The
  regression list endpoint (`regressions.py:239`) uses JOIN + DISTINCT when
  filtering by machine/test/metric. An EXISTS subquery avoids producing large
  intermediate result sets and is better optimized by PostgreSQL.

- [ ] **Use `schema.dump(many=True)` for batch serialization** (impact: ~5–10x
  faster serialization for large result sets). List endpoints and the query
  endpoint call `dump_response()` per-item in a loop. Marshmallow's
  `dump(many=True)` amortizes schema introspection and field setup across
  all items.

- [ ] **Compute ETag from response body bytes, not re-serialization** (impact:
  eliminates double JSON serialization on detail endpoints). `compute_etag()`
  (`etag.py:13`) calls `json.dumps(data, sort_keys=True)` to hash the response,
  but `jsonify()` also serializes the same data. Computing the ETag from
  `response.get_data()` instead eliminates one full JSON serialization.

- [ ] **Investigate database size and performance of data submissions**. Using
  lnt-scrape reveals very slow submission times. Profile and identify
  bottlenecks.

### P3 — Low / Polish

- [ ] **Eliminate double existence check in `POST /commits`**: The endpoint
  (`commits.py:193`) calls `ts.get_commit()` to check for existence, then
  `ts.get_or_create_commit()` does its own existence check. Remove the redundant
  first check.

- [ ] **Eliminate redundant flush calls in PATCH commits path**: `update_commit`
  (`__init__.py:437`) flushes after every call. When both ordinal and
  commit_fields are updated, there are 3 flushes per request. Defer flushing
  to the endpoint level.

- [ ] **Add max batch size to `POST /commits/resolve` schema**: The
  `CommitResolveRequestSchema` has no max length validation on the `commits`
  list. A client can send 21K+ values in one request. Add
  `validate=Length(min=1, max=5000)`.

- [ ] **Remove dead `getFieldChanges()` from frontend `api.ts`**: The function
  (`api.ts:295`) is exported but never imported or called anywhere in the
  frontend source. Dead code.

- [ ] **Add `title_contains` filter to regressions endpoint**: The Compare page
  "Add to Existing Regression" search fetches only 50 regressions and filters
  client-side. With 50+ regressions, results are incomplete. A server-side
  title filter would fix this.

- [ ] **Only set full CORS headers on OPTIONS preflight responses**: Currently
  all 5 CORS headers are set on every response (`middleware.py:91`). Only
  `Access-Control-Allow-Origin` and `Access-Control-Expose-Headers` are needed
  on non-preflight responses. Saves ~200 bytes of header per response.

## Profiles

- [ ] **CFG view**: Control-flow graph renderer (D3-based, ISA-specific).
  Deferred to a future phase.
- [ ] **Replace N+1 profile-existence check in commit picker**: The Profiles
  page commit dropdown calls `GET /runs/{uuid}/profiles` for every run on the
  selected machine to filter commits without profiles. Replace with a
  server-side mechanism (e.g. `has_profiles` flag on run list responses or a
  filtered commits endpoint).

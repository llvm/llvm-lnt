# V5 Performance Improvements

Identified during a comprehensive API performance audit on 2026-04-20.

## P0 — Critical

- [ ] **Add `(test_id, run_id)` compound index on Sample table** (impact: 100–1000x
  for time-series queries). The existing `(run_id, test_id)` compound index has
  columns in the wrong order for the dominant access pattern. Time-series queries
  (`query_time_series`, `/query`, `/trends`, `GET /tests?machine=`) filter by
  `test_id` first, but the index leads with `run_id`. At 100M+ rows, these
  queries fall back to sequential scans.

- [ ] **Batch test get-or-create in run submission** (impact: ~1000x fewer DB
  round-trips per submission). `get_or_create_test` is called per-test in a loop
  (`__init__.py:1295`), issuing one SELECT + optional SAVEPOINT/INSERT/FLUSH per
  test. For a 7,500-test submission, this is 7,500–30,000 round-trips. Replace
  with `SELECT ... WHERE name IN (...)` + `INSERT ... ON CONFLICT DO NOTHING` to
  reduce to ~3 round-trips.

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

- [ ] **Add response compression** (impact: 80–90% bandwidth reduction).
  No gzip/brotli middleware is configured. All JSON responses are sent
  uncompressed. A 3 MB query response could be ~450 KB with gzip. Add
  `flask-compress` or document that a reverse proxy must handle compression.

## P1 — High

- [ ] **Use Core INSERT for samples instead of ORM objects** (impact: 3–10x
  speedup on sample insertion). `create_samples` (`__init__.py:813`) creates
  7,500 ORM objects via `add_all()`. SQLAlchemy 1.3 emits individual INSERT
  statements. Using `session.execute(Sample.__table__.insert(), list_of_dicts)`
  with psycopg2's `executemany` batches thousands of rows into a handful of
  round-trips.

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

- [ ] **Raise max commit page size for bulk consumers** (impact: fewer requests
  for full enumeration). The hard cap of 500 items per page
  (`pagination.py:60`) means iterating 21K commits requires 44+ requests.
  Raising the max to 5,000–10,000 for bulk consumers (or adding a streaming
  endpoint) would reduce this significantly.

## P2 — Medium

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

## P3 — Low / Polish

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

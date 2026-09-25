# v5 REST API: Infrastructure

This document covers the framework, URL structure, pagination, filtering,
response format, and authentication for the v5 REST API.

API documentation is generated using the OpenAPI 3.x format, and served
alongside an interactive viewer (see R8).


## R1: URL Structure and Identifiers

- Base path: `/api/suites/{testsuite}/`
- No path carries a trailing slash. A request that adds one is answered with a
  307 redirect to the canonical form; 307 rather than 301 or 308 so that the
  method and body survive and a misspelled write is not downgraded to a GET.
  This covers `/healthz` as well. Client routes are unaffected -- the web UI
  answers both spellings itself, and redirecting between them would be noise.
- Entities addressed by natural keys (suite name, machine name, test name, commit value) or
  UUIDs (runs, regressions, regression indicators, profiles) -- never by internal
  auto-increment database IDs. API keys are the one exception to both: they are addressed by
  their `prefix`, which is neither a natural key nor a UUID (see R5). Run UUIDs may be
  client-provided or server-generated; all other UUIDs are server-generated.
- An entity carries its own identifier in responses under the key it is addressed by: `name`
  (suite, machine, test), `value` (commit), `uuid`, `prefix`. R4 covers how one entity refers
  to another.
- A natural key that appears in a path has to survive being one segment of it. A server decodes
  `%2F` back to a path separator before routing, and normalizes `.` and `..` away, so a key
  containing `/`, or equal to `.` or `..`, would name an entity that no URL can reach -- and the
  `Location` header handed back at creation would answer 404. A machine name or a commit value
  that is not addressable in this sense is therefore rejected with 400 wherever the entity is
  created, including implicit creation during run submission (see D6), rather than accepted and
  then unreachable. Suite names are already narrower than this by D4's pattern.
- Test names are the exception, and the API addresses them differently because of it. They
  legitimately contain `/` (`test.suite/benchmark`), and tests are created implicitly by run
  submission, so there is no endpoint that could refuse an unaddressable one and no rule to apply.
  **No path therefore carries a test name.** A request that names a test does so in a `test=` query
  parameter, or in a request body where one is already being sent; in both, `/` is an ordinary
  character and nothing splits or normalizes it. Percent-encoding does not rescue the path form for
  a key containing `/` -- `%2F` is decoded back to a separator before routing, so
  `/runs/{uuid}/tests/test.suite%2Fbenchmark/samples` reaches no route at all. It does work for
  every other character a path segment would otherwise mangle.
- A profile's function name can contain `/` too -- the name is whatever the profile's producer
  recorded, and a producer that demangles records an `operator/` overload with one in it -- and is
  nevertheless a path segment. What makes that work, and what was not available to a test name, is
  position: the function name is the *last* segment of its path, so it is specified as spanning the
  remainder of the URL and nothing follows it for a `/` to collide with. A test name would have had
  to sit mid-path (`/tests/{name}/samples`), where no such reading exists. Within such a segment `/`
  and `%2F` are interchangeable, since the server decodes before routing and the segment captures
  the result either way. Two residual names are unreachable regardless: one ending in `/`, which
  trailing-slash normalization strips, and one containing a `.` or `..` segment, which is reachable
  only percent-encoded and only from a client that does not normalize. Unlike a machine name, a
  function name cannot be refused at creation -- it arrives inside a blob the server stores
  verbatim -- so this is accepted rather than validated away. No symbol a compiler emits hits it.
- An index endpoint at `GET /api` links to the test suite list and the API documentation
- Suite-scoped resources live one level below the suite collection, under
  `/api/suites/{testsuite}/`. This keeps them disjoint from instance-level
  routes (`/api/suites`, `/api/admin/...`), so routing reserves no suite names
  at all -- a suite may legally be named `admin` or even `suites`. A few names
  are nevertheless rejected at creation, for a reason that has nothing to do
  with routing; see D4.


## R2: Pagination

Every list endpoint returns a JSON object carrying its results under `items`,
never a bare array. Cursor-paginated lists add a `cursor`:
`{"items": [...], "cursor": {"next": "...", "previous": null}}`.
Offset-paginated lists add a `total`: `{"items": [...], "total": N}`.
Unpaginated lists carry `items` alone. The endpoints spec is authoritative for
which endpoint uses which; this section says what each envelope means.

`items` is present and empty rather than absent when nothing matches. Wrapping
even the unpaginated lists is what lets one of them grow a cursor later without
breaking clients.

The rule governs a list endpoint's top-level body. An array that is a *field* of
some larger response keeps its own name -- a regression's `indicators`, a
function's `instructions` -- as does a body that is not a list at all, such as
`POST /commits/resolve`'s lookup table keyed by commit string.

Cursor pagination is forward-only: `previous` is always `null` (reserved for
future backward pagination) and clients must not rely on it. Cursors are opaque
strings that clients must not parse. A client asks for the page after the one it
holds by passing `cursor.next` back under the name `cursor`, alongside the same
filters and `sort` that produced it. A list asked for with a query string takes
it as the `cursor=` query parameter; a list asked for with a request body takes
it as that body's `cursor` key, and `limit` travels the same way. The endpoints
spec says which list is which, and the choice is about where a list's filters
fit rather than about its paging: the token is the same opaque string under the
same rules, and every sentence here applies to both carriers unchanged. A cursor
that
is malformed, or that was issued for a different *ordering* -- another list's
rows, or the same list's in the other direction -- is rejected with 400 rather
than quietly answered with a page of the wrong rows. Resending the filters is the
client's part of the bargain and is deliberately not checked: a cursor names a
position in an order, and two requests differing only by a filter share that
order, so a cursor handed to the wrong one of them still names a real position
rather than a wrong page. Opacity is a contract on the client rather than a
cryptographic guarantee: a cursor need not be unforgeable, because it can only
name a position in a query its holder could have asked for anyway.

Offset pagination takes `offset` (default `0`) alongside `limit`. `total` is the
number of items matching the request's filters, ignoring `limit` and `offset`,
so that a client can render "1-25 of 240". Only bounded lists are
offset-paginated: an exact `total` costs a scan of everything matching, so
unbounded lists use a cursor and carry no `total`.

Default page size is 25, with a configurable `limit` parameter (max `10 000`) on
paginated lists. `limit` is at least 1: an endpoint has no reason to serve a page
of nothing, and an offset-paginated list's `total` is available from any page.


## R3: Filtering and Sorting

- Named query parameters per endpoint, documented in OpenAPI spec
- Supported filter types per endpoint (examples):
  - `machine=`, `test=`, `metric=`, `search=` (case-insensitive substring; see D9)
  - `after=`, `before=` (submission-time range; exclusive). This is the generic
    convention for endpoints that only need to filter on one time dimension
    (currently `GET /api/suites/{testsuite}/runs` and
    `GET /api/suites/{testsuite}/machines/{name}/runs`, both filtering
    `submitted_at`). The `/api/suites/{testsuite}/query` time-series endpoint needs
    both a commit-ordinal range and a submission-time range simultaneously, so
    it uses the more specific
    `after_commit`/`before_commit`/`after_time`/`before_time` instead (see the
    endpoints spec). `GET /api/suites/{testsuite}/commits`, `GET /api/suites/{testsuite}/regressions`,
    `GET /api/suites/{testsuite}/tests`, and `POST /api/suites/{testsuite}/trends` do not
    support time-range filtering.
  - `state=` (for regressions, supports multiple values via a comma-separated
    list: `?state=active,detected`)
  - `commit=`, `has_commit=` (for regressions), `has_profiles=` (for commits and runs)
  - `tracked=` (boolean, for machines; omitted returns both)
  - `sort=<field>` (prefix with `-` for descending: `sort=-submitted_at`)
- Exact filters and available sort fields defined per endpoint in the OpenAPI spec
- Filtering by a nonexistent entity name (`machine=`, `test=`) returns 404. Filtering by an unknown metric returns 400. Filtering by a commit value that doesn't exist (`commit=`) returns an empty result set, not 404.


## R4: Response Format

All REST API responses are JSON. A list endpoint returns one of the envelopes in
R2; every other endpoint returns the entity object itself, except where its own
spec gives a different body. Status codes are drawn from 200, 201, 204, 400,
401, 403, 404, 409, 500. The four routes exempt from the scope system (see R5)
are not part of this surface and follow their own sections: they serve plain
text or HTML as well as JSON. Two things are settled before a request reaches an
endpoint at all, and are likewise outside this surface: an oversized request
body, which is refused (see Errors, below), and a trailing slash, which is
redirected (see R1).

**Object conventions.** These hold for every response body, so each endpoint's
spec need only name its keys.

- A reference to another entity carries that entity's identifier (see R1) under
  a key named after the entity -- `machine`, `commit`, `test` -- rather than a
  nested object, so that an item stays flat and a page of them stays small. When
  the identifier is a UUID the key says so: `run_uuid`. Two cases nest or
  denormalize instead, and say so where they are specified: a commit's
  `previous`/`next` neighbours, and time-series points and trend items, which
  carry the referenced commit's `ordinal` and `tag` because a client cannot
  place a point without them.
- Schema-declared data always sits in a nested dict of its own -- `fields` on
  machines and commits, `metrics` on samples -- and is never flattened onto the
  entity.
- A `fields` dict carries every field the suite's schema declares, with `null`
  where the entity has no value, so that a client rendering one column per
  declared field does not have to discover which keys a given row happens to
  carry. A sample's `metrics` is the deliberate exception and says so where it is
  specified: a suite's metric list is long and sparsely populated, whereas a suite
  declares few machine and commit fields.
- Values inside `fields` and `metrics` use the JSON representation of their
  declared type (see D3) and are never stringified. Built-in timestamps follow
  the same convention (see D5).
- Unless specified otherwise, a key an endpoint documents is always present, and
  `null` when it has no value.

**Errors** all use one envelope:

`{"error": {"code": "not_found", "message": "Machine 'foo' not found in test suite 'nts'"}}`

`code` is machine-readable and stable; `message` is for humans and may be reworded at any
time, so clients must branch on `code` alone and never parse `message`.

| Code | Status | Meaning |
|------|--------|---------|
| `invalid_request` | 400 | Malformed or invalid request: bad syntax, an unreadable `Authorization` header (see R5), a failed validation, an undeclared `fields` key, an unknown metric name, a missing `?confirm=true` |
| `unauthorized` | 401 | A credential was required and none was usable (see R5) |
| `forbidden` | 403 | Valid token, insufficient scope (see R5) |
| `not_found` | 404 | An entity named by the path, by a `machine=`/`test=` filter, or by the request body does not exist. A *commit filter* naming an unknown commit is not an error, whether it is spelled as a query parameter or as a key of a request body (see R3); a commit named as an ordinal range bound is, because it names a position rather than a set of rows |
| `duplicate` | 409 | The entity already exists: a run UUID, a suite name, a schema entry added twice |
| `ordinal_conflict` | 409 | The ordinal is already held by another commit, or contradicts the one this commit has (see D11) |
| `in_use` | 409 | Another entity references this one and must be removed first: a commit referenced by a regression |
| `conflict` | 409 | The request contradicts existing state in a way the more specific 409 codes do not describe, or could not complete because the suite's schema changed underneath it (see D2) |
| `internal_error` | 500 | The server failed to answer, including when a stored profile blob cannot be deserialized |

409 carries more than one code because its cases call for different client behaviour: a
submitting bot retries a `duplicate` run UUID with a fresh one, whereas an `ordinal_conflict`
means its view of the commit order is wrong and retrying cannot help.

**Oversized request bodies** are rejected but do not have to use the envelope: they can be rejected
at the transport layer instead. However, they must be rejected with `413`. This is a property of the
deployment rather than of any endpoint, so no endpoint documents it.


## R5: Authentication and Authorization

**Scopes**. Every endpoint under `/api/` declares the scope it requires. The
scopes form a strict hierarchy -- `read` < `submit` < `triage` < `manage` <
`admin` -- and a key grants its own scope plus every lower one, so an `admin`
key can do everything a `read` key can.

- **read** -- read-only access to test suites and everything in them. Covers
  most GET endpoints, plus the read-only POST endpoints like `commits/resolve`
  and others.
- **submit** -- submit runs (`POST /api/suites/{testsuite}/runs`), create commits (`POST /api/suites/{testsuite}/commits`)
- **triage** -- create/update/delete regressions, manage regression indicators
- **manage** -- create/update/delete machines; update/delete commits; delete
  runs; create/delete test suites and change their schemas
- **admin** -- list, create, and revoke API keys

The HTTP method implies nothing about the required scope in either direction:
some POST endpoints are `read`-scoped, and the API key endpoints require
`admin` even for GET. The per-endpoint `Auth scope` lines in the endpoints spec
are authoritative for which endpoint needs which; the list above says what each
scope means.

**Unauthenticated access**. `read`-scoped endpoints allow unauthenticated
access. Endpoints requiring any higher scope require a valid Bearer token.

Four routes fall outside this section altogether, because they are documentation
and infrastructure probes rather than part of the REST API surface: `GET
/llms.txt` (R6), `GET /healthz` (R7), `GET /api/openapi.json` (R8), and the
documentation viewer at `GET /api/docs` (R8). None of them participates in the
scope system and none returns the R4 error envelope, so no authentication
happens on their path and an `Authorization` header has no effect on them -- not
even a malformed or revoked one, which anywhere else under `/api/` would be a
400 or a 401.

The exemption is an explicit list rather than a consequence of living outside
`/api/`, since two of the four live under it. For `/healthz` it is deliberate
beyond mere tidiness: its contract is 200 for healthy and 500 for "cannot reach
the database", so letting a stale token turn it into a 401 would report a working
server as unhealthy. For the two documentation routes it keeps a caller holding a
bad token from being locked out of the very document that explains how to
authenticate.

**Presenting a token**. Credentials are sent as `Authorization: Bearer <token>`;
the scheme name is matched case-insensitively, per RFC 9110.

- No `Authorization` header: allowed on `read`-scoped endpoints, 401 on any
  endpoint requiring a higher scope.
- Header present but not parseable as a Bearer credential -- unreadable syntax,
  or a scheme other than `Bearer`: **400**, matching RFC 6750's
  `invalid_request`. This is a malformed request rather than a rejected
  credential, and it is deliberately not treated as an absent header: falling
  through to anonymous access would silently ignore a credential the caller
  believes it sent.
- Well-formed Bearer credential carrying a token that is malformed, unknown, or
  belongs to a revoked key: **401** on every endpoint under `/api/` --
  including `read`-scoped ones that would have allowed anonymous access. This
  matches RFC 6750's `invalid_token`, which covers malformed tokens as well as
  revoked ones. A bad credential is never silently downgraded to anonymous
  access, which would otherwise turn a broken or revoked token into results the
  caller misreads as authoritative.
- Valid token whose scope is insufficient for the endpoint: **403**, matching
  RFC 6750's `insufficient_scope`.

A 401 carries a `WWW-Authenticate: Bearer` header. All three responses use the
R4 error envelope, with `code` set to `invalid_request`, `unauthorized` and
`forbidden` respectively.

**Order of checks**. Authentication precedes authorization, which precedes
resolving the addressed resource. An insufficiently-scoped request therefore
gets 403 whether or not the resource it names exists -- resolving first and
answering 404 would let an unauthorized caller enumerate which resources do.
This matters for the API keys, the only resources whose existence is not
already public; the rule is stated uniformly rather than per endpoint so that
there is one order to implement and to reason about.

**Authorization is not cached**. Every authenticated request resolves its token
against the database, so revoking a key takes effect immediately rather than
after some window. The lookup is a single indexed match on a table holding one
row per key, small enough to stay resident in memory; that cost is not worth
trading for delayed revocation.

**Tokens**. A token is generated by the server from a cryptographically secure
random source and is exactly 64 lowercase hexadecimal characters (256 bits).
The stored `key_hash` is the lowercase hex SHA-256 of the token's ASCII bytes,
and `prefix` is the token's first 8 characters (see D5). A token is returned
exactly once, by the operation that creates it, and cannot be recovered
afterwards: neither the raw token nor `key_hash` appears in any other response.

A single SHA-256 is used deliberately, rather than a password-style KDF
(bcrypt, scrypt, argon2). A KDF exists to make guessing a *low-entropy* secret
expensive, whereas these tokens are server-generated with 256 bits of entropy
-- 224 of which remain secret, since the 8-character prefix is published --
putting them far out of guessing range. Deliberately slow hashing would instead
let any unauthenticated caller burn server CPU by presenting a garbage token.

**Bootstrap and out-of-band key creation**. Every key-management endpoint
requires `admin` scope, so the API alone cannot produce an instance's first
key: a newly initialized database holds no keys at all, and an operator who
revokes the last active `admin` key has no way to create a replacement.

An instance therefore provides an out-of-band administrative interface for
creating keys, for example a command-line tool that can be used from the
instance. The exact mechanism is implementation-specific.


## R6: AI Agent Orientation

- Serve a plain-text orientation document at `GET /llms.txt` (following the
  llms.txt convention, analogous to robots.txt)
- Content: what LNT is, key domain concepts, API structure, common workflows,
  and links to `/api/docs` and `/api/openapi.json` (see R8)
- Static content, outside the REST API surface: always public, and an
  `Authorization` header has no effect on it (see R5)
- Served as `text/plain` with UTF-8 charset


## R7: Health Check

- `GET /healthz` reports whether the server is able to serve traffic. It
  verifies database connectivity by issuing a trivial query, so a 200 means the
  process is up *and* can reach Postgres.
- Returns `200 {"ok": true}` on success, `500 {"ok": false}` if the database
  cannot be reached.
- No authentication, always public; an `Authorization` header has no effect
  (see R5).
- Deliberately outside `/api/`, and deliberately not using the R4 error
  envelope: this is an infrastructure probe rather than part of the REST API
  surface.


## R8: API Documentation

- `GET /api/openapi.json` serves the OpenAPI 3.x specification describing this
  instance's API, as `application/json`. Its `info.title` is `LNT v5` and its
  `info.version` is `5` -- the version of the API, which is fixed for the
  lifetime of v5, and not of the server build serving it.
- The specification describes only responses the API can actually produce. In
  particular it must not advertise a status outside the set R4 permits: a
  generator that documents its framework's native validation failure (commonly
  422) has to be corrected to the 400 the error envelope specifies.
- `GET /api/docs` serves an interactive documentation viewer rendering that
  specification, as `text/html`.
- How the viewer obtains its own scripts and stylesheets is left to the
  implementation, which may load them from a third-party CDN rather than
  serving them from this instance (in which case the API viewer may only be
  available when the instance is online).
- Both are linked from the API index (`GET /api`) under the `openapi` and
  `docs` keys, and from `/llms.txt` (R6).
- Neither requires authentication, and an `Authorization` header has no effect
  on either, even though both live under `/api/` (see R5).
- The viewer is named for what it is rather than for what renders it. Swapping
  the viewer implementation must not change the URL, so the path deliberately
  does not name a particular tool.

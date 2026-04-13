# Design Discussion: Rethinking Orders and Identifiers

This document captures the design discussion about decoupling run identity from
ordering in LNT, and introducing richer commit metadata on orders.

## Problem Statement

Most LNT test suites define orders as a git distance (an integer). While
functionally correct for sorting, this is not very helpful when trying to make
sense of what an order actually represents. We want to:

1. Store meaningful commit information (Git SHA, author, message) alongside
   orders.
2. Support one-off A/B comparisons without cluttering the order space.
3. Cleanly separate the concepts of "identity" (what groups runs together)
   from "ordering" (sequential position for time-series analysis).

## Current Architecture

### Order Table

Each test suite has a per-suite Order table with:
- `ID` (Integer PK)
- `NextOrder` / `PreviousOrder` (Integer FKs forming a linked list) -- in
  production
- `ordinal` (Integer) -- introduced on the v5 branch but not yet in production
- Dynamic `String(256)` columns for each order field (e.g.,
  `llvm_project_revision`)

### Schema Definition

Orders are defined by marking a run field with `order: true` in the YAML
schema:

```yaml
run_fields:
- name: llvm_project_revision
  order: true
```

There is no type control (always `String(256)`), no metadata concept, and no
way to separate the sort key from the display label.

### Ordering Mechanism

`_getOrCreateOrder()` determines an order's position at insertion time by
comparing field values via `convert_revision()`, which parses strings into
numeric tuples. Non-numeric strings (like Git SHAs) get hashed, producing
essentially random ordering. The order field value serves a dual purpose: it is
both the identity (used for lookups and display) and the sort key.

### Dual-Purpose Problem

This conflation means:
- You can't store a monotonic sort key (git distance) while displaying a
  human-meaningful identifier (SHA).
- Every run must have an order, even throwaway A/B comparisons.
- The system must understand the format of the order value to sort it
  (`convert_revision()`).

## Exploration of Approaches

### Approach A: Add a `parameters_data` Blob to Order

Like Machine and Run already have. An external process or PATCH call populates
it with arbitrary JSON (SHA, author, message). Submitters stay unchanged.

**Verdict**: Simple but doesn't address the display concern or the A/B
comparison problem.

### Approach B: New `order_fields` Section in the Schema

A dedicated `order_fields` section defines additional typed columns on the Order
table:

```yaml
run_fields:
- name: llvm_project_revision
  order: true                    # sort key (unchanged)

order_fields:                     # NEW
- name: git_sha
  display: true                  # UI shows this instead of sort key
- name: commit_message
  type: text                     # Text column for large strings
```

Order metadata fields are populated via PATCH only, not by run submissions. One
field can be marked `display: true` for the UI.

**Verdict**: Addresses display and metadata, but doesn't address A/B
comparisons or the fundamental coupling between identity and ordering.

### Approach C: Runs Submit SHA, External Process Assigns Ordinal

Flip the model: submitters send what's natural (a Git SHA) as the order field.
The Order is created with no position (`ordinal = NULL`). An external process
later assigns the ordinal.

**Verdict**: Clean separation, but doesn't address metadata or the A/B
comparison problem on its own.

### Key Insight: `ordinal` Hasn't Shipped

The `ordinal` column is a v5 branch addition, not in production. This means we
can design it from scratch to be nullable, natively supporting Approach C
without backward-compatibility constraints.

### Combined Approach: B + C

Approaches B and C complement each other:
- **C handles identity + positioning**: What identifies an order (SHA), and how
  its position is determined (nullable ordinal, externally assigned).
- **B handles metadata + display**: What additional info lives on the order
  (commit message, author), and what the UI shows.

For new test suites (SHA-based): the order field IS the display value (the
SHA), ordinal is just for sorting. `display: true` isn't needed.

For existing test suites (git-distance-based): `display: true` on an order
metadata field (like `git_sha`) overrides the numeric sort key in the UI.

### The A/B Comparison Problem

A frequently cited use case for LNT is one-off A/B comparisons with
experimental changes. Currently, every run must have a valid order, forcing
users to create dummy orders that clutter the order space.

This led to the idea of making `order_id` on Run **nullable**: a run without
an order is a standalone data point that exists, has samples, belongs to a
machine, but isn't tied to any position in the project's history.

This gives three tiers:
1. **Run with ordered identifier** (ordinal set): normal time-series data.
2. **Run with unordered identifier** (ordinal NULL): tied to a commit but not
   yet positioned.
3. **Run with no identifier**: standalone/throwaway, for A/B comparisons.

## Final Design Direction

### The Core Concept: Identifiers Replace Orders

Decouple "grouping" from "ordering" entirely:

1. **Every run has an optional identifier** (a single string). Runs with the
   same identifier are grouped together. The identifier has no inherent
   ordering semantics. It could be a SHA, a label like
   `"wip-experimental-vectorizer"`, or anything else.

2. **Ordering is optional and external.** Via the API, you can assign an
   ordinal to an identifier, which places it in a total order. This unlocks
   time-series views, regression detection, etc.

### Impact on v4

The v4 API and views can stay **completely unchanged**:
- v4 submissions always create orders (backward compatible).
- v4 queries use inner joins on Order, naturally excluding identifier-less
  runs.
- Only a handful of shared DB methods need NULL guards.

A v5 instance would only serve v5 API endpoints -- no straddling both APIs.

### Clean Break for v5 DB Layer

Rather than retrofitting the v4 database schema, the v5 database is a clean
redesign. Migration from v4 to v5 is handled by a separate offline tool. This
means:
- No migration constraints on the v5 schema design.
- No dual-path code in the DB layer.
- No schema format version gymnastics.
- v4 code stays frozen in the codebase for production instances.
- v5 code is clean and purpose-built.

### Proposed v5 Data Model

```
Identifier:
  id          Integer PK
  identifier  String, unique, not null
  ordinal     Integer, nullable, unique
  tag         String, nullable
  (metadata columns from order_fields in schema)

Run:
  id              Integer PK
  identifier_id   Integer FK, nullable    -- orderless runs just work
  machine_id      Integer FK
  start_time      DateTime
  end_time        DateTime

Machine, Test, Sample -- cleaned up versions of today's tables
```

### Proposed Schema Format

```yaml
name: nts

metrics:
- name: compile_time
  type: Real
  ...

run_fields:
- name: start_time
- name: end_time

order_fields:                     # optional metadata on identifiers
- name: author
- name: commit_message
  type: text

machine_fields:
- name: hardware
- name: os
```

The identifier is a built-in concept (a single string column), not
schema-defined. `order_fields` provides optional typed metadata columns on
the Identifier table.

### Storing Large Strings

For metadata fields like commit messages, two options were discussed:

- **SQLAlchemy `Text` column**: Unlimited length on SQLite/PostgreSQL. Specified
  via `type: text` in the schema.
- **`Binary` column with JSON encoding**: The existing LNT pattern
  (`parameters_data` on Machine/Run). Good for unstructured data.

Schema-defined `order_fields` would use `Text` for large strings. A generic
`parameters_data` blob could also be added for unstructured metadata.

### Population of Identifier Metadata

Identifier metadata (commit info, ordinals) is populated **only via the API**
(e.g., `PATCH /api/v5/{ts}/identifiers/{id}`), not by run submissions. Run
submissions only provide the identifier string. An external workflow (CI hook,
cron job, etc.) handles the rest.

### Deployment Model

- **Production instances**: Run v4 API with v4 DB layer (unchanged).
- **Experimental instances**: Run migration tool once, then run v5 API with
  v5 DB layer.
- A v5 instance serves only v5 endpoints.

## Open Questions

1. How should backward compatibility work for existing test suites that submit
   numeric git distances? Options: auto-assign ordinal for numeric identifiers,
   require external process for everyone, or make it configurable per suite.
2. Exact schema format details: does `order: true` still exist on a run field
   to link submissions to identifiers, or is the identifier always a separate
   top-level field in the submission JSON?
3. How does the `display: true` mechanism work in the UI -- is it needed at
   all if the identifier itself (e.g., SHA) is already human-meaningful?
4. Migration tool design: how to map v4 Orders (with linked-list positions) to
   v5 Identifiers (with ordinals).

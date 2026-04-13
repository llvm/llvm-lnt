# Regression & Field Change Workflow: Discussion Summary & Plan

## Origin

Feature requests from a colleague using an AI agent to investigate libc++
performance regressions on an LNT v5 instance (`lnt-feature-requests.md`).
The agent detects regressions externally, performs A/B testing, and needs to
write findings back into LNT. The v5 API's data model is too thin — only a
256-char title and a bug URL on regressions, no way to annotate field changes.

Three original requests:
1. Add a `notes` field to Regression (free-text, for investigation findings)
2. Add a `reason` parameter to POST /field-changes/{uuid}/ignore
3. Add a `false_positive` state to the Regression state enum

## Discussion & Design Decisions

### Rethinking the model for external agents

LNT is moving toward being a data store for perf data + regression tracking,
with analysis happening externally (AI agents). This changes the picture:

- **`staged` and `detected_fixed` are dead states.** Both assumed LNT does
  auto-detection. `staged` = "approved, waiting for cooldown" (cooldown from
  what?). `detected_fixed` = "system noticed metric recovered." Neither has
  working automation behind it. Remove from v5 API.

- **`ignored` is redundant.** With `not_to_be_fixed` (real, won't fix) and
  `false_positive` (not real), there's no remaining semantic space for
  `ignored`. Remove from v5 API.

- **FieldChanges are pure stateless data.** A FC is an observation: "metric X
  changed by Y% between orders A and B on machine M." It doesn't need its own
  lifecycle. The only relationship that matters is whether it's linked to a
  regression (via RegressionIndicator).

- **ChangeIgnore is not needed in v5.** It was a triage filter for
  auto-detected signals ("system flagged this, but it's noise"). In the
  external-agent world, the agent creates FCs deliberately — it wouldn't
  create one just to ignore it. Dismissal of FCs happens at the regression
  level: group them into a `false_positive` regression with notes.

- **The ignore endpoints are removed.** POST /field-changes/{uuid}/ignore
  and DELETE /field-changes/{uuid}/ignore are gone. Feature request #2
  (reason on ignore) is satisfied by regression `notes` on a `false_positive`
  regression.

### Final Regression state machine (v5 API)

| State             | DB value | Meaning                              |
|-------------------|----------|--------------------------------------|
| `detected`        | 0        | Newly flagged, needs review          |
| `active`          | 10       | Confirmed real, needs investigation  |
| `not_to_be_fixed` | 20       | Real regression, accepted/won't fix  |
| `fixed`           | 22       | Resolved                             |
| `false_positive`  | 24       | Noise / detection error              |

Removed from v5 API (kept in DB/v4 code for backwards compat):
- `staged` (1) — unused auto-detection workflow
- `ignored` (21) — redundant with not_to_be_fixed + false_positive
- `detected_fixed` (23) — unused auto-detection workflow

The `state_to_api()` function returns `'unknown_N'` for unmapped DB values.

### Final FieldChange model

FCs have no state. Properties:
- Identity: uuid
- What changed: test, machine, metric (field)
- Between when: start_order, end_order
- By how much: old_value, new_value
- Context: run (optional FK)
- Relationship: → RegressionIndicator → Regression (many-to-many)

GET /field-changes returns ALL field changes (no exclusions), enriched with
`regression_uuids` (list of regression UUIDs the FC belongs to, empty if
unassigned). Existing filters (machine, test, metric) still work.

### Notes on Regression

New `notes` TEXT column. Nullable, no length limit. Accepted in POST
/regressions and PATCH /regressions/{uuid}. Returned in all GET responses
(list and detail). This is where investigation findings go — root cause
analysis, A/B test results, links to related changes, reasons for
false_positive classification, etc.

## Implementation Plan

### Commit 1: Database & Model Changes

**Migration** (next upgrade script):
- Add `Notes` TEXT column to each test suite's Regression table
- Nullable, no backfill needed

**Model** (Regression):
- Add `notes = Column("Notes", Text)` after `state`
- Update `__init__` to accept optional `notes=None`

**State machine** (RegressionState):
- Add `FALSE_POSITIVE = 24`
- Add to `names` dict
- Do NOT remove existing constants (v4 references them)

### Commit 2: API Changes

**State mapping** (schemas/regressions.py STATE_TO_DB):
- Remove `'staged': 1`, `'ignored': 21`, `'detected_fixed': 23`
- Add `'false_positive': 24`

**Regression schemas**:
- Add `notes` to create, update, list, and detail schemas

**Regression endpoints**:
- Serialize `notes` in list and detail responses
- Accept `notes` in POST (create) and PATCH (update)

**Field change endpoint** (GET /field-changes):
- Remove LEFT JOIN exclusion logic (ChangeIgnore + RegressionIndicator)
- Return all FCs, enriched with `regression_uuids`
- Batch query RegressionIndicator JOIN Regression after pagination

**Remove ignore endpoints**:
- Delete POST /field-changes/{uuid}/ignore
- Delete DELETE /field-changes/{uuid}/ignore
- Remove related schemas (FieldChangeIgnoreResponseSchema)

**Field change response shape**:
```json
{
  "uuid": "...",
  "test": "...",
  "machine": "...",
  "metric": "...",
  "old_value": 1.0,
  "new_value": 2.0,
  "start_order": "rev1",
  "end_order": "rev2",
  "run_uuid": "...",
  "regression_uuids": ["uuid1", "uuid2"]
}
```

**Tests**:
- State mapping: false_positive round-trips; staged/ignored/detected_fixed
  return unknown_N / None
- Regressions: notes CRUD (create, read list+detail, update, null);
  false_positive accepted; staged/ignored/detected_fixed rejected (422)
- Field changes: list returns all FCs; regression_uuids enrichment correct;
  ignore endpoints gone (404); existing filters + pagination still work

### Commit 3: Design & Implementation Doc Updates

- Update regression states in docs/design/v5-api.md and
  docs/v5-api-implementation-plan.md
- Add notes to regression model docs
- Update field-changes section: remove ignore, list returns all with
  regression_uuids
- Fix field naming inconsistency in design doc: test_name→test,
  machine_name→machine, field_name→metric
- Document philosophy: FCs are stateless data, workflow at regression level

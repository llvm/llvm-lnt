# v5 Regression API Rewrite: Implementation Plan

This plan covers all changes needed to align the API layer with the redesigned
v5 regression model (FieldChange dropped, RegressionIndicator stores
machine/test/metric directly, 5 regression states, no merge/split).

The DB layer is already done (commit 23e8e34). This plan covers the API
endpoints, schemas, helpers, blueprint registration, tests, and cross-cutting
files that reference the old model.

---

## 1. Files to Delete

### 1a. `lnt/server/api/v5/endpoints/field_changes.py` (entire file)

The FieldChange table no longer exists. Delete the whole file (137 lines).

### 1b. `tests/server/api/v5/test_field_changes.py` (entire file)

All tests here exercise the deleted endpoint. Delete the whole file (607 lines).

---

## 2. Schema Changes: `lnt/server/api/v5/schemas/regressions.py`

### 2a. Update STATE_TO_DB (lines 19-27)

The old mapping has 7 states (detected=0, staged=1, active=2,
not_to_be_fixed=3, ignored=4, fixed=5, detected_fixed=6). The new model has 5
states aligned with the DB layer values in `lnt/server/db/v5/__init__.py`
lines 34-40.

Replace:

```python
STATE_TO_DB = {
    'detected': 0,
    'staged': 1,
    'active': 2,
    'not_to_be_fixed': 3,
    'ignored': 4,
    'fixed': 5,
    'detected_fixed': 6,
}
```

With:

```python
STATE_TO_DB = {
    'detected': 0,
    'active': 1,
    'not_to_be_fixed': 2,
    'fixed': 3,
    'false_positive': 4,
}
```

`DB_TO_STATE`, `VALID_STATES`, `state_to_api`, and `state_to_db` remain
unchanged (they derive from STATE_TO_DB).

### 2b. Drop all FieldChange-related schemas

Delete these classes entirely:

- `FieldChangeResponseSchema` (lines 98-131)
- `FieldChangeCreateSchema` (lines 134-164)
- `PaginatedFieldChangeResponseSchema` (lines 284-286)
- `FieldChangeListQuerySchema` (lines 319-332)

### 2c. Drop merge/split schemas

Delete these classes:

- `RegressionMergeSchema` (lines 208-215)
- `RegressionSplitSchema` (lines 218-225)

### 2d. Rewrite IndicatorResponseSchema (lines 60-95)

The old schema references `field_change_uuid`, `old_value`, `new_value`,
`start_commit`, `end_commit`. The new model is simpler: indicators directly
have `uuid`, `machine`, `test`, `metric`.

Replace with:

```python
class IndicatorResponseSchema(BaseSchema):
    """Schema for a single regression indicator."""
    uuid = ma.fields.String(
        required=True,
        metadata={'description': 'Indicator UUID'},
    )
    machine = ma.fields.String(
        required=True,
        metadata={'description': 'Name of the machine'},
    )
    test = ma.fields.String(
        required=True,
        metadata={'description': 'Name of the test'},
    )
    metric = ma.fields.String(
        required=True,
        metadata={'description': 'Metric name'},
    )
```

### 2e. Rewrite IndicatorAddSchema (lines 228-233)

Old: `{field_change_uuid: "..."}` (single). New: batch array of
`{machine, test, metric}` objects.

Replace with:

```python
class IndicatorAddSchema(BaseSchema):
    """Schema for POST /regressions/{uuid}/indicators request body."""
    indicators = ma.fields.List(
        ma.fields.Nested(IndicatorInputSchema),
        required=True,
        validate=ma.validate.Length(min=1),
        metadata={'description': 'List of {machine, test, metric} indicators to add'},
    )
```

This requires a new nested schema:

```python
class IndicatorInputSchema(BaseSchema):
    """Schema for a single indicator input ({machine, test, metric})."""
    machine = ma.fields.String(
        required=True,
        metadata={'description': 'Machine name'},
    )
    test = ma.fields.String(
        required=True,
        metadata={'description': 'Test name'},
    )
    metric = ma.fields.String(
        required=True,
        metadata={'description': 'Metric name'},
    )
```

Place `IndicatorInputSchema` before `IndicatorAddSchema` so it can be
referenced.

### 2f. Add IndicatorRemoveSchema (new)

```python
class IndicatorRemoveSchema(BaseSchema):
    """Schema for DELETE /regressions/{uuid}/indicators request body."""
    indicator_uuids = ma.fields.List(
        ma.fields.String(),
        required=True,
        validate=ma.validate.Length(min=1),
        metadata={'description': 'UUIDs of indicators to remove'},
    )
```

### 2g. Rewrite RegressionCreateSchema (lines 170-191)

Old: `{field_change_uuids: [...], title, bug, state}`. New: `{title, bug,
notes, state, commit, indicators: [{machine, test, metric}]}`.

Replace with:

```python
class RegressionCreateSchema(BaseSchema):
    """Schema for POST /regressions request body."""
    title = ma.fields.String(
        load_default=None,
        metadata={'description': 'Optional title (auto-generated if omitted)'},
    )
    bug = ma.fields.String(
        load_default=None,
        metadata={'description': 'Optional bug URL'},
    )
    notes = ma.fields.String(
        load_default=None,
        metadata={'description': 'Optional investigation notes'},
    )
    state = ma.fields.String(
        load_default=None,
        validate=ma.validate.OneOf(VALID_STATES),
        metadata={'description': 'Optional initial state (default: detected)',
                  'enum': VALID_STATES},
    )
    commit = ma.fields.String(
        load_default=None,
        metadata={'description': 'Optional suspected introduction commit (resolved by value)'},
    )
    indicators = ma.fields.List(
        ma.fields.Nested(IndicatorInputSchema),
        load_default=[],
        metadata={'description': 'Optional list of {machine, test, metric} indicators'},
    )
```

Note: `indicators` is optional (defaults to empty list, matching the API spec
which says "optional"). `field_change_uuids` is removed.

### 2h. Rewrite RegressionUpdateSchema (lines 194-205)

Old: `{title, bug, state}`. New: adds `notes` and `commit`.

Replace with:

```python
class RegressionUpdateSchema(BaseSchema):
    """Schema for PATCH /regressions/{uuid} request body."""
    title = ma.fields.String(
        metadata={'description': 'New title'},
    )
    bug = ma.fields.String(
        allow_none=True,
        metadata={'description': 'New bug URL (null to clear)'},
    )
    notes = ma.fields.String(
        allow_none=True,
        metadata={'description': 'New notes (null to clear)'},
    )
    state = ma.fields.String(
        validate=ma.validate.OneOf(VALID_STATES),
        metadata={'description': 'New state', 'enum': VALID_STATES},
    )
    commit = ma.fields.String(
        allow_none=True,
        metadata={'description': 'Suspected introduction commit (null to clear)'},
    )
```

`bug`, `notes`, and `commit` need `allow_none=True` so clients can send
`null` to explicitly clear the field. The PATCH handler (section 3h) uses
`'key' in body` checks to distinguish absent vs present fields, and only
passes present fields to the DB layer via `**kwargs`.

### 2i. Rewrite RegressionListItemSchema (lines 240-251)

Old: `{uuid, title, bug, state}`. New: adds `commit`, `machine_count`,
`test_count` per the spec in `docs/design/api/endpoints.md` (Regressions section).

Replace with:

```python
class RegressionListItemSchema(BaseSchema):
    """Schema for a regression in list responses."""
    uuid = ma.fields.String(required=True)
    title = ma.fields.String(allow_none=True)
    bug = ma.fields.String(allow_none=True)
    state = ma.fields.String(
        required=True,
        metadata={'description': 'Regression state', 'enum': VALID_STATES},
    )
    commit = ma.fields.String(
        allow_none=True,
        metadata={'description': 'Suspected introduction commit (identity string)'},
    )
    machine_count = ma.fields.Integer(
        metadata={'description': 'Number of distinct machines across indicators'},
    )
    test_count = ma.fields.Integer(
        metadata={'description': 'Number of distinct tests across indicators'},
    )
```

### 2j. Rewrite RegressionDetailSchema (lines 253-267)

Old: `{uuid, title, bug, state, indicators}`. New: adds `notes`, `commit`.

Replace with:

```python
class RegressionDetailSchema(BaseSchema):
    """Schema for a single regression detail response."""
    uuid = ma.fields.String(required=True)
    title = ma.fields.String(allow_none=True)
    bug = ma.fields.String(allow_none=True)
    notes = ma.fields.String(
        allow_none=True,
        metadata={'description': 'Investigation notes'},
    )
    state = ma.fields.String(
        required=True,
        metadata={'description': 'Regression state', 'enum': VALID_STATES},
    )
    commit = ma.fields.String(
        allow_none=True,
        metadata={'description': 'Suspected introduction commit (identity string)'},
    )
    indicators = ma.fields.List(
        ma.fields.Nested(IndicatorResponseSchema),
        metadata={'description': 'Embedded list of regression indicators'},
    )
```

### 2k. Drop PaginatedIndicatorResponseSchema (lines 279-281)

Indicators are now embedded in the detail response, not separately paginated.
Delete:

```python
class PaginatedIndicatorResponseSchema(PaginatedResponseSchema):
    """Paginated list of regression indicators."""
    items = ma.fields.List(ma.fields.Nested(IndicatorResponseSchema))
```

### 2l. Drop RegressionIndicatorsQuerySchema (lines 314-316)

No more GET /regressions/{uuid}/indicators endpoint. Delete:

```python
class RegressionIndicatorsQuerySchema(CursorPaginationQuerySchema):
    """Query parameters for GET /regressions/{uuid}/indicators."""
    pass
```

### 2m. Update RegressionListQuerySchema (lines 293-312)

Add `commit` and `has_commit` filter parameters per `docs/design/api/endpoints.md` (Regressions section).

```python
class RegressionListQuerySchema(CursorPaginationQuerySchema):
    """Query parameters for GET /regressions."""
    state = webargs_fields.DelimitedList(
        ma.fields.String(),
        load_default=[],
        metadata={'description': 'Filter by state (comma-separated)'},
    )
    machine = ma.fields.String(
        load_default=None,
        metadata={'description': 'Filter by machine name'},
    )
    test = ma.fields.String(
        load_default=None,
        metadata={'description': 'Filter by test name'},
    )
    metric = ma.fields.String(
        load_default=None,
        metadata={'description': 'Filter by metric name'},
    )
    commit = ma.fields.String(
        load_default=None,
        metadata={'description': 'Filter by commit (regressions whose commit_id matches)'},
    )
    has_commit = ma.fields.Boolean(
        load_default=None,
        metadata={'description': 'Filter: true = has commit, false = no commit'},
    )
```

---

## 3. Endpoint Changes: `lnt/server/api/v5/endpoints/regressions.py`

### 3a. Update module docstring (lines 1-13)

Replace the current docstring to reflect the new endpoint set:

```python
"""Regression endpoints for the v5 API.

GET    /api/v5/{ts}/regressions                     -- List
POST   /api/v5/{ts}/regressions                     -- Create
GET    /api/v5/{ts}/regressions/{uuid}              -- Detail
PATCH  /api/v5/{ts}/regressions/{uuid}              -- Update
DELETE /api/v5/{ts}/regressions/{uuid}              -- Delete
POST   /api/v5/{ts}/regressions/{uuid}/indicators   -- Add indicators (batch)
DELETE /api/v5/{ts}/regressions/{uuid}/indicators   -- Remove indicators (batch)
"""
```

### 3b. Update imports (lines 15-51)

Remove all FieldChange-related imports:

- Remove `joinedload` from `sqlalchemy.orm` (no longer needed for eager-loading
  FieldChange chains)
- Remove from `..helpers`: `lookup_fieldchange`, `serialize_fieldchange`
- Remove from `..schemas.regressions`:
  `PaginatedIndicatorResponseSchema`, `RegressionIndicatorsQuerySchema`,
  `RegressionMergeSchema`, `RegressionSplitSchema`
- Add new imports from `..schemas.regressions`:
  `IndicatorRemoveSchema`
- Keep: `IndicatorAddSchema`, `IndicatorResponseSchema`,
  `PaginatedRegressionListSchema`, `RegressionCreateSchema`,
  `RegressionDetailSchema`, `RegressionListQuerySchema`,
  `RegressionUpdateSchema`, `STATE_TO_DB`, `state_to_api`, `state_to_db`
- Add `lookup_commit` from `..helpers`

Updated imports block:

```python
from flask import g, jsonify, make_response
from flask.views import MethodView
from flask_smorest import Blueprint

from ..auth import require_scope
from ..errors import abort_with_error, reject_unknown_params
from ..helpers import (
    lookup_commit,
    lookup_machine,
    lookup_regression,
    lookup_test,
    validate_metric_name,
)
from ..etag import add_etag_to_response
from ..pagination import (
    cursor_paginate,
    make_paginated_response,
)
from ..schemas.regressions import (
    IndicatorAddSchema,
    IndicatorRemoveSchema,
    IndicatorResponseSchema,
    PaginatedRegressionListSchema,
    RegressionCreateSchema,
    RegressionDetailSchema,
    RegressionListQuerySchema,
    RegressionUpdateSchema,
    STATE_TO_DB,
    state_to_api,
    state_to_db,
)
```

### 3c. Update Blueprint description (line 53-58)

Change:

```python
description='Triage performance regressions: create, merge, split, and manage indicators',
```

To:

```python
description='Triage performance regressions: create, update, delete, and manage indicators',
```

### 3d. Rewrite all helper functions (lines 62-154)

Delete the entire old helpers section (`_fc_load_branches`,
`_indicator_load_options`, `_indicator_query_options`, `_serialize_indicator`,
`_serialize_regression_list`, `_serialize_regression_detail`,
`_validate_state`, `_lookup_regression_with_indicators`).

Replace with:

```python
def _serialize_indicator(ri):
    """Serialize a RegressionIndicator into the API response dict."""
    return {
        'uuid': ri.uuid,
        'machine': ri.machine.name if ri.machine else None,
        'test': ri.test.name if ri.test else None,
        'metric': ri.metric,
    }


def _serialize_regression_list(regression):
    """Serialize a Regression for the list endpoint.

    Requires the regression to have indicators eagerly loaded (or
    accessible) for computing machine_count and test_count.
    """
    # Compute distinct machine/test counts from indicators
    machines = set()
    tests = set()
    for ri in regression.indicators:
        machines.add(ri.machine_id)
        tests.add(ri.test_id)

    return {
        'uuid': regression.uuid,
        'title': regression.title,
        'bug': regression.bug,
        'state': state_to_api(regression.state),
        'commit': (regression.commit_obj.commit
                   if regression.commit_obj else None),
        'machine_count': len(machines),
        'test_count': len(tests),
    }


def _serialize_regression_detail(regression):
    """Serialize a Regression for the detail endpoint (with indicators)."""
    serialized_indicators = [
        _serialize_indicator(ri) for ri in regression.indicators
    ]
    return {
        'uuid': regression.uuid,
        'title': regression.title,
        'bug': regression.bug,
        'notes': regression.notes,
        'state': state_to_api(regression.state),
        'commit': (regression.commit_obj.commit
                   if regression.commit_obj else None),
        'indicators': serialized_indicators,
    }


def _validate_state(state_str):
    """Validate and convert a state string to its DB integer.

    Aborts with 400 if invalid.
    """
    db_state = state_to_db(state_str)
    if db_state is None:
        abort_with_error(
            400,
            "Invalid state '%s'. Valid states: %s"
            % (state_str, ', '.join(sorted(STATE_TO_DB.keys()))))
    return db_state


def _resolve_indicators(session, ts, indicator_dicts):
    """Resolve indicator input dicts to DB-ready dicts.

    Each input dict has {machine, test, metric} (names). This function
    looks up each entity and returns a list of dicts with
    {machine_id, test_id, metric}.

    Aborts with 404 if any machine or test is not found, 400 if metric is
    unknown.
    """
    resolved = []
    for ind in indicator_dicts:
        machine = lookup_machine(session, ts, ind['machine'])
        test = lookup_test(session, ts, ind['test'])
        validate_metric_name(ts, ind['metric'])
        resolved.append({
            'machine_id': machine.id,
            'test_id': test.id,
            'metric': ind['metric'],
        })
    return resolved


def _eager_load_regression(session, ts, regression_uuid):
    """Look up a regression by UUID with eager-loaded relationships.

    Loads indicators with their machine and test relationships for
    serialization. Aborts with 404 if not found.
    """
    from sqlalchemy.orm import joinedload, subqueryload

    reg = (
        session.query(ts.Regression)
        .options(
            joinedload(ts.Regression.commit_obj),
            subqueryload(ts.Regression.indicators)
                .joinedload(ts.RegressionIndicator.machine),
            subqueryload(ts.Regression.indicators)
                .joinedload(ts.RegressionIndicator.test),
        )
        .filter(ts.Regression.uuid == regression_uuid)
        .first()
    )
    if reg is None:
        abort_with_error(404, "Regression '%s' not found" % regression_uuid)
    return reg
```

Key design notes:
- `_serialize_indicator` now returns `{uuid, machine, test, metric}` (no
  more `field_change_uuid`, `old_value`, `new_value`, `start_commit`,
  `end_commit`).
- `_serialize_regression_list` now includes `commit`, `machine_count`,
  `test_count` as required by the spec.
- `_serialize_regression_detail` adds `notes` and `commit`.
- `_resolve_indicators` handles the name-to-id resolution for create/add.
- `_eager_load_regression` replaces `_lookup_regression_with_indicators`,
  using `joinedload` for `commit_obj` and `subqueryload` for indicators
  with their machine/test relations.
- The PATCH handler uses `'key' in body` checks to distinguish absent vs null,
  letting the DB layer's `_UNSET` defaults handle the rest.

### 3e. Rewrite RegressionList.get() (lines 160-225)

The old version JOINs through `RegressionIndicator` -> `FieldChange` to
filter by machine/test/metric. The new model has machine_id, test_id, metric
directly on `RegressionIndicator`.

New `has_commit` and `commit` filters (from the query schema) need to be
handled.

For the list endpoint to compute `machine_count` and `test_count`, we need
the indicators to be loaded. Use `subqueryload` for the indicators relation.

```python
@require_scope('read')
@blp.arguments(RegressionListQuerySchema, location="query")
@blp.response(200, PaginatedRegressionListSchema)
def get(self, query_args, testsuite):
    """List regressions (cursor-paginated, filterable)."""
    reject_unknown_params(
        {'state', 'machine', 'test', 'metric', 'commit',
         'has_commit', 'cursor', 'limit'})
    ts = g.ts
    session = g.db_session

    from sqlalchemy.orm import subqueryload, joinedload
    query = session.query(ts.Regression).options(
        joinedload(ts.Regression.commit_obj),
        subqueryload(ts.Regression.indicators),
    )

    # -- State filter --
    state_values = query_args['state']
    if state_values:
        db_states = [_validate_state(sv) for sv in state_values]
        query = query.filter(ts.Regression.state.in_(db_states))

    # -- Commit filters --
    commit_value = query_args.get('commit')
    if commit_value:
        commit_obj = lookup_commit(session, ts, commit_value)
        query = query.filter(
            ts.Regression.commit_id == commit_obj.id)

    has_commit = query_args.get('has_commit')
    if has_commit is True:
        query = query.filter(
            ts.Regression.commit_id.isnot(None))
    elif has_commit is False:
        query = query.filter(
            ts.Regression.commit_id.is_(None))

    # -- Machine / test / metric filters (via indicator JOIN) --
    machine_name = query_args.get('machine')
    test_name = query_args.get('test')
    metric_name = query_args.get('metric')

    machine = None
    if machine_name:
        machine = lookup_machine(session, ts, machine_name)
    test = None
    if test_name:
        test = lookup_test(session, ts, test_name)
    if metric_name:
        validate_metric_name(ts, metric_name)

    if machine or test or metric_name:
        query = query.join(
            ts.RegressionIndicator,
            ts.RegressionIndicator.regression_id == ts.Regression.id
        )

    if machine:
        query = query.filter(
            ts.RegressionIndicator.machine_id == machine.id)
    if test:
        query = query.filter(
            ts.RegressionIndicator.test_id == test.id)
    if metric_name:
        query = query.filter(
            ts.RegressionIndicator.metric == metric_name)

    if machine or test or metric_name:
        query = query.distinct()

    cursor_str = query_args.get('cursor')
    limit = query_args['limit']
    items, next_cursor = cursor_paginate(
        query, ts.Regression.id, cursor_str, limit)

    serialized = [_serialize_regression_list(r) for r in items]
    return jsonify(make_paginated_response(serialized, next_cursor))
```

Key differences from old:
- No more JOIN to `FieldChange`. Filters go directly through
  `RegressionIndicator.machine_id`, `.test_id`, `.metric`.
- New `commit` and `has_commit` filters.
- `subqueryload` for indicators so `_serialize_regression_list` can compute
  `machine_count`/`test_count` without N+1 queries.

### 3f. Rewrite RegressionList.post() (lines 227-256)

Old: `{field_change_uuids: [...]}`. New: `{title, bug, notes, state, commit,
indicators: [{machine, test, metric}]}`.

```python
@require_scope('triage')
@blp.arguments(RegressionCreateSchema)
@blp.response(201, RegressionDetailSchema)
def post(self, body, testsuite):
    """Create a new regression."""
    ts = g.ts
    session = g.db_session

    state_str = body.get('state') or 'detected'
    db_state = _validate_state(state_str)

    # Resolve commit by value (optional)
    commit_obj = None
    commit_value = body.get('commit')
    if commit_value:
        commit_obj = lookup_commit(session, ts, commit_value)

    # Resolve indicators (optional)
    indicator_dicts = body.get('indicators') or []
    resolved = _resolve_indicators(session, ts, indicator_dicts)

    title = body.get('title') or (
        'Regression of %d benchmarks' % len(resolved)
        if resolved else 'New regression')
    bug = body.get('bug')
    notes = body.get('notes')

    regression = ts.create_regression(
        session, title, resolved,
        bug=bug, notes=notes, commit=commit_obj, state=db_state)

    # Reload with eager-loaded relationships for serialization
    regression = _eager_load_regression(
        session, ts, regression.uuid)

    result = _serialize_regression_detail(regression)
    resp = jsonify(result)
    resp.status_code = 201
    return resp
```

### 3g. Rewrite RegressionDetail.get() (lines 264-277)

Add `notes` and `commit` to response (handled by the new
`_serialize_regression_detail`):

```python
@require_scope('read')
@blp.response(200, RegressionDetailSchema)
def get(self, testsuite, regression_uuid):
    """Get regression detail with embedded indicators."""
    reject_unknown_params(set())
    ts = g.ts
    session = g.db_session
    regression = _eager_load_regression(session, ts, regression_uuid)
    data = _serialize_regression_detail(regression)
    return add_etag_to_response(jsonify(data), data)
```

### 3h. Rewrite RegressionDetail.patch() (lines 279-298)

Add `notes` and `commit` handling, using `_UNSET` to distinguish absent vs
null:

```python
@require_scope('triage')
@blp.arguments(RegressionUpdateSchema)
@blp.response(200, RegressionDetailSchema)
def patch(self, body, testsuite, regression_uuid):
    """Update regression title, bug, notes, state, and/or commit."""
    ts = g.ts
    session = g.db_session
    regression = _eager_load_regression(session, ts, regression_uuid)

    kwargs = {}

    if 'title' in body:
        kwargs['title'] = body['title']

    if 'bug' in body:
        kwargs['bug'] = body['bug']  # can be None to clear

    if 'notes' in body:
        kwargs['notes'] = body['notes']  # can be None to clear

    if 'state' in body:
        kwargs['state'] = _validate_state(body['state'])

    if 'commit' in body:
        commit_value = body['commit']
        if commit_value is None:
            kwargs['commit'] = None  # clear
        else:
            kwargs['commit'] = lookup_commit(session, ts, commit_value)

    ts.update_regression(session, regression, **kwargs)

    # Reload for serialization (relationships may have changed)
    regression = _eager_load_regression(session, ts, regression_uuid)
    return jsonify(_serialize_regression_detail(regression))
```

The DB layer's `update_regression` already uses `_UNSET` for title/bug/notes/
commit. If a key is not in `kwargs`, the DB method leaves it unchanged.

### 3i. RegressionDetail.delete() (lines 300-308)

This needs no change in logic -- the cascade handles everything. Keep as-is.

### 3j. Delete RegressionMerge class (lines 311-371)

Delete the entire `RegressionMerge` class and its route decorator. Merge is
not part of the v5 API.

### 3k. Delete RegressionSplit class (lines 373-432)

Delete the entire `RegressionSplit` class and its route decorator. Split is
not part of the v5 API.

### 3l. Rewrite RegressionIndicators class (lines 434-496)

Replace the old `GET` + `POST` (single add) with `POST` (batch add) + `DELETE`
(batch remove). Drop `GET` entirely (indicators are embedded in detail).

```python
@blp.route('/regressions/<string:regression_uuid>/indicators')
class RegressionIndicators(MethodView):
    """Add and remove indicators for a regression (batch operations)."""

    @require_scope('triage')
    @blp.arguments(IndicatorAddSchema)
    @blp.response(200, RegressionDetailSchema)
    def post(self, body, testsuite, regression_uuid):
        """Add indicators to a regression (batch).

        Duplicates (same regression+machine+test+metric) are silently
        ignored.
        """
        ts = g.ts
        session = g.db_session
        regression = lookup_regression(session, ts, regression_uuid)

        indicator_dicts = body['indicators']
        resolved = _resolve_indicators(session, ts, indicator_dicts)

        ts.add_regression_indicators_batch(session, regression, resolved)

        # Reload and return full detail
        regression = _eager_load_regression(
            session, ts, regression_uuid)
        return jsonify(_serialize_regression_detail(regression))

    @require_scope('triage')
    @blp.arguments(IndicatorRemoveSchema)
    @blp.response(200, RegressionDetailSchema)
    def delete(self, body, testsuite, regression_uuid):
        """Remove indicators from a regression (batch, by UUID).

        Unknown UUIDs are silently ignored.
        """
        ts = g.ts
        session = g.db_session
        regression = lookup_regression(session, ts, regression_uuid)

        for indicator_uuid in body['indicator_uuids']:
            ts.remove_regression_indicator(
                session, regression.id, indicator_uuid)

        # Reload and return full detail
        regression = _eager_load_regression(
            session, ts, regression_uuid)
        return jsonify(_serialize_regression_detail(regression))
```

Design notes:
- POST returns 200 (not 201) and the full regression detail, since this is a
  batch operation on an existing resource.
- DELETE with body: flask-smorest supports `@blp.arguments(...)` on DELETE.
  The body contains `{"indicator_uuids": [...]}`.
- Both return the full regression detail for convenience.

### 3m. Delete RegressionIndicatorRemove class (lines 498-520)

Delete the old single-indicator DELETE route entirely:

```python
@blp.route(
    '/regressions/<string:regression_uuid>/indicators/<string:fc_uuid>')
class RegressionIndicatorRemove(MethodView):
    ...
```

---

## 4. Helper Changes: `lnt/server/api/v5/helpers.py`

### 4a. Delete `lookup_fieldchange` (lines 78-83)

This function references `ts.get_field_change` which no longer exists.
Delete entirely.

### 4b. Delete `serialize_fieldchange` (lines 138-154)

This function serializes FieldChange objects which no longer exist.
Delete entirely.

### 4c. No new helper needed

Indicator serialization is handled in the endpoint module
(`_serialize_indicator`), not in helpers.py, because the indicator model is
simpler (no need for a shared serializer across endpoints). If desired for
consistency, a `serialize_regression_indicator` helper could be added, but
the endpoint-local helper is simpler.

---

## 5. Other File Changes

### 5a. `lnt/server/api/v5/endpoints/__init__.py` -- Remove `field_changes` registration (line 24)

In `_ENDPOINT_MODULES`, remove the `'field_changes'` entry:

```python
# Before:
_ENDPOINT_MODULES = [
    'discovery',
    'test_suites',
    'commits',
    'machines',
    'runs',
    'tests',
    'samples',
    'profiles',
    'query',
    'field_changes',   # <-- DELETE THIS LINE
    'regressions',
    'trends',
    'admin',
]
```

### 5b. `lnt/server/api/v5/endpoints/test_suites.py` -- Remove `field_changes` link (line 45)

In `_suite_links()`, delete the `field_changes` entry:

```python
# Delete this line:
'field_changes': prefix + '/field-changes',
```

### 5c. `lnt/server/api/v5/schemas/common.py` -- Remove `field_changes` from TestSuiteLinksSchema (line 58)

Delete:

```python
field_changes = ma.fields.String()
```

### 5d. `lnt/server/api/v5/endpoints/machines.py` -- Remove FieldChange cleanup from delete (lines 213-218)

The machine delete handler currently deletes FieldChanges before deleting
the machine (because FieldChange.machine_id had no CASCADE). With FieldChange
gone, `RegressionIndicator.machine_id` has no CASCADE either, so the indicators
referencing this machine must be cleaned up.

Replace:

```python
# FieldChange.machine_id has no CASCADE, so delete them first.
# RegressionIndicator.field_change_id has ondelete=CASCADE,
# so those are auto-cleaned when the FieldChange is deleted.
session.query(ts.FieldChange).filter(
    ts.FieldChange.machine_id == machine.id
).delete(synchronize_session='fetch')
```

With:

```python
# RegressionIndicator.machine_id has no CASCADE, so delete them
# before the machine. The Regression itself remains (it may have
# other indicators on different machines).
session.query(ts.RegressionIndicator).filter(
    ts.RegressionIndicator.machine_id == machine.id
).delete(synchronize_session='fetch')
```

### 5e. `lnt/server/api/v5/endpoints/commits.py` -- Update delete docstring (line 258)

Change:

```
Returns 409 if FieldChanges reference this commit.
```

To:

```
Returns 409 if regressions reference this commit.
```

The actual behavior is already correct: `ts.delete_commit` raises
`ValueError` if any Regression has `commit_id` pointing to this commit.
Only the docstring is stale.

### 5f. `lnt/server/api/v5/endpoints/agents.py` -- Update llms.txt content

Update the LLMS_TEXT constant:

1. Change the Regression description (line 49-51):
   - Old: "A detected performance change, grouping one or more field changes"
   - New: "A tracked performance change, grouping one or more indicators
     (machine, test, metric triples). Has a state (detected, active, fixed,
     etc.), optional title, bug link, notes, and suspected introduction commit."

2. Remove the Field Change entry (lines 53-54):
   - Delete: "- **Field Change**: A statistically significant change..."

3. Update the endpoints list (line 79):
   - Remove: `GET    /api/v5/{ts}/field-changes         List unassigned field changes`

4. Update workflow item 4 (lines 117-118):
   - Change to mention indicators instead of field changes.

5. After updating the text, the `_ETAG` hash (line 126) recomputes
   automatically since it's `hashlib.md5(LLMS_TEXT.encode()).hexdigest()`.

### 5g. `lnt/server/api/v5/middleware.py` -- No changes needed

Middleware has no references to FieldChange.

---

## 6. Test Changes

### 6a. Delete `tests/server/api/v5/test_field_changes.py` (entire file)

Already covered in section 1b.

### 6b. Rewrite `tests/server/api/v5/v5_test_helpers.py`

#### Drop `create_fieldchange` (lines 110-115)

Delete the `create_fieldchange` function. It calls `ts.create_field_change`
which no longer exists.

#### Drop `submit_fieldchange` (lines 189-203)

Delete the `submit_fieldchange` function. It calls
`POST /field-changes` which no longer exists.

#### Rewrite `create_regression` (lines 118-122)

Old:

```python
def create_regression(session, ts, title='Test Regression',
                      state=0, field_changes=None):
    """Create a Regression (optionally with indicators) and return it."""
    fc_ids = [fc.id for fc in field_changes] if field_changes else []
    return ts.create_regression(session, title, fc_ids, state=state)
```

New:

```python
def create_regression(session, ts, title='Test Regression',
                      state=0, indicators=None, commit=None,
                      notes=None, bug=None):
    """Create a Regression (optionally with indicators) and return it.

    *indicators* is a list of dicts with keys machine_id, test_id, metric.
    """
    indicator_list = indicators or []
    return ts.create_regression(
        session, title, indicator_list,
        state=state, commit=commit, notes=notes, bug=bug)
```

#### Rewrite `submit_regression` (lines 206-214)

Old:

```python
def submit_regression(client, app, fc_uuids, state='active',
                      testsuite='nts'):
    """Create a regression via POST and return response JSON."""
    body = {'field_change_uuids': fc_uuids, 'state': state}
    resp = client.post(f'/api/v5/{testsuite}/regressions',
                       json=body, headers=admin_headers())
    assert resp.status_code == 201, (
        f"Regression creation failed: {resp.get_json()}")
    return resp.get_json()
```

New:

```python
def submit_regression(client, app, indicators=None, state='active',
                      title=None, commit=None, notes=None, bug=None,
                      testsuite='nts'):
    """Create a regression via POST and return response JSON.

    *indicators* is a list of {machine, test, metric} dicts.
    """
    body = {'state': state}
    if indicators:
        body['indicators'] = indicators
    if title:
        body['title'] = title
    if commit:
        body['commit'] = commit
    if notes:
        body['notes'] = notes
    if bug:
        body['bug'] = bug
    resp = client.post(f'/api/v5/{testsuite}/regressions',
                       json=body, headers=admin_headers())
    assert resp.status_code == 201, (
        f"Regression creation failed: {resp.get_json()}")
    return resp.get_json()
```

#### Add `submit_indicator_add` helper (new)

```python
def submit_indicator_add(client, app, regression_uuid, indicators,
                         testsuite='nts'):
    """Add indicators to a regression via POST and return response JSON."""
    resp = client.post(
        f'/api/v5/{testsuite}/regressions/{regression_uuid}/indicators',
        json={'indicators': indicators},
        headers=admin_headers())
    assert resp.status_code == 200, (
        f"Indicator add failed: {resp.get_json()}")
    return resp.get_json()
```

#### Add `submit_indicator_remove` helper (new)

```python
def submit_indicator_remove(client, app, regression_uuid, indicator_uuids,
                            testsuite='nts'):
    """Remove indicators from a regression via DELETE and return response JSON."""
    resp = client.delete(
        f'/api/v5/{testsuite}/regressions/{regression_uuid}/indicators',
        json={'indicator_uuids': indicator_uuids},
        headers=admin_headers())
    assert resp.status_code == 200, (
        f"Indicator remove failed: {resp.get_json()}")
    return resp.get_json()
```

### 6c. Rewrite `tests/server/api/v5/test_regressions.py`

This is a comprehensive rewrite. Key structural changes:

#### Update imports (line 16-18)

Remove references to `submit_fieldchange`. Add references to new helpers:

```python
from v5_test_helpers import (
    create_app, create_client, make_scoped_headers,
    collect_all_pages, submit_run, submit_regression,
    submit_indicator_add, submit_indicator_remove,
    create_machine, create_commit, create_test,
)
```

#### Rewrite `_setup_regression_with_indicators` (replaces `_setup_fieldchange` and old `_setup_regression_with_indicators`)

The old helpers created FieldChange objects via `submit_fieldchange`, then
passed their UUIDs to `submit_regression`. The new version creates
regressions directly with `{machine, test, metric}` indicators:

```python
def _setup_regression_with_indicators(client, app, num_indicators=2,
                                      state='active', commit=None):
    """Create a regression with indicators via the API.

    Returns (regression_uuid, [indicator_uuid, ...]).
    """
    tag = uuid.uuid4().hex[:8]
    machine = f'reg-m-{tag}'
    tests = [f'reg/test/{tag}/{i}' for i in range(num_indicators)]

    # Ensure machine and tests exist by submitting a run
    submit_run(client, machine, f'reg-rev-{tag}',
               [{'name': t, 'execution_time': [1.0 + i]}
                for i, t in enumerate(tests)])

    indicators = [
        {'machine': machine, 'test': t, 'metric': 'execution_time'}
        for t in tests
    ]
    reg = submit_regression(client, app, indicators=indicators,
                            state=state, commit=commit)
    indicator_uuids = [ind['uuid'] for ind in reg['indicators']]
    return reg['uuid'], indicator_uuids
```

Delete `_setup_fieldchange` entirely.

#### Rewrite test classes

**TestRegressionList**: Update tests to use new helper. Most structure is
the same. Key changes:
- `test_list_item_has_expected_fields`: check for `commit`, `machine_count`,
  `test_count` instead of checking absence of indicators.
- `test_list_filter_by_state_multiple`: use new states (`active`, `detected`
  still valid).
- `test_list_filter_invalid_state_400`: unchanged.
- `test_list_filter_by_state`: remove reference to `ignored` state, use
  `active` or `false_positive`.

**TestRegressionListFilters**: Complete rewrite of the filter tests since
they no longer create FieldChanges:
- `test_list_filter_by_machine`: create regression with indicator pointing
  to specific machine, filter by machine name.
- `test_list_filter_by_test`: same pattern for test name.
- `test_list_filter_by_metric`: same pattern for metric.
- Add `test_list_filter_by_commit`: create regression with commit, filter
  by commit value.
- Add `test_list_filter_by_has_commit_true/false`.
- Keep 404/400 tests for nonexistent machine/test/metric.

**TestRegressionCreate**: Rewrite for new request body:
- `test_create_regression`: send `{indicators: [{machine, test, metric}]}`
  instead of `{field_change_uuids: [...]}`.
- `test_create_with_custom_title`: same pattern.
- `test_create_with_state`: same.
- `test_create_default_state_detected`: same.
- `test_create_with_commit`: new test, send `commit` field.
- `test_create_with_notes`: new test, send `notes` field.
- `test_create_empty_body_succeeds`: no required fields now (indicators
  defaults to []).
- Remove `test_create_missing_field_changes_422` and
  `test_create_empty_field_changes_422`.
- Remove `test_create_invalid_field_change_uuid_404`.
- Add `test_create_nonexistent_machine_404`: indicator references bad machine.
- Add `test_create_nonexistent_test_404`: indicator references bad test.
- Add `test_create_unknown_metric_400`: indicator references bad metric.
- Add `test_create_nonexistent_commit_404`: commit field references bad commit.

**TestRegressionDetail**: Update assertions:
- `test_get_detail`: check for `notes`, `commit`, and new indicator shape
  (`uuid`, `machine`, `test`, `metric` instead of `field_change_uuid`,
  `old_value`, etc.).
- `test_detail_state_is_string`: update expected default state.

**TestRegressionDetailETag**: No changes needed (works with any response shape).

**TestRegressionUpdate**: Add tests for notes and commit:
- `test_update_notes`: patch notes.
- `test_update_commit`: patch commit.
- `test_clear_commit`: patch commit=null.
- `test_clear_notes`: patch notes=null.
- `test_update_state_any_transition`: update state names (no more `ignored`,
  use `false_positive`).

**TestRegressionDelete**: No changes needed.

**Delete TestRegressionMerge class entirely** (lines 685-805).

**Delete TestRegressionSplit class entirely** (lines 811-891).

**Rewrite TestRegressionIndicators**: Complete rewrite for batch operations:
- Remove `test_list_indicators`: GET /indicators no longer exists.
- Remove `test_list_indicators_nonexistent_regression_404`.
- Rewrite `test_add_indicator`: POST with `{indicators: [{machine, test, metric}]}`.
- `test_add_duplicate_silently_ignored`: POST same indicator twice, verify
  no error and no duplicate.
- `test_add_nonexistent_machine_404`.
- `test_add_nonexistent_test_404`.
- `test_add_unknown_metric_400`.
- `test_add_indicator_no_auth_401`.
- Rewrite `test_remove_indicator`: DELETE with `{indicator_uuids: [...]}`.
- Remove `test_remove_nonexistent_indicator_404` (batch remove silently
  ignores unknown UUIDs).
- `test_remove_indicator_no_auth_401`.

**Delete TestRegressionZIndicatorPagination class entirely** (lines 1042-1065).
Indicators are now embedded in detail, not separately paginated.

**Update TestRegressionZPagination**: No changes needed (uses list endpoint).

**Update TestRegressionUnknownParams**:
- Remove `test_regression_indicators_unknown_param_returns_400`.
- Keep list and detail unknown param tests.
- Add `test_regressions_list_commit_filter_unknown_param_400` if desired.

### 6d. Update `tests/server/api/v5/test_regression_state_mapping.py`

The tests import `STATE_TO_DB` and test round-trip behavior. With the new
5-state mapping, the tests should continue to work as-is because:

- `test_all_known_states_round_trip` iterates over `STATE_TO_DB.items()`.
- `test_unknown_int_returns_unknown_prefix` tests unmapped integers.
- `test_unknown_string_returns_none` tests unmapped strings.

No code changes needed, but verify the tests pass with the new STATE_TO_DB
values. The tests will now exercise 5 states instead of 7.

### 6e. Update `tests/server/api/v5/test_commits.py` -- Replace FieldChange-based 409 test

**`test_delete_with_fieldchange_409`** (lines 529-556) creates a FieldChange
referencing a commit and asserts that deleting the commit returns 409. The
FieldChange table no longer exists.

Replace with a regression-based test:

```python
def test_delete_with_regression_409(self):
    """Delete a commit referenced by a Regression returns 409."""
    from v5_test_helpers import create_machine, create_test
    db = self.app.instance.get_database("default")
    session = db.make_session()
    ts = db.testsuite[TS]

    c = create_commit(session, ts,
                      commit=f'reg-ref-{uuid.uuid4().hex[:8]}')
    c_commit = c.commit
    m = create_machine(session, ts,
                       name=f'reg-del-{uuid.uuid4().hex[:8]}')
    t = create_test(session, ts,
                    name=f'reg-del/test/{uuid.uuid4().hex[:8]}')

    from v5_test_helpers import create_regression
    create_regression(
        session, ts,
        indicators=[{'machine_id': m.id, 'test_id': t.id,
                      'metric': 'execution_time'}],
        commit=c)
    session.commit()
    session.close()

    resp = self.client.delete(
        PREFIX + f'/commits/{c_commit}',
        headers=admin_headers(),
    )
    self.assertEqual(resp.status_code, 409)
```

Also update the imports at the top of the file to remove `create_fieldchange`
(line 531-533).

### 6f. Update `tests/server/api/v5/test_integration.py`

#### Remove `field_changes` from discovery links test (lines 404-410)

In `test_discovery_nts_suite_has_all_expected_links`, update the expected keys:

```python
# Before:
expected_keys = {
    'machines', 'commits', 'runs', 'tests',
    'regressions', 'field_changes', 'query',
}

# After:
expected_keys = {
    'machines', 'commits', 'runs', 'tests',
    'regressions', 'query',
}
```

#### TestMachineCRUDWorkflow -- no FieldChange references

Check: the machine CRUD test at lines 235-342 does not reference FieldChange
directly. It exercises create, submit, rename, delete. The machine delete
handler changes (section 5d) clean up RegressionIndicators instead of
FieldChanges, but the test does not create regressions, so no changes needed
to this test class.

### 6g. Update `tests/server/api/v5/test_machines.py`

Line 19 imports `create_fieldchange` from `v5_test_helpers`. Lines 341-377
contain `test_delete_machine_with_fieldchanges` which creates a FieldChange
and links it to a regression via the old model.

- Remove `create_fieldchange` from the import (line 19)
- Rewrite `test_delete_machine_with_fieldchanges` to use the new indicator
  model: create a regression with an indicator referencing the machine, then
  verify deleting the machine handles the indicator FK correctly. Rename to
  `test_delete_machine_with_regression_indicators`.

### 6h. Update `tests/server/api/v5/test_discovery.py`

Line 49 expects `'field_changes'` in the suite links set
(`test_discovery_suite_links_are_complete`). Remove `'field_changes'` from
the expected set.

### 6i. Additional test specifications

The following tests were named in section 6c but need explicit specifications:

**TestRegressionList:**
- `test_list_item_machine_and_test_counts`: Create a regression with 2
  indicators (1 machine, 2 tests). Verify `machine_count == 1` and
  `test_count == 2` in the list response item.
- `test_list_filter_by_commit`: Create two regressions with different commits.
  Filter `?commit=<value>`. Verify only the matching regression is returned.
- `test_list_filter_by_has_commit_true`: Create one regression with a commit,
  one without. Filter `?has_commit=true`. Verify only the one with a commit.
- `test_list_filter_by_has_commit_false`: Same setup, filter `?has_commit=false`.
  Verify only the one without a commit.
- `test_list_item_commit_value`: Create a regression with a commit. Verify
  the list item contains the commit string value (not just the key).

**TestRegressionDetail:**
- `test_get_detail`: Assert `notes` and `commit` in response. Assert indicator
  shape is `{uuid, machine, test, metric}`. Assert absence of old fields:
  `assertNotIn('field_change_uuid', ind)`, `assertNotIn('old_value', ind)`,
  `assertNotIn('new_value', ind)`, `assertNotIn('start_commit', ind)`,
  `assertNotIn('end_commit', ind)`.

**TestRegressionCreate:**
- `test_create_with_notes`: POST with `notes` field. Verify notes appears in
  the 201 response.
- `test_create_with_commit`: POST with `commit` field. Verify commit string
  in response.

**TestRegressionUpdate:**
- `test_update_state_any_transition`: Replace `'ignored'` with
  `'false_positive'` in both directions: `active -> false_positive -> detected`.
- `test_clear_commit`: Create with commit, PATCH `{"commit": null}`, verify
  response has `commit: null`.

**TestRegressionIndicators:**
- `test_add_duplicate_silently_ignored`: Add indicator, add same indicator
  again, verify 200 and indicator count unchanged.
- `test_add_nonexistent_machine_404`: POST indicator with nonexistent machine
  name, expect 404.
- `test_add_nonexistent_test_404`: Same for test name.
- `test_add_unknown_metric_400`: Same for unknown metric.
- `test_remove_multiple_batch`: Create regression with 3 indicators, remove 2
  via batch DELETE, verify response has 1 remaining.
- `test_remove_unknown_uuid_silently_ignored`: Send DELETE with a nonexistent
  UUID, verify 200 with unchanged indicators.
- `test_remove_no_auth_401`: Send DELETE without auth headers, expect 401.
- `test_add_empty_list_422`: POST `{"indicators": []}`, expect 422.
- `test_remove_empty_list_422`: DELETE `{"indicator_uuids": []}`, expect 422.

---

## 7. Verification Steps

After implementing all changes, verify:

### 7a. Unit tests (no DB)

```bash
python tests/server/api/v5/test_regression_state_mapping.py
```

This runs the pure-function state mapping tests against the updated
STATE_TO_DB.

### 7b. Full API tests (require Postgres)

```bash
lit -sv tests/server/api/v5/test_regressions.py
lit -sv tests/server/api/v5/test_commits.py
lit -sv tests/server/api/v5/test_integration.py
lit -sv tests/server/api/v5/test_machines.py
lit -sv tests/server/api/v5/test_discovery.py
```

### 7c. Verify deleted files don't break anything

```bash
# Should NOT find test_field_changes.py in tests
ls tests/server/api/v5/test_field_changes.py 2>&1 | grep "No such file"

# Should NOT find field_changes.py in endpoints
ls lnt/server/api/v5/endpoints/field_changes.py 2>&1 | grep "No such file"
```

### 7d. Verify no remaining FieldChange references in v5 code

```bash
grep -r "FieldChange\|field_change\|fieldchange" \
    lnt/server/api/v5/ tests/server/api/v5/ \
    --include="*.py" -l
```

This should return zero files after all changes are complete.

### 7e. Run the full v5 test suite

```bash
lit -sv tests/server/api/v5/
```

All tests should pass.

### 7f. Type checking

```bash
tox -e mypy
```

### 7g. Linting

```bash
tox -e flake8
```

---

## Summary of Changes by File

| File | Action |
|------|--------|
| `lnt/server/api/v5/endpoints/field_changes.py` | DELETE |
| `lnt/server/api/v5/schemas/regressions.py` | Rewrite (states, schemas) |
| `lnt/server/api/v5/endpoints/regressions.py` | Rewrite (endpoints, helpers) |
| `lnt/server/api/v5/helpers.py` | Remove `lookup_fieldchange`, `serialize_fieldchange` |
| `lnt/server/api/v5/endpoints/__init__.py` | Remove `field_changes` module |
| `lnt/server/api/v5/endpoints/test_suites.py` | Remove `field_changes` link |
| `lnt/server/api/v5/schemas/common.py` | Remove `field_changes` from schema |
| `lnt/server/api/v5/endpoints/machines.py` | Replace FieldChange cleanup with RegressionIndicator cleanup |
| `lnt/server/api/v5/endpoints/commits.py` | Update docstring |
| `lnt/server/api/v5/endpoints/agents.py` | Update llms.txt content |
| `tests/server/api/v5/test_field_changes.py` | DELETE |
| `tests/server/api/v5/v5_test_helpers.py` | Drop `create_fieldchange`, `submit_fieldchange`; rewrite `create_regression`, `submit_regression`; add indicator helpers |
| `tests/server/api/v5/test_regressions.py` | Comprehensive rewrite |
| `tests/server/api/v5/test_regression_state_mapping.py` | No changes (auto-adapts to new STATE_TO_DB) |
| `tests/server/api/v5/test_commits.py` | Replace FieldChange-based 409 test |
| `tests/server/api/v5/test_integration.py` | Remove `field_changes` from discovery links |
| `tests/server/api/v5/test_machines.py` | Rewrite `test_delete_machine_with_fieldchanges` for new indicator model |
| `tests/server/api/v5/test_discovery.py` | Remove `field_changes` from expected suite links set |

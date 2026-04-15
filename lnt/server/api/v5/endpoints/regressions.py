"""Regression endpoints for the v5 API.

GET    /api/v5/{ts}/regressions                     -- List
POST   /api/v5/{ts}/regressions                     -- Create
GET    /api/v5/{ts}/regressions/{uuid}              -- Detail
PATCH  /api/v5/{ts}/regressions/{uuid}              -- Update
DELETE /api/v5/{ts}/regressions/{uuid}              -- Delete
POST   /api/v5/{ts}/regressions/{uuid}/indicators   -- Add indicators (batch)
DELETE /api/v5/{ts}/regressions/{uuid}/indicators   -- Remove indicators (batch)
"""

from flask import g, jsonify, make_response
from flask.views import MethodView
from flask_smorest import Blueprint
from sqlalchemy.orm import joinedload, subqueryload

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

blp = Blueprint(
    'Regressions',
    __name__,
    url_prefix='/api/v5/<testsuite>',
    description='Triage performance regressions: create, update, delete, and manage indicators',
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _serialize_indicator(ri):
    """Serialize a RegressionIndicator into the API response dict."""
    return {
        'uuid': ri.uuid,
        'machine': ri.machine.name if ri.machine else None,
        'test': ri.test.name if ri.test else None,
        'metric': ri.metric,
    }


def _serialize_regression_base(regression):
    """Shared fields for both list and detail regression responses."""
    return {
        'uuid': regression.uuid,
        'title': regression.title,
        'bug': regression.bug,
        'state': state_to_api(regression.state),
        'commit': (regression.commit_obj.commit
                   if regression.commit_obj else None),
    }


def _serialize_regression_list(regression):
    """Serialize a Regression for the list endpoint.

    Requires the regression to have indicators eagerly loaded (or
    accessible) for computing machine_count and test_count.
    """
    machines = set()
    tests = set()
    for ri in regression.indicators:
        machines.add(ri.machine_id)
        tests.add(ri.test_id)

    result = _serialize_regression_base(regression)
    result['machine_count'] = len(machines)
    result['test_count'] = len(tests)
    return result


def _serialize_regression_detail(regression):
    """Serialize a Regression for the detail endpoint (with indicators)."""
    result = _serialize_regression_base(regression)
    result['notes'] = regression.notes
    result['indicators'] = [
        _serialize_indicator(ri) for ri in regression.indicators
    ]
    return result


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
    machine_cache = {}
    test_cache = {}
    for ind in indicator_dicts:
        m_name = ind['machine']
        if m_name not in machine_cache:
            machine_cache[m_name] = lookup_machine(session, ts, m_name)
        t_name = ind['test']
        if t_name not in test_cache:
            test_cache[t_name] = lookup_test(session, ts, t_name)
        validate_metric_name(ts, ind['metric'])
        resolved.append({
            'machine_id': machine_cache[m_name].id,
            'test_id': test_cache[t_name].id,
            'metric': ind['metric'],
        })
    return resolved


def _eager_load_regression(session, ts, regression_uuid):
    """Look up a regression by UUID with eager-loaded relationships.

    Loads indicators with their machine and test relationships for
    serialization. Aborts with 404 if not found.
    """
    reg = (
        session.query(ts.Regression)
        .populate_existing()
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


# ---------------------------------------------------------------------------
# Regression List / Create
# ---------------------------------------------------------------------------

@blp.route('/regressions')
class RegressionList(MethodView):
    """List and create regressions."""

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


# ---------------------------------------------------------------------------
# Regression Detail / Update / Delete
# ---------------------------------------------------------------------------

@blp.route('/regressions/<string:regression_uuid>')
class RegressionDetail(MethodView):
    """Regression detail, update, and delete."""

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

    @require_scope('triage')
    @blp.arguments(RegressionUpdateSchema)
    @blp.response(200, RegressionDetailSchema)
    def patch(self, body, testsuite, regression_uuid):
        """Update regression title, bug, notes, state, and/or commit."""
        ts = g.ts
        session = g.db_session
        regression = lookup_regression(session, ts, regression_uuid)

        # Fields present in body are updated; None values clear the field.
        # Fields absent from body are left unchanged.
        kwargs = {}

        if 'title' in body:
            kwargs['title'] = body['title']

        if 'bug' in body:
            kwargs['bug'] = body['bug']

        if 'notes' in body:
            kwargs['notes'] = body['notes']

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

    @require_scope('triage')
    @blp.response(204)
    def delete(self, testsuite, regression_uuid):
        """Delete a regression and its indicators."""
        ts = g.ts
        session = g.db_session
        regression = lookup_regression(session, ts, regression_uuid)
        ts.delete_regression(session, regression.id)
        return make_response('', 204)


# ---------------------------------------------------------------------------
# Indicators
# ---------------------------------------------------------------------------

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

        session.query(ts.RegressionIndicator).filter(
            ts.RegressionIndicator.regression_id == regression.id,
            ts.RegressionIndicator.uuid.in_(body['indicator_uuids']),
        ).delete(synchronize_session='fetch')
        session.flush()

        # Reload and return full detail
        regression = _eager_load_regression(
            session, ts, regression_uuid)
        return jsonify(_serialize_regression_detail(regression))

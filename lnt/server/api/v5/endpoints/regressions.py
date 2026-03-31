"""Regression endpoints for the v5 API.

GET    /api/v5/{ts}/regressions                              -- List
POST   /api/v5/{ts}/regressions                              -- Create
GET    /api/v5/{ts}/regressions/{uuid}                       -- Detail
PATCH  /api/v5/{ts}/regressions/{uuid}                       -- Update
DELETE /api/v5/{ts}/regressions/{uuid}                       -- Delete
POST   /api/v5/{ts}/regressions/{uuid}/merge                 -- Merge
POST   /api/v5/{ts}/regressions/{uuid}/split                 -- Split
GET    /api/v5/{ts}/regressions/{uuid}/indicators            -- List indicators
POST   /api/v5/{ts}/regressions/{uuid}/indicators            -- Add indicator
DELETE /api/v5/{ts}/regressions/{uuid}/indicators/{fc_uuid}  -- Remove indicator
"""

import uuid as uuid_module

from flask import g, jsonify, make_response
from flask.views import MethodView
from flask_smorest import Blueprint

from ..auth import require_scope
from ..errors import abort_with_error, reject_unknown_params
from ..helpers import (
    lookup_fieldchange,
    lookup_regression,
    resolve_metric,
    serialize_fieldchange,
)
from ..etag import add_etag_to_response
from ..pagination import (
    cursor_paginate,
    make_paginated_response,
)
from ..schemas.regressions import (
    IndicatorAddSchema,
    IndicatorResponseSchema,
    PaginatedIndicatorResponseSchema,
    PaginatedRegressionListSchema,
    RegressionCreateSchema,
    RegressionDetailSchema,
    RegressionIndicatorsQuerySchema,
    RegressionListQuerySchema,
    RegressionMergeSchema,
    RegressionSplitSchema,
    RegressionUpdateSchema,
    STATE_TO_DB,
    state_to_api,
    state_to_db,
)

blp = Blueprint(
    'Regressions',
    __name__,
    url_prefix='/api/v5/<testsuite>',
    description='Triage performance regressions: create, merge, split, and manage indicators',
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _serialize_indicator(ri, ts):
    """Serialize a RegressionIndicator into the API response dict."""
    fc = ri.field_change
    if fc is None:
        return None

    result = serialize_fieldchange(fc)
    result['field_change_uuid'] = fc.uuid
    return result


def _serialize_regression_list(regression):
    """Serialize a Regression for the list endpoint (no indicators)."""
    return {
        'uuid': regression.uuid,
        'title': regression.title,
        'bug': regression.bug,
        'state': state_to_api(regression.state),
    }


def _serialize_regression_detail(regression, session, ts):
    """Serialize a Regression for the detail endpoint (with indicators)."""
    indicators = session.query(ts.RegressionIndicator).filter(
        ts.RegressionIndicator.regression_id == regression.id
    ).all()

    serialized_indicators = []
    for ri in indicators:
        ind = _serialize_indicator(ri, ts)
        if ind is not None:
            serialized_indicators.append(ind)

    return {
        'uuid': regression.uuid,
        'title': regression.title,
        'bug': regression.bug,
        'state': state_to_api(regression.state),
        'indicators': serialized_indicators,
    }


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
            {'state', 'machine', 'test', 'metric', 'cursor', 'limit'})
        ts = g.ts
        session = g.db_session

        query = session.query(ts.Regression)

        # Filter by state (supports comma-separated values)
        state_values = query_args['state']
        if state_values:
            db_states = []
            for sv in state_values:
                db_val = state_to_db(sv)
                if db_val is None:
                    abort_with_error(
                        400,
                        "Invalid state '%s'. Valid states: %s"
                        % (sv, ', '.join(sorted(STATE_TO_DB.keys()))))
                db_states.append(db_val)
            query = query.filter(ts.Regression.state.in_(db_states))

        # Filter by machine, test, and/or metric name. All three need
        # the same base JOINs through indicators -> field changes.
        machine_name = query_args.get('machine')
        test_name = query_args.get('test')
        field_name = query_args.get('metric')

        # Resolve metric name to field ID (no DB query needed)
        matching_field = None
        if field_name:
            matching_field = resolve_metric(ts, field_name)

        if machine_name or test_name or field_name:
            query = query.join(
                ts.RegressionIndicator,
                ts.RegressionIndicator.regression_id == ts.Regression.id
            ).join(
                ts.FieldChange,
                ts.RegressionIndicator.field_change_id == ts.FieldChange.id
            )

        if machine_name:
            query = query.join(
                ts.Machine,
                ts.FieldChange.machine_id == ts.Machine.id
            ).filter(ts.Machine.name == machine_name)

        if test_name:
            query = query.join(
                ts.Test,
                ts.FieldChange.test_id == ts.Test.id
            ).filter(ts.Test.name == test_name)

        if field_name:
            query = query.filter(
                ts.FieldChange.field_id == matching_field.id)

        if machine_name or test_name or field_name:
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
        """Create a new regression from field changes."""
        ts = g.ts
        session = g.db_session

        fc_uuids = body['field_change_uuids']

        # Look up all field changes by UUID
        field_changes = []
        for fc_uuid in fc_uuids:
            fc = lookup_fieldchange(session, ts, fc_uuid)
            field_changes.append(fc)

        # Determine state
        state_str = body.get('state') or 'detected'
        db_state = state_to_db(state_str)
        if db_state is None:
            abort_with_error(
                400,
                "Invalid state '%s'. Valid states: %s"
                % (state_str, ', '.join(sorted(STATE_TO_DB.keys()))))

        # Create regression
        title = body.get('title') or 'Regression of %d benchmarks' % len(
            field_changes)
        bug = body.get('bug') or ''

        regression = ts.Regression(title, bug, db_state)
        regression.uuid = str(uuid_module.uuid4())
        session.add(regression)
        session.flush()

        # Add indicators
        for fc in field_changes:
            ri = ts.RegressionIndicator(regression, fc)
            session.add(ri)
        session.flush()

        result = _serialize_regression_detail(regression, session, ts)
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
        regression = lookup_regression(session, ts, regression_uuid)
        data = _serialize_regression_detail(regression, session, ts)
        return add_etag_to_response(jsonify(data), data)

    @require_scope('triage')
    @blp.arguments(RegressionUpdateSchema)
    @blp.response(200, RegressionDetailSchema)
    def patch(self, body, testsuite, regression_uuid):
        """Update regression title, bug URL, and/or state.

        Request body (all fields optional):
        {
            "title": "new title",
            "bug": "new bug URL",
            "state": "active"
        }
        """
        ts = g.ts
        session = g.db_session
        regression = lookup_regression(session, ts, regression_uuid)

        if 'title' in body:
            regression.title = body['title']

        if 'bug' in body:
            regression.bug = body['bug']

        if 'state' in body:
            db_state = state_to_db(body['state'])
            if db_state is None:
                abort_with_error(
                    400,
                    "Invalid state '%s'. Valid states: %s"
                    % (body['state'],
                       ', '.join(sorted(STATE_TO_DB.keys()))))
            regression.state = db_state

        session.flush()

        return jsonify(
            _serialize_regression_detail(regression, session, ts))

    @require_scope('triage')
    @blp.response(204)
    def delete(self, testsuite, regression_uuid):
        """Delete a regression and its indicators."""
        ts = g.ts
        session = g.db_session
        regression = lookup_regression(session, ts, regression_uuid)

        # Delete indicators first
        session.query(ts.RegressionIndicator).filter(
            ts.RegressionIndicator.regression_id == regression.id
        ).delete(synchronize_session='fetch')

        session.delete(regression)
        session.flush()

        return make_response('', 204)


# ---------------------------------------------------------------------------
# Merge
# ---------------------------------------------------------------------------

@blp.route('/regressions/<string:regression_uuid>/merge')
class RegressionMerge(MethodView):
    """Merge source regressions into the target regression."""

    @require_scope('triage')
    @blp.arguments(RegressionMergeSchema)
    @blp.response(200, RegressionDetailSchema)
    def post(self, body, testsuite, regression_uuid):
        """Merge source regressions into this one.

        The target absorbs all indicators from the source regressions.
        Sources are marked as ignored. Duplicate indicators are
        deduplicated.
        """
        ts = g.ts
        session = g.db_session
        target = lookup_regression(session, ts, regression_uuid)

        source_uuids = body['source_regression_uuids']

        # Validate: cannot merge into self
        for suuid in source_uuids:
            if suuid == regression_uuid:
                abort_with_error(
                    400, "Cannot merge a regression into itself")

        # Collect existing indicator field_change_ids for the target
        # (for deduplication)
        existing_fc_ids = set()
        target_indicators = session.query(ts.RegressionIndicator).filter(
            ts.RegressionIndicator.regression_id == target.id
        ).all()
        for ri in target_indicators:
            existing_fc_ids.add(ri.field_change_id)

        # Process each source regression
        sources = []
        for suuid in source_uuids:
            source = lookup_regression(session, ts, suuid)
            sources.append(source)

        for source in sources:
            # Move indicators from source to target (with dedup)
            source_indicators = session.query(ts.RegressionIndicator).filter(
                ts.RegressionIndicator.regression_id == source.id
            ).all()

            for ri in source_indicators:
                if ri.field_change_id not in existing_fc_ids:
                    ri.regression_id = target.id
                    ri.regression = target
                    existing_fc_ids.add(ri.field_change_id)
                else:
                    # Duplicate -- remove it
                    session.delete(ri)

            # Mark source as IGNORED
            source.state = STATE_TO_DB['ignored']

        session.flush()

        return jsonify(
            _serialize_regression_detail(target, session, ts))


# ---------------------------------------------------------------------------
# Split
# ---------------------------------------------------------------------------

@blp.route('/regressions/<string:regression_uuid>/split')
class RegressionSplit(MethodView):
    """Split field changes from a regression into a new regression."""

    @require_scope('triage')
    @blp.arguments(RegressionSplitSchema)
    @blp.response(201, RegressionDetailSchema)
    def post(self, body, testsuite, regression_uuid):
        """Split specified field changes into a new regression.

        At least one indicator must remain in the source regression.
        """
        ts = g.ts
        session = g.db_session
        source = lookup_regression(session, ts, regression_uuid)

        fc_uuids = body['field_change_uuids']

        # Get all current indicators for the source regression
        all_indicators = session.query(ts.RegressionIndicator).filter(
            ts.RegressionIndicator.regression_id == source.id
        ).all()

        # Build a map from field_change_id to indicator
        fc_id_to_ri = {}
        for ri in all_indicators:
            fc_id_to_ri[ri.field_change_id] = ri

        # Resolve the field change UUIDs to indicators
        indicators_to_move = []
        for fc_uuid in fc_uuids:
            fc = lookup_fieldchange(session, ts, fc_uuid)
            ri = fc_id_to_ri.get(fc.id)
            if ri is None:
                abort_with_error(
                    400,
                    "Field change '%s' is not an indicator of regression "
                    "'%s'" % (fc_uuid, regression_uuid))
            indicators_to_move.append(ri)

        # Validate: cannot split ALL indicators
        if len(indicators_to_move) >= len(all_indicators):
            abort_with_error(
                400,
                "Cannot split all indicators from a regression. "
                "At least one indicator must remain.")

        # Create new regression
        new_regression = ts.Regression(
            source.title, source.bug or '', source.state)
        new_regression.uuid = str(uuid_module.uuid4())
        session.add(new_regression)
        session.flush()

        # Move indicators to the new regression
        for ri in indicators_to_move:
            ri.regression_id = new_regression.id
            ri.regression = new_regression

        session.flush()

        return jsonify(
            _serialize_regression_detail(new_regression, session, ts)), 201


# ---------------------------------------------------------------------------
# Indicators
# ---------------------------------------------------------------------------

@blp.route('/regressions/<string:regression_uuid>/indicators')
class RegressionIndicators(MethodView):
    """List and add indicators for a regression."""

    @require_scope('read')
    @blp.arguments(RegressionIndicatorsQuerySchema, location="query")
    @blp.response(200, PaginatedIndicatorResponseSchema)
    def get(self, query_args, testsuite, regression_uuid):
        """List indicators for a regression (cursor-paginated)."""
        reject_unknown_params({'cursor', 'limit'})
        ts = g.ts
        session = g.db_session
        regression = lookup_regression(session, ts, regression_uuid)

        query = session.query(ts.RegressionIndicator).filter(
            ts.RegressionIndicator.regression_id == regression.id
        )

        cursor_str = query_args.get('cursor')
        limit = query_args['limit']
        items, next_cursor = cursor_paginate(
            query, ts.RegressionIndicator.id, cursor_str, limit)

        serialized = []
        for ri in items:
            ind = _serialize_indicator(ri, ts)
            if ind is not None:
                serialized.append(ind)

        return jsonify(make_paginated_response(serialized, next_cursor))

    @require_scope('triage')
    @blp.arguments(IndicatorAddSchema)
    @blp.response(201, IndicatorResponseSchema)
    def post(self, body, testsuite, regression_uuid):
        """Add a field change as an indicator to this regression.

        Request body:
        {"field_change_uuid": "..."}
        """
        ts = g.ts
        session = g.db_session
        regression = lookup_regression(session, ts, regression_uuid)

        fc_uuid = body['field_change_uuid']
        fc = lookup_fieldchange(session, ts, fc_uuid)

        # Check for duplicate
        existing = session.query(ts.RegressionIndicator).filter(
            ts.RegressionIndicator.regression_id == regression.id,
            ts.RegressionIndicator.field_change_id == fc.id,
        ).first()
        if existing:
            abort_with_error(
                409,
                "Field change '%s' is already an indicator of this "
                "regression" % fc_uuid)

        ri = ts.RegressionIndicator(regression, fc)
        session.add(ri)
        session.flush()

        result = _serialize_indicator(ri, ts)
        resp = jsonify(result)
        resp.status_code = 201
        return resp


@blp.route(
    '/regressions/<string:regression_uuid>/indicators/<string:fc_uuid>')
class RegressionIndicatorRemove(MethodView):
    """Remove a field change indicator from a regression."""

    @require_scope('triage')
    @blp.response(204)
    def delete(self, testsuite, regression_uuid, fc_uuid):
        """Remove a field change indicator from a regression."""
        ts = g.ts
        session = g.db_session
        regression = lookup_regression(session, ts, regression_uuid)

        # Find the field change by UUID
        fc = session.query(ts.FieldChange).filter(
            ts.FieldChange.uuid == fc_uuid
        ).first()
        if fc is None:
            abort_with_error(
                404, "Field change '%s' not found" % fc_uuid)

        # Find the indicator linking this field change to this regression
        ri = session.query(ts.RegressionIndicator).filter(
            ts.RegressionIndicator.regression_id == regression.id,
            ts.RegressionIndicator.field_change_id == fc.id,
        ).first()
        if ri is None:
            abort_with_error(
                404,
                "Field change '%s' is not an indicator of regression "
                "'%s'" % (fc_uuid, regression_uuid))

        session.delete(ri)
        session.flush()

        return make_response('', 204)

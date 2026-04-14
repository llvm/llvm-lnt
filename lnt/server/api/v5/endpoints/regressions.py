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

from flask import g, jsonify, make_response
from flask.views import MethodView
from flask_smorest import Blueprint
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import joinedload

from ..auth import require_scope
from ..errors import abort_with_error, reject_unknown_params
from ..helpers import (
    lookup_fieldchange,
    lookup_machine,
    lookup_regression,
    lookup_test,
    serialize_fieldchange,
    validate_metric_name,
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

def _fc_load_branches(base, ts):
    """Append FieldChange relationship loads to a joinedload base."""
    return [
        base.joinedload(ts.FieldChange.test),
        base.joinedload(ts.FieldChange.machine),
        base.joinedload(ts.FieldChange.start_commit),
        base.joinedload(ts.FieldChange.end_commit),
    ]


def _indicator_load_options(ts):
    """Return joinedload options for eager-loading indicator relationships."""
    base = joinedload(ts.Regression.indicators) \
        .joinedload(ts.RegressionIndicator.field_change)
    return _fc_load_branches(base, ts)


def _indicator_query_options(ts):
    """Return joinedload options for a RegressionIndicator query."""
    base = joinedload(ts.RegressionIndicator.field_change)
    return _fc_load_branches(base, ts)


def _serialize_indicator(ri):
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


def _serialize_regression_detail(regression):
    """Serialize a Regression for the detail endpoint (with indicators).

    Requires indicators to be eager-loaded via _indicator_load_options().
    """
    serialized_indicators = []
    for ri in regression.indicators:
        ind = _serialize_indicator(ri)
        if ind is not None:
            serialized_indicators.append(ind)

    return {
        'uuid': regression.uuid,
        'title': regression.title,
        'bug': regression.bug,
        'state': state_to_api(regression.state),
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


def _lookup_regression_with_indicators(session, ts, regression_uuid):
    """Look up a regression by UUID with eager-loaded indicators.

    Aborts with 404 if not found.
    """
    reg = session.query(ts.Regression) \
        .options(*_indicator_load_options(ts)) \
        .filter(ts.Regression.uuid == regression_uuid) \
        .first()
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
            {'state', 'machine', 'test', 'metric', 'cursor', 'limit'})
        ts = g.ts
        session = g.db_session

        query = session.query(ts.Regression)

        state_values = query_args['state']
        if state_values:
            db_states = [_validate_state(sv) for sv in state_values]
            query = query.filter(ts.Regression.state.in_(db_states))

        machine_name = query_args.get('machine')
        test_name = query_args.get('test')
        field_name = query_args.get('metric')

        # Validate entity names before building JOINs (404/400 on bad names)
        machine = None
        if machine_name:
            machine = lookup_machine(session, ts, machine_name)
        test = None
        if test_name:
            test = lookup_test(session, ts, test_name)
        if field_name:
            validate_metric_name(ts, field_name)

        if machine or test or field_name:
            query = query.join(
                ts.RegressionIndicator,
                ts.RegressionIndicator.regression_id == ts.Regression.id
            ).join(
                ts.FieldChange,
                ts.RegressionIndicator.field_change_id == ts.FieldChange.id
            )

        if machine:
            query = query.filter(
                ts.FieldChange.machine_id == machine.id)

        if test:
            query = query.filter(
                ts.FieldChange.test_id == test.id)

        if field_name:
            query = query.filter(
                ts.FieldChange.field_name == field_name)

        if machine or test or field_name:
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
        field_changes = [lookup_fieldchange(session, ts, u) for u in fc_uuids]

        state_str = body.get('state') or 'detected'
        db_state = _validate_state(state_str)

        title = body.get('title') or 'Regression of %d benchmarks' % len(
            field_changes)
        bug = body.get('bug') or ''

        regression = ts.create_regression(
            session, title, [fc.id for fc in field_changes],
            bug=bug, state=db_state)

        # Reload with eager-loaded indicators for serialization
        regression = _lookup_regression_with_indicators(
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
        regression = _lookup_regression_with_indicators(
            session, ts, regression_uuid)
        data = _serialize_regression_detail(regression)
        return add_etag_to_response(jsonify(data), data)

    @require_scope('triage')
    @blp.arguments(RegressionUpdateSchema)
    @blp.response(200, RegressionDetailSchema)
    def patch(self, body, testsuite, regression_uuid):
        """Update regression title, bug URL, and/or state."""
        ts = g.ts
        session = g.db_session
        regression = _lookup_regression_with_indicators(
            session, ts, regression_uuid)

        title = body.get('title')
        bug = body.get('bug')
        state = None
        if 'state' in body:
            state = _validate_state(body['state'])

        ts.update_regression(
            session, regression, title=title, bug=bug, state=state)

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

        for suuid in source_uuids:
            if suuid == regression_uuid:
                abort_with_error(
                    400, "Cannot merge a regression into itself")

        # Collect existing indicator field_change_ids for deduplication
        existing_fc_ids = set()
        target_indicators = session.query(ts.RegressionIndicator).filter(
            ts.RegressionIndicator.regression_id == target.id
        ).all()
        for ri in target_indicators:
            existing_fc_ids.add(ri.field_change_id)

        sources = [lookup_regression(session, ts, u) for u in source_uuids]

        for source in sources:
            source_indicators = session.query(ts.RegressionIndicator).filter(
                ts.RegressionIndicator.regression_id == source.id
            ).all()

            for ri in source_indicators:
                if ri.field_change_id not in existing_fc_ids:
                    ri.regression_id = target.id
                    existing_fc_ids.add(ri.field_change_id)
                else:
                    session.delete(ri)

            ts.update_regression(
                session, source, state=STATE_TO_DB['ignored'])

        session.flush()

        # Reload with eager-loaded indicators for serialization
        target = _lookup_regression_with_indicators(
            session, ts, regression_uuid)
        return jsonify(_serialize_regression_detail(target))


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

        all_indicators = session.query(ts.RegressionIndicator).filter(
            ts.RegressionIndicator.regression_id == source.id
        ).all()

        fc_id_to_ri = {ri.field_change_id: ri for ri in all_indicators}

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

        if len(indicators_to_move) >= len(all_indicators):
            abort_with_error(
                400,
                "Cannot split all indicators from a regression. "
                "At least one indicator must remain.")

        # Create new regression (empty indicators, then move them)
        new_regression = ts.create_regression(
            session, source.title, [], bug=source.bug or '',
            state=source.state)

        for ri in indicators_to_move:
            ri.regression_id = new_regression.id

        session.flush()

        # Reload with eager-loaded indicators for serialization
        new_regression = _lookup_regression_with_indicators(
            session, ts, new_regression.uuid)
        return jsonify(
            _serialize_regression_detail(new_regression)), 201


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

        query = session.query(ts.RegressionIndicator) \
            .options(*_indicator_query_options(ts)) \
            .filter(
                ts.RegressionIndicator.regression_id == regression.id)

        cursor_str = query_args.get('cursor')
        limit = query_args['limit']
        items, next_cursor = cursor_paginate(
            query, ts.RegressionIndicator.id, cursor_str, limit)

        serialized = []
        for ri in items:
            ind = _serialize_indicator(ri)
            if ind is not None:
                serialized.append(ind)

        return jsonify(make_paginated_response(serialized, next_cursor))

    @require_scope('triage')
    @blp.arguments(IndicatorAddSchema)
    @blp.response(201, IndicatorResponseSchema)
    def post(self, body, testsuite, regression_uuid):
        """Add a field change as an indicator to this regression."""
        ts = g.ts
        session = g.db_session
        regression = lookup_regression(session, ts, regression_uuid)

        fc_uuid = body['field_change_uuid']
        fc = lookup_fieldchange(session, ts, fc_uuid)

        try:
            ri = ts.add_regression_indicator(session, regression, fc)
        except IntegrityError:
            session.rollback()
            abort_with_error(
                409,
                "Field change '%s' is already an indicator of this "
                "regression" % fc_uuid)

        result = _serialize_indicator(ri)
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
        fc = lookup_fieldchange(session, ts, fc_uuid)

        removed = ts.remove_regression_indicator(
            session, regression.id, fc.id)
        if not removed:
            abort_with_error(
                404,
                "Field change '%s' is not an indicator of regression "
                "'%s'" % (fc_uuid, regression_uuid))

        return make_response('', 204)

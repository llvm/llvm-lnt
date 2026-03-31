"""Run endpoints for the v5 API.

GET    /api/v5/{ts}/runs                -- List runs (cursor-paginated)
POST   /api/v5/{ts}/runs                -- Submit run (reuses import pipeline)
GET    /api/v5/{ts}/runs/{uuid}         -- Run detail
DELETE /api/v5/{ts}/runs/{uuid}         -- Delete run
"""

import json

import lnt.util.ImportData
from flask import current_app, g, jsonify, make_response, request
from flask.views import MethodView
from flask_smorest import Blueprint
from sqlalchemy.orm import joinedload

from ..auth import require_scope
from ..errors import abort_with_error, reject_unknown_params
from ..etag import add_etag_to_response
from ..helpers import parse_datetime, serialize_run
from ..pagination import (
    cursor_paginate,
    make_paginated_response,
)
from ..schemas.runs import (
    PaginatedRunResponseSchema,
    RunListQuerySchema,
    RunResponseSchema,
    RunSubmitQuerySchema,
    RunSubmitResponseSchema,
)

# Maps v5 on_machine_conflict values to internal select_machine values.
_CONFLICT_MAP = {'reject': 'match', 'update': 'update'}

# Maps v5 on_existing_run values to internal merge_run values.
_MERGE_MAP = {'reject': 'reject', 'replace': 'replace', 'create': 'append'}

blp = Blueprint(
    'Runs',
    __name__,
    url_prefix='/api/v5/<testsuite>',
    description='Submit, list, inspect, and delete test runs',
)


@blp.route('/runs')
class RunList(MethodView):
    """List runs and submit new runs."""

    @require_scope('read')
    @blp.arguments(RunListQuerySchema, location="query")
    @blp.response(200, PaginatedRunResponseSchema)
    def get(self, query_args, testsuite):
        """List runs (cursor-paginated, filterable)."""
        reject_unknown_params(
            {'machine', 'order', 'after', 'before', 'sort', 'cursor', 'limit'})
        ts = g.ts
        session = g.db_session

        query = session.query(ts.Run).options(
            joinedload(ts.Run.machine),
            joinedload(ts.Run.order),
        )

        # Filter by machine name
        machine_name = query_args.get('machine')
        if machine_name:
            machine = session.query(ts.Machine).filter(
                ts.Machine.name == machine_name
            ).first()
            if machine is None:
                return jsonify(make_paginated_response([], None))
            query = query.filter(ts.Run.machine_id == machine.id)

        # Filter by order (primary order field value)
        order_value = query_args.get('order')
        if order_value:
            # Look up orders matching the primary field value
            primary_field = ts.order_fields[0]
            matching_orders = session.query(ts.Order).filter(
                primary_field.column == order_value
            ).all()
            if not matching_orders:
                return jsonify(make_paginated_response([], None))
            order_ids = [o.id for o in matching_orders]
            query = query.filter(ts.Run.order_id.in_(order_ids))

        # Filter by after/before datetime
        after_str = query_args.get('after')
        if after_str:
            after_dt = parse_datetime(after_str)
            if after_dt is None:
                abort_with_error(400, "Invalid 'after' datetime format")
            query = query.filter(ts.Run.start_time > after_dt)

        before_str = query_args.get('before')
        if before_str:
            before_dt = parse_datetime(before_str)
            if before_dt is None:
                abort_with_error(400, "Invalid 'before' datetime format")
            query = query.filter(ts.Run.start_time < before_dt)

        # Sort: default is ascending by ID (insertion order).
        sort = query_args.get('sort')
        descending = (sort == '-start_time')

        cursor_str = query_args.get('cursor')
        limit = query_args['limit']
        items, next_cursor = cursor_paginate(
            query, ts.Run.id, cursor_str, limit, descending=descending)

        serialized = [serialize_run(run, ts) for run in items]
        return jsonify(make_paginated_response(serialized, next_cursor))

    @require_scope('submit')
    @blp.arguments(RunSubmitQuerySchema, location="query")
    @blp.response(201, RunSubmitResponseSchema)
    def post(self, query_args, testsuite):
        """Submit a new run.

        Accepts the LNT JSON report format (format_version '2' only).
        Legacy formats (v0, v1) and non-JSON payloads (e.g. plist)
        are rejected. A UUID is assigned to the run automatically.

        Regression detection is always skipped; create field changes
        separately via POST /field-changes.
        """
        reject_unknown_params({'on_machine_conflict', 'on_existing_run'})
        db = g.db
        session = g.db_session

        data = request.get_data(as_text=True)
        if not data or not data.strip():
            abort_with_error(400, "Request body must be a non-empty JSON payload")

        # Mandate JSON format with format_version '2' for the v5 API.
        try:
            parsed = json.loads(data)
        except ValueError as exc:
            abort_with_error(400, "Request body is not valid JSON: %s" % exc)
        if not isinstance(parsed, dict):
            abort_with_error(400, "Request body must be a JSON object, "
                             "not %s" % type(parsed).__name__)
        version = parsed.get('format_version')
        if version is None:
            abort_with_error(400, "v5 API requires format_version '2', "
                             "but it is missing")
        if version != '2':
            abort_with_error(400, "v5 API requires format_version '2', "
                             "got %r" % (version,))

        select_machine = _CONFLICT_MAP[query_args['on_machine_conflict']]
        merge_run = _MERGE_MAP[query_args['on_existing_run']]

        result = lnt.util.ImportData.import_from_string(
            current_app.old_config, g.db_name, db, session,
            testsuite, data,
            select_machine=select_machine,
            merge_run=merge_run,
            ignore_regressions=True,
        )

        error = result.get('error')
        if error is not None:
            abort_with_error(400, str(error))

        # The import pipeline assigned a UUID in _getOrCreateRun().
        # Retrieve the run to get its UUID.
        run_id = result.get('run_id')
        if run_id is None:
            abort_with_error(500, "Import succeeded but no run_id returned")

        # Re-query to get the UUID (the session may have committed already).
        ts = db.testsuite.get(testsuite)
        if ts is None:
            abort_with_error(500, "Testsuite not found after import")

        run = session.query(ts.Run).filter(ts.Run.id == run_id).first()
        if run is None:
            abort_with_error(500, "Run not found after import")

        run_uuid = run.uuid

        result_url = '/api/v5/%s/runs/%s' % (testsuite, run_uuid)

        response = jsonify({
            'success': True,
            'run_uuid': run_uuid,
            'result_url': result_url,
        })
        response.status_code = 201
        response.headers['Location'] = result_url
        return response


@blp.route('/runs/<string:run_uuid>')
class RunDetail(MethodView):
    """Run detail and deletion."""

    @require_scope('read')
    @blp.response(200, RunResponseSchema)
    def get(self, testsuite, run_uuid):
        """Get run detail by UUID."""
        reject_unknown_params(set())
        ts = g.ts
        session = g.db_session

        run = session.query(ts.Run).options(
            joinedload(ts.Run.machine),
            joinedload(ts.Run.order),
        ).filter(ts.Run.uuid == run_uuid).first()

        if run is None:
            abort_with_error(404, "Run '%s' not found" % run_uuid)

        data = serialize_run(run, ts)
        return add_etag_to_response(jsonify(data), data)

    @require_scope('manage')
    @blp.response(204)
    def delete(self, testsuite, run_uuid):
        """Delete a run and all associated samples."""
        ts = g.ts
        session = g.db_session

        run = session.query(ts.Run).filter(
            ts.Run.uuid == run_uuid
        ).first()

        if run is None:
            abort_with_error(404, "Run '%s' not found" % run_uuid)

        session.delete(run)
        session.flush()

        return make_response('', 204)

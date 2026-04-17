"""Run endpoints for the v5 API.

GET    /api/v5/{ts}/runs                -- List runs (cursor-paginated)
POST   /api/v5/{ts}/runs                -- Submit run (v5 format)
GET    /api/v5/{ts}/runs/{uuid}         -- Run detail
DELETE /api/v5/{ts}/runs/{uuid}         -- Delete run
"""

from flask import g, jsonify, make_response
from flask.views import MethodView
from flask_smorest import Blueprint
from sqlalchemy.orm import joinedload

from ..auth import require_scope
from ..errors import abort_with_error, reject_unknown_params
from ..etag import add_etag_to_response
from ..helpers import dump_response, lookup_run_by_uuid, parse_datetime, serialize_run
from ..pagination import (
    cursor_paginate,
    make_paginated_response,
)
from ..schemas.runs import (
    PaginatedRunResponseSchema,
    RunListQuerySchema,
    RunResponseSchema,
    RunSubmitBodySchema,
    RunSubmitQuerySchema,
    RunSubmitResponseSchema,
)

_run_submit_schema = RunSubmitResponseSchema()

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
            {'machine', 'commit', 'after', 'before', 'sort',
             'cursor', 'limit'})
        ts = g.ts
        session = g.db_session

        query = session.query(ts.Run).options(
            joinedload(ts.Run.machine),
            joinedload(ts.Run.commit_obj),
        )

        # Filter by machine name
        machine_name = query_args.get('machine')
        if machine_name:
            machine = ts.get_machine(session, name=machine_name)
            if machine is None:
                return jsonify(make_paginated_response([], None))
            query = query.filter(ts.Run.machine_id == machine.id)

        # Filter by commit string
        commit_value = query_args.get('commit')
        if commit_value:
            commit_obj = ts.get_commit(session, commit=commit_value)
            if commit_obj is None:
                return jsonify(make_paginated_response([], None))
            query = query.filter(ts.Run.commit_id == commit_obj.id)

        # Filter by after/before datetime
        after_str = query_args.get('after')
        if after_str:
            after_dt = parse_datetime(after_str)
            if after_dt is None:
                abort_with_error(400, "Invalid 'after' datetime format")
            query = query.filter(ts.Run.submitted_at > after_dt)

        before_str = query_args.get('before')
        if before_str:
            before_dt = parse_datetime(before_str)
            if before_dt is None:
                abort_with_error(400, "Invalid 'before' datetime format")
            query = query.filter(ts.Run.submitted_at < before_dt)

        # Sort: default is ascending by ID (insertion order).
        sort = query_args.get('sort')
        descending = (sort == '-submitted_at')

        cursor_str = query_args.get('cursor')
        limit = query_args['limit']
        items, next_cursor = cursor_paginate(
            query, ts.Run.id, cursor_str, limit, descending=descending)

        serialized = [serialize_run(run, ts) for run in items]
        return jsonify(make_paginated_response(serialized, next_cursor))

    @require_scope('submit')
    @blp.arguments(RunSubmitQuerySchema, location="query")
    @blp.arguments(RunSubmitBodySchema)
    @blp.response(201, RunSubmitResponseSchema)
    def post(self, query_args, body, testsuite):
        """Submit a new run.

        Accepts the v5 JSON report format (format_version '5').
        Regression detection is external; create regressions
        separately via POST /regressions.
        """
        reject_unknown_params({'on_machine_conflict'})
        ts = g.ts
        session = g.db_session

        version = body.get('format_version')
        if version is None:
            abort_with_error(400, "v5 API requires format_version '5', "
                             "but it is missing")
        if version != '5':
            abort_with_error(400, "v5 API requires format_version '5', "
                             "got %r" % (version,))

        try:
            run = ts.import_run(
                session, body,
                machine_strategy=query_args['on_machine_conflict'])
        except ValueError as exc:
            abort_with_error(400, str(exc))

        session.flush()

        run_uuid = run.uuid
        result_url = '/api/v5/%s/runs/%s' % (testsuite, run_uuid)

        response = jsonify(dump_response(_run_submit_schema, {
            'success': True,
            'run_uuid': run_uuid,
            'result_url': result_url,
        }))
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
            joinedload(ts.Run.commit_obj),
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

        run = lookup_run_by_uuid(session, ts, run_uuid)

        ts.delete_run(session, run.id)
        session.flush()

        return make_response('', 204)

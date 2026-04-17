"""Trends endpoint for the v5 API.

POST /api/v5/{ts}/trends
  Body (JSON): {metric, machine, after_time, before_time}

Returns server-side geomean-aggregated trend data for the Dashboard.
The metric field is required; all other fields are optional.
"""

from flask import g, jsonify
from flask.views import MethodView
from flask_smorest import Blueprint

from ..auth import require_scope
from ..errors import abort_with_error
from ..helpers import format_utc, get_metric_def, lookup_machine, parse_datetime
from ..schemas.trends import TrendsQuerySchema, TrendsResponseSchema

blp = Blueprint(
    'Trends',
    __name__,
    url_prefix='/api/v5/<testsuite>',
    description='Geomean-aggregated trend data for the Dashboard',
)


@blp.route('/trends')
class TrendsView(MethodView):
    """Geomean-aggregated trend data."""

    @require_scope('read')
    @blp.arguments(TrendsQuerySchema, location="json")
    @blp.response(200, TrendsResponseSchema)
    def post(self, query_args, testsuite):
        """Query geomean-aggregated trend data.

        Returns trend data points grouped by (machine, commit) with
        the geometric mean of all positive sample values within each
        group.
        """
        ts = g.ts
        session = g.db_session

        metric = query_args['metric']
        machine_names = query_args.get('machine', [])

        metric_def = get_metric_def(ts, metric)
        if metric_def.type != 'real':
            abort_with_error(
                400, "Metric '%s' has type '%s'; trends requires a "
                "'real' type metric" % (metric, metric_def.type))

        machine_ids = []
        for name in machine_names:
            machine = lookup_machine(session, ts, name)
            machine_ids.append(machine.id)

        after_time = None
        after_time_str = query_args.get('after_time')
        if after_time_str:
            after_time = parse_datetime(after_time_str)
            if after_time is None:
                abort_with_error(
                    400, "Invalid after_time format, expected ISO 8601")

        before_time = None
        before_time_str = query_args.get('before_time')
        if before_time_str:
            before_time = parse_datetime(before_time_str)
            if before_time is None:
                abort_with_error(
                    400, "Invalid before_time format, expected ISO 8601")

        results = ts.query_trends(
            session, metric,
            machine_ids=machine_ids or None,
            after_time=after_time,
            before_time=before_time,
        )

        items = []
        for r in results:
            items.append({
                'machine': r['machine_name'],
                'commit': r['commit'],
                'ordinal': r['ordinal'],
                'value': r['value'],
                'submitted_at': format_utc(r['submitted_at']),
            })

        return jsonify({'metric': metric, 'items': items})

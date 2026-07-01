"""Trends endpoint for the v5 API.

POST /api/v5/{ts}/trends
  Body (JSON): {metric, machine, last_n}

Returns server-side geomean-aggregated trend data for the Dashboard.
The metric field is required; all other fields are optional.
"""

from flask import g, jsonify
from flask.views import MethodView
from flask_smorest import Blueprint

from ..auth import require_scope
from ..errors import abort_with_error
from ..helpers import dump_response, format_utc, get_metric_def, lookup_machine
from ..schemas.trends import TrendsItemSchema, TrendsQuerySchema, TrendsResponseSchema

_trends_item_schema = TrendsItemSchema()

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
        group.  Only commits with a non-null ordinal are included.
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

        last_n = query_args.get('last_n')

        results = ts.query_trends(
            session, metric,
            machine_ids=machine_ids or None,
            last_n=last_n,
        )

        items = []
        for r in results:
            items.append(dump_response(_trends_item_schema, {
                'machine': r['machine_name'],
                'commit': r['commit'],
                'ordinal': r['ordinal'],
                'tag': r['tag'],
                'value': r['value'],
                'submitted_at': format_utc(r['submitted_at']),
            }))

        return jsonify({'metric': metric, 'items': items})

"""Trends endpoint for the v5 API.

POST /api/v5/{ts}/trends
  Body (JSON): {metric, machine, after_time, before_time}

Returns server-side geomean-aggregated trend data for the Dashboard.
The metric field is required; all other fields are optional.
"""

import math

from flask import g, jsonify
from flask.views import MethodView
from flask_smorest import Blueprint

from lnt.testing import PASS

from ..auth import require_scope
from ..errors import abort_with_error
from ..helpers import lookup_machine, parse_datetime, resolve_metric, \
    serialize_order
from ..schemas.trends import TrendsQuerySchema, TrendsResponseSchema

blp = Blueprint(
    'Trends',
    __name__,
    url_prefix='/api/v5/<testsuite>',
    description='Geomean-aggregated trend data for the Dashboard',
)


def _compute_trends(session, ts, sample_field, machine_ids,
                    after_time, before_time):
    """Build and execute a trends query, returning geomean-aggregated items.

    Groups all samples by (machine, order) and computes the geometric mean
    of positive sample values within each group.
    """
    q = session.query(
        sample_field.column,
        ts.Order,
        ts.Run.start_time,
        ts.Machine.id,
        ts.Machine.name,
        # Without Sample.id, SQLAlchemy deduplicates rows where all selected
        # columns match (e.g. two tests with the same metric value at the
        # same order), which silently drops samples from the geomean.
        ts.Sample.id,
    ).select_from(ts.Sample) \
        .join(ts.Run) \
        .join(ts.Order) \
        .join(ts.Machine, ts.Run.machine_id == ts.Machine.id) \
        .filter(sample_field.column.isnot(None))

    if sample_field.status_field:
        q = q.filter(
            (sample_field.status_field.column == PASS) |
            (sample_field.status_field.column.is_(None))
        )

    if machine_ids:
        q = q.filter(ts.Machine.id.in_(machine_ids))
    if after_time:
        q = q.filter(ts.Run.start_time > after_time)
    if before_time:
        q = q.filter(ts.Run.start_time < before_time)

    rows = q.all()

    # Group by (machine_id, order_id), compute geomean
    groups = {}
    for value, order, start_time, machine_id, machine_name, _sample_id in rows:
        key = (machine_id, order.id)
        if key not in groups:
            groups[key] = {
                'machine_name': machine_name,
                'order': order,
                'values': [],
                'timestamp': start_time,
            }
        grp = groups[key]
        grp['values'].append(value)
        if start_time and (not grp['timestamp'] or
                           start_time > grp['timestamp']):
            grp['timestamp'] = start_time

    items = []
    for grp in groups.values():
        positive = [v for v in grp['values'] if v is not None and v > 0]
        if not positive:
            continue
        gm = math.exp(math.fsum(math.log(v) for v in positive) / len(positive))

        items.append({
            'machine': grp['machine_name'],
            'order': serialize_order(grp['order']),
            'timestamp': (grp['timestamp'].isoformat()
                          if grp['timestamp'] else None),
            'value': gm,
        })

    items.sort(key=lambda x: (x['machine'], x['timestamp'] or ''))
    return items


@blp.route('/trends')
class TrendsView(MethodView):
    """Geomean-aggregated trend data."""

    @require_scope('read')
    @blp.arguments(TrendsQuerySchema, location="json")
    @blp.response(200, TrendsResponseSchema)
    def post(self, query_args, testsuite):
        """Query geomean-aggregated trend data.

        Returns trend data points grouped by (machine, order) with
        the geometric mean of all positive sample values within each
        group.
        """
        ts = g.ts
        session = g.db_session

        field_name = query_args['metric']
        machine_names = query_args.get('machine', [])

        field = resolve_metric(ts, field_name)

        # Geomean only makes sense for numeric metrics.
        if field.type.name not in ('Real', 'Integer'):
            abort_with_error(
                400, "Metric '%s' has type '%s'; trends requires a "
                "numeric metric (Real or Integer)" % (field_name,
                                                      field.type.name))

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

        items = _compute_trends(
            session, ts, field, machine_ids, after_time, before_time)

        return jsonify({'metric': field_name, 'items': items})

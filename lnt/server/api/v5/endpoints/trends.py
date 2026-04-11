"""Trends endpoint for the v5 API.

POST /api/v5/{ts}/trends
  Body (JSON): {metric, machine, after_time, before_time}

Returns server-side geomean-aggregated trend data for the Dashboard.
The metric field is required; all other fields are optional.
"""

from sqlalchemy import func

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
    of positive sample values within each group using SQL-level aggregation:
    exp(avg(ln(value))).
    """
    q = session.query(
        ts.Machine.name,
        ts.Order.id,
        func.exp(func.avg(func.ln(sample_field.column))),
        func.max(ts.Run.start_time),
    ).select_from(ts.Sample) \
        .join(ts.Run) \
        .join(ts.Order) \
        .join(ts.Machine, ts.Run.machine_id == ts.Machine.id) \
        .filter(sample_field.column > 0)

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

    q = q.group_by(ts.Machine.name, ts.Order.id) \
        .order_by(ts.Machine.name, func.max(ts.Run.start_time))
    rows = q.all()

    # Batch-load the unique Order objects needed for serialization.
    order_ids = {row[1] for row in rows}
    orders_by_id = {}
    if order_ids:
        orders_by_id = {
            o.id: o for o in
            session.query(ts.Order)
            .filter(ts.Order.id.in_(order_ids)).all()
        }

    items = []
    for machine_name, order_id, geomean_val, max_time in rows:
        items.append({
            'machine': machine_name,
            'order': serialize_order(orders_by_id.get(order_id)),
            'timestamp': (max_time.isoformat() if max_time else None),
            'value': geomean_val,
        })

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

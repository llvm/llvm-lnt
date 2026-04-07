"""Query endpoint for the v5 API.

GET /api/v5/{ts}/query?metric={name}&machine={name}&test={name}
                      &order={order}
                      &after_order={order}&before_order={order}
                      &after_time={iso8601}&before_time={iso8601}
                      &sort={fields}&limit={n}&cursor={c}

Returns cursor-paginated data points. The metric parameter is required;
all other filter parameters are optional.
"""

import base64

from flask import g, jsonify
from flask.views import MethodView
from flask_smorest import Blueprint
from sqlalchemy import and_, or_

from lnt.testing import PASS

from ..auth import require_scope
from ..errors import abort_with_error, reject_unknown_params
from ..helpers import parse_datetime, resolve_metric
from ..pagination import make_paginated_response
from ..schemas.query import QueryEndpointQuerySchema, QueryResponseSchema

blp = Blueprint(
    'Query',
    __name__,
    url_prefix='/api/v5/<testsuite>',
    description='Query time-series performance data across machines, tests, and metrics',
)

# Default and maximum page sizes.
_DEFAULT_LIMIT = 100
_MAX_LIMIT = 10000

# Valid query parameter names for the /query endpoint.
_VALID_QUERY_PARAMS = {
    'machine', 'test', 'metric', 'order',
    'after_order', 'before_order', 'after_time', 'before_time',
    'sort', 'limit', 'cursor',
}

# Allowed sort field names and the columns they map to.
# The actual column references are resolved at query time since the
# model classes are dynamic per test suite.
_ALLOWED_SORT_FIELDS = {'test', 'order', 'timestamp'}


def _parse_sort(sort_str):
    """Parse a comma-separated sort string into (field_name, ascending) pairs.

    Examples:
        "test,order"     -> [("test", True), ("order", True)]
        "-timestamp,test" -> [("timestamp", False), ("test", True)]

    Returns a list of (field_name, ascending) tuples, or None on error.
    """
    if not sort_str:
        return [('order', True), ('test', True)]

    result = []
    seen = set()
    for part in sort_str.split(','):
        part = part.strip()
        if not part:
            continue
        if part.startswith('-'):
            ascending = False
            field_name = part[1:]
        else:
            ascending = True
            field_name = part
        if field_name not in _ALLOWED_SORT_FIELDS:
            return None
        if field_name in seen:
            continue
        seen.add(field_name)
        result.append((field_name, ascending))

    if not result:
        return None

    # Append tiebreakers for deterministic ordering.
    for tiebreaker in ('order', 'test'):
        if tiebreaker not in seen:
            result.append((tiebreaker, True))
            seen.add(tiebreaker)

    return result


def _resolve_sort_column(ts, field_name):
    """Map a sort field name to its SQLAlchemy column."""
    if field_name == 'test':
        return ts.Test.name
    elif field_name == 'order':
        return ts.Order.id
    elif field_name == 'timestamp':
        return ts.Run.start_time
    raise ValueError("Unknown sort field: %s" % field_name)


def _encode_cursor(values):
    """Encode a list of cursor values into an opaque string.

    Values are JSON-encoded then base64-wrapped to safely handle
    values containing any characters (colons, unicode, etc.).
    """
    import json
    payload = json.dumps(values, separators=(',', ':'))
    return base64.urlsafe_b64encode(payload.encode('utf-8')).decode('ascii')


def _decode_cursor(cursor_str, num_fields):
    """Decode a cursor string back into a list of values.

    Returns None if the cursor is malformed.
    """
    import json
    if not cursor_str:
        return None
    try:
        decoded = base64.urlsafe_b64decode(
            cursor_str.encode('ascii')).decode('utf-8')
        parts = json.loads(decoded)
        if not isinstance(parts, list) or len(parts) != num_fields:
            return None
        return parts
    except (ValueError, TypeError, UnicodeDecodeError, json.JSONDecodeError):
        return None


def _build_cursor_filter(ts, sort_spec, cursor_values):
    """Build a SQLAlchemy filter expression for cursor-based pagination.

    For mixed ASC/DESC sort orders, expands to an OR chain:
        (col1 > v1)
        OR (col1 = v1 AND col2 < v2)  -- if col2 is DESC
        OR (col1 = v1 AND col2 = v2 AND col3 > v3)
        ...
    """
    conditions = []
    for i in range(len(sort_spec)):
        field_name, ascending = sort_spec[i]
        col = _resolve_sort_column(ts, field_name)
        cursor_val = _coerce_cursor_value(field_name, cursor_values[i])

        # All prefix columns must be equal
        prefix_conditions = []
        for j in range(i):
            pf_name, _ = sort_spec[j]
            pf_col = _resolve_sort_column(ts, pf_name)
            pf_val = _coerce_cursor_value(pf_name, cursor_values[j])
            prefix_conditions.append(pf_col == pf_val)

        # The i-th column uses > (ASC) or < (DESC)
        if ascending:
            cmp = col > cursor_val
        else:
            cmp = col < cursor_val

        if prefix_conditions:
            conditions.append(and_(*prefix_conditions, cmp))
        else:
            conditions.append(cmp)

    return or_(*conditions)


def _coerce_cursor_value(field_name, value):
    """Coerce a cursor value to the appropriate Python type.

    With JSON-encoded cursors, values are already the right type
    in most cases. This handles edge cases and type enforcement.
    Raises ValueError if the value cannot be coerced.
    """
    if field_name == 'order':
        return int(value)
    elif field_name == 'test':
        return str(value) if value is not None else ''
    elif field_name == 'timestamp':
        return value  # None or string, both valid
    return value


def _extract_cursor_values(sort_spec, ts, row_data):
    """Extract cursor values from a result row for encoding.

    row_data is a dict with keys: test_name, order_id, timestamp.
    """
    values = []
    for field_name, _ in sort_spec:
        if field_name == 'test':
            values.append(row_data['test_name'])
        elif field_name == 'order':
            values.append(row_data['order_id'])
        elif field_name == 'timestamp':
            values.append(row_data['timestamp'])
    return values


def _resolve_machine(session, ts, machine_name):
    """Resolve a machine name to its model instance.

    Returns (machine, None, None) on success, or
    (None, error_message, http_status) on failure.
    """
    machines = session.query(ts.Machine).filter(
        ts.Machine.name == machine_name
    ).all()
    if len(machines) == 0:
        return None, "Machine '%s' not found" % machine_name, 404
    if len(machines) > 1:
        ids = ', '.join(str(m.id) for m in machines)
        return None, (
            "Multiple machines named '%s' exist (IDs: %s). "
            "Use the v4 UI to merge or rename them."
            % (machine_name, ids)), 409
    return machines[0], None, None


def _resolve_test(session, ts, test_name):
    """Resolve a test name to its model instance."""
    test = session.query(ts.Test).filter(
        ts.Test.name == test_name
    ).first()
    if test is None:
        return None, "Test '%s' not found" % test_name
    return test, None


def _resolve_order(session, ts, order_value):
    """Resolve an order field value to its model instance.

    Matches against the first (primary) order field.
    """
    if not ts.order_fields:
        return None, "Test suite has no order fields"
    primary_field = ts.order_fields[0]
    order = session.query(ts.Order).filter(
        primary_field.column == order_value
    ).first()
    if order is None:
        return None, "Order '%s' not found" % order_value
    return order, None


def _query_for_field(session, ts, sample_field, machine, test,
                     sort_spec, cursor_values, order, after_order,
                     before_order, after_time, before_time, limit):
    """Build and execute a query for a single sample field.

    Returns a list of dicts ready for serialization, plus a boolean
    indicating whether there are more results.
    """
    q = session.query(
        sample_field.column,
        ts.Order,
        ts.Run,
        ts.Test,
        ts.Machine,
    ).select_from(ts.Sample) \
        .join(ts.Run) \
        .join(ts.Order) \
        .join(ts.Test) \
        .join(ts.Machine, ts.Run.machine_id == ts.Machine.id) \
        .filter(sample_field.column.isnot(None))

    # Filter out failing tests if the field has a status_field.
    if sample_field.status_field:
        q = q.filter(
            (sample_field.status_field.column == PASS) |
            (sample_field.status_field.column.is_(None))
        )

    # Apply optional filters.
    if machine is not None:
        q = q.filter(ts.Run.machine_id == machine.id)
    if test is not None:
        q = q.filter(ts.Sample.test_id == test.id)

    # Apply exact order filter.
    if order is not None:
        q = q.filter(ts.Order.id == order.id)

    # Apply order range filters.
    if after_order is not None:
        q = q.filter(ts.Order.id > after_order.id)
    if before_order is not None:
        q = q.filter(ts.Order.id < before_order.id)

    # Apply timestamp range filters.
    if after_time is not None:
        q = q.filter(ts.Run.start_time > after_time)
    if before_time is not None:
        q = q.filter(ts.Run.start_time < before_time)

    # Apply cursor filter.
    if cursor_values is not None:
        try:
            q = q.filter(_build_cursor_filter(ts, sort_spec, cursor_values))
        except (ValueError, TypeError):
            abort_with_error(400, "Invalid pagination cursor")

    # Apply ordering.
    for field_name, ascending in sort_spec:
        col = _resolve_sort_column(ts, field_name)
        q = q.order_by(col.asc() if ascending else col.desc())

    # Fetch limit + 1 to detect next page.
    rows = q.limit(limit + 1).all()

    has_next = len(rows) > limit
    rows = rows[:limit]

    items = []
    for value, order, run, test_obj, machine_obj in rows:
        order_dict = {}
        for of in order.fields:
            val = order.get_field(of)
            if val is not None:
                order_dict[of.name] = str(val)

        timestamp = None
        if run.start_time:
            timestamp = run.start_time.isoformat()

        items.append({
            'test': test_obj.name,
            'machine': machine_obj.name,
            'metric': sample_field.name,
            'value': value,
            'order': order_dict,
            'run_uuid': run.uuid,
            'timestamp': timestamp,
            '_order_id': order.id,
        })

    return items, has_next


@blp.route('/query')
class QueryView(MethodView):
    """Query data points."""

    @require_scope('read')
    @blp.arguments(QueryEndpointQuerySchema, location="query")
    @blp.response(200, QueryResponseSchema)
    def get(self, query_args, testsuite):
        """Query data points.

        Returns cursor-paginated data points. The metric parameter is
        required; all other filter parameters are optional -- omit any
        to get data across all values of that dimension.
        """
        # Reject unknown query parameters early so that typos like
        # ``machine_name=`` or ``metric_name=`` don't silently return
        # unfiltered data.
        reject_unknown_params(_VALID_QUERY_PARAMS)

        ts = g.ts
        session = g.db_session

        # ------------------------------------------------------------------
        # Parse filter parameters
        # ------------------------------------------------------------------
        machine_name = query_args.get('machine')
        test_name = query_args.get('test')
        field_name = query_args['metric']

        # Resolve entities when provided.
        machine = None
        if machine_name:
            machine, err, status = _resolve_machine(session, ts, machine_name)
            if err:
                abort_with_error(status, err)

        test = None
        if test_name:
            test, err = _resolve_test(session, ts, test_name)
            if err:
                abort_with_error(404, err)

        field = resolve_metric(ts, field_name)

        # ------------------------------------------------------------------
        # Parse sort parameter
        # ------------------------------------------------------------------
        sort_str = query_args.get('sort')
        sort_spec = _parse_sort(sort_str)
        if sort_spec is None:
            abort_with_error(
                400, "Invalid sort parameter. Allowed fields: %s. "
                     "Use - prefix for descending."
                     % ', '.join(sorted(_ALLOWED_SORT_FIELDS)))

        # ------------------------------------------------------------------
        # Parse range filters
        # ------------------------------------------------------------------
        order_str = query_args.get('order')
        after_order_str = query_args.get('after_order')
        before_order_str = query_args.get('before_order')
        after_time_str = query_args.get('after_time')
        before_time_str = query_args.get('before_time')

        if order_str and (after_order_str or before_order_str):
            abort_with_error(
                400,
                "The 'order' parameter cannot be combined with "
                "'after_order' or 'before_order'")

        order = None
        if order_str:
            order, err = _resolve_order(session, ts, order_str)
            if err:
                abort_with_error(404, err)

        after_order = None
        if after_order_str:
            after_order, err = _resolve_order(session, ts, after_order_str)
            if err:
                abort_with_error(404, err)

        before_order = None
        if before_order_str:
            before_order, err = _resolve_order(session, ts, before_order_str)
            if err:
                abort_with_error(404, err)

        after_time = None
        if after_time_str:
            after_time = parse_datetime(after_time_str)
            if after_time is None:
                abort_with_error(
                    400, "Invalid after_time format, expected ISO 8601")

        before_time = None
        if before_time_str:
            before_time = parse_datetime(before_time_str)
            if before_time is None:
                abort_with_error(
                    400, "Invalid before_time format, expected ISO 8601")

        # ------------------------------------------------------------------
        # Parse pagination parameters
        # ------------------------------------------------------------------
        limit = query_args['limit']
        limit = max(1, min(limit, _MAX_LIMIT))

        cursor_str = query_args.get('cursor')
        cursor_values = None
        if cursor_str:
            cursor_values = _decode_cursor(cursor_str, len(sort_spec))
            if cursor_values is None:
                abort_with_error(400, "Invalid pagination cursor")

        # ------------------------------------------------------------------
        # Execute query
        # ------------------------------------------------------------------
        items, has_next = _query_for_field(
            session, ts, field, machine, test,
            sort_spec, cursor_values, order, after_order, before_order,
            after_time, before_time, limit)

        # ------------------------------------------------------------------
        # Build cursor and response
        # ------------------------------------------------------------------
        next_cursor = None
        if has_next and items:
            last = items[-1]
            cursor_vals = _extract_cursor_values(sort_spec, ts, {
                'test_name': last['test'],
                'order_id': last['_order_id'],
                'timestamp': last['timestamp'],
            })
            next_cursor = _encode_cursor(cursor_vals)

        # Strip internal fields before returning.
        for item in items:
            item.pop('_order_id', None)

        return jsonify(make_paginated_response(items, next_cursor))

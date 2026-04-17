"""Query endpoint for the v5 API.

POST /api/v5/{ts}/query
  Body (JSON): {metric, machine, test, commit, after_commit, before_commit,
                after_time, before_time, sort, limit, cursor}

Returns cursor-paginated data points. The metric field is required;
all other fields are optional. The test field accepts a list of names
for disjunction queries.
"""

import base64
import json

from flask import g, jsonify
from flask.views import MethodView
from flask_smorest import Blueprint
from sqlalchemy import and_, or_

from ..auth import require_scope
from ..errors import abort_with_error
from ..helpers import (
    format_utc,
    lookup_commit,
    lookup_machine,
    parse_datetime,
    validate_metric_name,
)
from ..pagination import make_paginated_response
from ..schemas.query import QueryEndpointQuerySchema, QueryResponseSchema

blp = Blueprint(
    'Query',
    __name__,
    url_prefix='/api/v5/<testsuite>',
    description='Query time-series performance data across machines, tests, and metrics',
)

_DEFAULT_LIMIT = 100
_MAX_LIMIT = 10000

_ALLOWED_SORT_FIELDS = {'test', 'commit', 'submitted_at'}


def _parse_sort(sort_str):
    """Parse a comma-separated sort string into (field_name, ascending) pairs.

    Examples:
        "test,commit"         -> [("test", True), ("commit", True)]
        "-submitted_at,test"  -> [("submitted_at", False), ("test", True)]

    Returns a list of (field_name, ascending) tuples, or None on error.
    """
    if not sort_str:
        return [('commit', True), ('test', True)]

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
    for tiebreaker in ('commit', 'test'):
        if tiebreaker not in seen:
            result.append((tiebreaker, True))
            seen.add(tiebreaker)

    return result


def _resolve_sort_column(ts, field_name):
    """Map a sort field name to its SQLAlchemy column."""
    if field_name == 'test':
        return ts.Test.name
    elif field_name == 'commit':
        return ts.Commit.ordinal
    elif field_name == 'submitted_at':
        return ts.Run.submitted_at
    raise ValueError("Unknown sort field: %s" % field_name)


def _encode_cursor(values):
    """Encode a list of cursor values into an opaque string.

    Values are JSON-encoded then base64-wrapped to safely handle
    values containing any characters (colons, unicode, etc.).
    """
    payload = json.dumps(values, separators=(',', ':'))
    return base64.urlsafe_b64encode(payload.encode('utf-8')).decode('ascii')


def _decode_cursor(cursor_str, num_fields):
    """Decode a cursor string back into a list of values.

    Returns None if the cursor is malformed.
    """
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
    if field_name == 'commit':
        return int(value)
    elif field_name == 'test':
        return str(value) if value is not None else ''
    elif field_name == 'submitted_at':
        return value  # None or string, both valid
    return value


def _extract_cursor_values(sort_spec, row_data):
    """Extract cursor values from a result row for encoding.

    row_data is a dict with keys: test_name, ordinal, submitted_at.
    """
    values = []
    for field_name, _ in sort_spec:
        if field_name == 'test':
            values.append(row_data['test_name'])
        elif field_name == 'commit':
            values.append(row_data['ordinal'])
        elif field_name == 'submitted_at':
            values.append(row_data['submitted_at'])
    return values


def _build_query(session, ts, metric_col, metric_name, machine, test_ids,
                 sort_spec, cursor_values, commit, after_commit,
                 before_commit, after_time, before_time, limit):
    """Build and execute the time-series query.

    Returns a list of dicts ready for serialization, plus a boolean
    indicating whether there are more results.
    """
    q = (
        session.query(
            metric_col.label('metric_value'),
            ts.Commit.commit,
            ts.Commit.ordinal,
            ts.Run.uuid,
            ts.Run.submitted_at,
            ts.Test.name.label('test_name'),
            ts.Machine.name.label('machine_name'),
        )
        .select_from(ts.Sample)
        .join(ts.Run, ts.Sample.run_id == ts.Run.id)
        .join(ts.Commit, ts.Run.commit_id == ts.Commit.id)
        .join(ts.Test, ts.Sample.test_id == ts.Test.id)
        .join(ts.Machine, ts.Run.machine_id == ts.Machine.id)
        .filter(metric_col.isnot(None))
    )

    if machine is not None:
        q = q.filter(ts.Run.machine_id == machine.id)
    if test_ids is not None:
        if len(test_ids) == 1:
            q = q.filter(ts.Sample.test_id == test_ids[0])
        else:
            q = q.filter(ts.Sample.test_id.in_(test_ids))

    # Exact commit filter — by commit identity, not ordinal.
    if commit is not None:
        q = q.filter(ts.Run.commit_id == commit.id)

    # Commit range filters — by ordinal.
    if after_commit is not None:
        q = q.filter(ts.Commit.ordinal > after_commit.ordinal)
    if before_commit is not None:
        q = q.filter(ts.Commit.ordinal < before_commit.ordinal)

    # When sorting by commit (ordinal), exclude NULL ordinals.
    sort_fields = {fn for fn, _ in sort_spec}
    if 'commit' in sort_fields:
        q = q.filter(ts.Commit.ordinal.isnot(None))

    # Time range filters.
    if after_time is not None:
        q = q.filter(ts.Run.submitted_at > after_time)
    if before_time is not None:
        q = q.filter(ts.Run.submitted_at < before_time)

    # Cursor filter.
    if cursor_values is not None:
        try:
            q = q.filter(_build_cursor_filter(ts, sort_spec, cursor_values))
        except (ValueError, TypeError):
            abort_with_error(400, "Invalid pagination cursor")

    # Ordering.
    for field_name, ascending in sort_spec:
        col = _resolve_sort_column(ts, field_name)
        q = q.order_by(col.asc() if ascending else col.desc())

    # Fetch limit + 1 to detect next page.
    rows = q.limit(limit + 1).all()

    has_next = len(rows) > limit
    rows = rows[:limit]

    items = []
    for row in rows:
        items.append({
            'test': row.test_name,
            'machine': row.machine_name,
            'metric': metric_name,
            'value': row.metric_value,
            'commit': row.commit,
            'ordinal': row.ordinal,
            'run_uuid': row.uuid,
            'submitted_at': format_utc(row.submitted_at),
        })

    return items, has_next


@blp.route('/query')
class QueryView(MethodView):
    """Query data points."""

    @require_scope('read')
    @blp.arguments(QueryEndpointQuerySchema, location="json")
    @blp.response(200, QueryResponseSchema)
    def post(self, query_args, testsuite):
        """Query data points.

        Returns cursor-paginated data points. The metric field is
        required; all other fields are optional -- omit any to get
        data across all values of that dimension.
        """
        ts = g.ts
        session = g.db_session

        # ------------------------------------------------------------------
        # Parse filter parameters
        # ------------------------------------------------------------------
        machine_name = query_args.get('machine')
        test_names = query_args.get('test')
        field_name = query_args['metric']

        machine = None
        if machine_name:
            machine = lookup_machine(session, ts, machine_name)

        # Silently skip unknown test names — return no data for them
        # rather than 404-ing the entire request.
        test_ids = None
        if test_names:
            test_ids = []
            for tn in test_names:
                test = ts.get_test(session, name=tn)
                if test is not None:
                    test_ids.append(test.id)
            if not test_ids:
                return jsonify(make_paginated_response([], None))

        validate_metric_name(ts, field_name)
        metric_col = getattr(ts.Sample, field_name)

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
        commit_str = query_args.get('commit')
        after_commit_str = query_args.get('after_commit')
        before_commit_str = query_args.get('before_commit')
        after_time_str = query_args.get('after_time')
        before_time_str = query_args.get('before_time')

        if commit_str and (after_commit_str or before_commit_str):
            abort_with_error(
                400,
                "The 'commit' parameter cannot be combined with "
                "'after_commit' or 'before_commit'")

        commit = None
        if commit_str:
            commit = lookup_commit(session, ts, commit_str)

        after_commit = None
        if after_commit_str:
            after_commit = lookup_commit(session, ts, after_commit_str)
            if after_commit.ordinal is None:
                abort_with_error(
                    400, "Commit '%s' has no ordinal; cannot use as "
                    "range boundary" % after_commit_str)

        before_commit = None
        if before_commit_str:
            before_commit = lookup_commit(session, ts, before_commit_str)
            if before_commit.ordinal is None:
                abort_with_error(
                    400, "Commit '%s' has no ordinal; cannot use as "
                    "range boundary" % before_commit_str)

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
        items, has_next = _build_query(
            session, ts, metric_col, field_name, machine, test_ids,
            sort_spec, cursor_values, commit, after_commit, before_commit,
            after_time, before_time, limit)

        # ------------------------------------------------------------------
        # Build cursor and response
        # ------------------------------------------------------------------
        next_cursor = None
        if has_next and items:
            last = items[-1]
            cursor_vals = _extract_cursor_values(sort_spec, {
                'test_name': last['test'],
                'ordinal': last['ordinal'],
                'submitted_at': last['submitted_at'],
            })
            next_cursor = _encode_cursor(cursor_vals)

        return jsonify(make_paginated_response(items, next_cursor))

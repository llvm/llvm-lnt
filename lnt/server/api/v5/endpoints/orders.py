"""Order endpoints for the v5 API.

GET    /api/v5/{ts}/orders                  -- List orders (cursor-paginated)
POST   /api/v5/{ts}/orders                  -- Create order
GET    /api/v5/{ts}/orders/{order_value}    -- Order detail (includes prev/next)
PATCH  /api/v5/{ts}/orders/{order_value}    -- Update order metadata
DELETE /api/v5/{ts}/orders/{order_value}    -- Not allowed (405)
"""

from flask import g, jsonify, request
from flask.views import MethodView
from flask_smorest import Blueprint

from ..auth import require_scope
from ..errors import abort_with_error, reject_unknown_params
from ..etag import add_etag_to_response
from ..helpers import escape_like, validate_tag
from ..pagination import (
    cursor_paginate,
    make_paginated_response,
)
from ..schemas.orders import (
    OrderDetailQuerySchema,
    OrderDetailSchema,
    OrderListQuerySchema,
    PaginatedOrderResponseSchema,
)

blp = Blueprint(
    'Orders',
    __name__,
    url_prefix='/api/v5/<testsuite>',
    description='List, create, and inspect orders (revisions) with previous/next navigation',
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _serialize_order_fields(order, ts):
    """Return a dict of {field_name: value} for the given order."""
    result = {}
    for field in ts.order_fields:
        val = order.get_field(field)
        if val is not None:
            result[field.name] = str(val)
    return result


def _serialize_order_summary(order, ts):
    """Serialize an order for list responses."""
    return {
        'fields': _serialize_order_fields(order, ts),
        'tag': order.tag,
    }


def _order_detail_url(testsuite, order, ts):
    """Build the detail URL for an order using its primary field value."""
    primary_field = ts.order_fields[0]
    primary_value = order.get_field(primary_field)
    return '/api/v5/%s/orders/%s' % (testsuite, primary_value)


def _serialize_order_neighbor(order, testsuite, ts):
    """Serialize a previous/next order reference, or None."""
    if order is None:
        return None
    return {
        'fields': _serialize_order_fields(order, ts),
        'link': _order_detail_url(testsuite, order, ts),
    }


def _serialize_order_detail(order, testsuite, ts):
    """Serialize an order for detail responses, including prev/next."""
    return {
        'fields': _serialize_order_fields(order, ts),
        'tag': order.tag,
        'previous_order': _serialize_order_neighbor(
            order.previous_order, testsuite, ts),
        'next_order': _serialize_order_neighbor(
            order.next_order, testsuite, ts),
    }


def _lookup_order_by_value(session, ts, order_value):
    """Look up an order by its primary field value and optional extra
    query parameters for multi-field orders.

    Returns the Order instance. Aborts with 404 or 409 as appropriate.
    """
    primary_field = ts.order_fields[0]
    query = session.query(ts.Order).filter(
        primary_field.column == order_value
    )

    # For multi-field orders, use additional query parameters to
    # disambiguate.
    if len(ts.order_fields) > 1:
        for field in ts.order_fields[1:]:
            extra_value = request.args.get(field.name)
            if extra_value is not None:
                query = query.filter(field.column == extra_value)

    orders = query.all()

    if len(orders) == 0:
        abort_with_error(404, "Order '%s' not found" % order_value)
    elif len(orders) > 1:
        field_names = ', '.join(f.name for f in ts.order_fields[1:])
        abort_with_error(
            409,
            "Multiple orders match '%s'. Disambiguate with query "
            "parameters: %s" % (order_value, field_names))

    return orders[0]


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@blp.route('/orders')
class OrderList(MethodView):
    """List and create orders."""

    @require_scope('read')
    @blp.arguments(OrderListQuerySchema, location="query")
    @blp.response(200, PaginatedOrderResponseSchema)
    def get(self, query_args, testsuite):
        """List orders (cursor-paginated)."""
        reject_unknown_params({'cursor', 'limit', 'tag', 'tag_prefix'})
        ts = g.ts
        session = g.db_session

        query = session.query(ts.Order)

        # Filter by tag
        tag_value = query_args.get('tag')
        if tag_value:
            query = query.filter(ts.Order.tag == tag_value)

        tag_prefix = query_args.get('tag_prefix')
        if tag_prefix:
            escaped = escape_like(tag_prefix)
            query = query.filter(
                ts.Order.tag.like(escaped + '%', escape='\\'))

        cursor_str = query_args.get('cursor')
        limit = query_args['limit']
        items, next_cursor = cursor_paginate(
            query, ts.Order.id, cursor_str, limit)

        serialized = [_serialize_order_summary(o, ts) for o in items]
        return jsonify(make_paginated_response(serialized, next_cursor))

    @require_scope('submit')
    @blp.response(201, OrderDetailSchema)
    def post(self, testsuite):
        """Create an order explicitly."""
        ts = g.ts
        session = g.db_session

        data = request.get_json(silent=True)
        if not data:
            abort_with_error(400, "Request body must be valid JSON")

        # Validate that all order fields are present.
        for field in ts.order_fields:
            if field.name not in data:
                abort_with_error(
                    400,
                    "Missing required order field: '%s'" % field.name)

        # Check if an order with these exact field values already exists.
        query = session.query(ts.Order)
        for field in ts.order_fields:
            query = query.filter(field.column == data[field.name])
        existing = query.first()
        if existing is not None:
            abort_with_error(
                409,
                "An order with these field values already exists")

        # Create the order. Use _getOrCreateOrder which also maintains
        # the linked-list (previous/next) ordering.
        #
        # _getOrCreateOrder expects a dict and pops order field keys from
        # it, so we give it a copy.
        params_copy = dict(data)
        order = ts._getOrCreateOrder(session, params_copy)

        # Set optional tag.
        if 'tag' in data:
            order.tag = validate_tag(data['tag'])

        session.flush()

        result = _serialize_order_detail(order, testsuite, ts)
        resp = jsonify(result)
        resp.status_code = 201
        return resp


@blp.route('/orders/<string:order_value>')
class OrderDetail(MethodView):
    """Order detail, update, and (disallowed) delete."""

    @require_scope('read')
    @blp.arguments(OrderDetailQuerySchema, location="query")
    @blp.response(200, OrderDetailSchema)
    def get(self, query_args, testsuite, order_value):
        """Get order detail by primary field value.

        The response includes previous_order and next_order references.
        For multi-field orders, pass additional query parameters to
        disambiguate.
        """
        ts = g.ts
        # Allow dynamic order field names for disambiguation.
        valid = {f.name for f in ts.order_fields[1:]}
        reject_unknown_params(valid)
        session = g.db_session
        order = _lookup_order_by_value(session, ts, order_value)
        data = _serialize_order_detail(order, testsuite, ts)
        return add_etag_to_response(jsonify(data), data)

    @require_scope('manage')
    @blp.response(200, OrderDetailSchema)
    def patch(self, testsuite, order_value):
        """Update order metadata."""
        ts = g.ts
        session = g.db_session
        order = _lookup_order_by_value(session, ts, order_value)

        data = request.get_json(silent=True)
        if not data:
            abort_with_error(400, "Request body must be valid JSON")

        # Update tag if provided. Check key presence to distinguish
        # "not provided" from an explicit null (which clears the tag).
        if 'tag' in data:
            order.tag = validate_tag(data['tag'])

        session.flush()

        return jsonify(_serialize_order_detail(order, testsuite, ts))

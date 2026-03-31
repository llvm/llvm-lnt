"""Order request/response schemas for the v5 API.

Used by the orders endpoints for OpenAPI documentation and (optionally)
for validation. The dynamic order fields are serialized into a ``fields``
dict since their names depend on the test suite schema.
"""

import marshmallow as ma

from . import BaseSchema
from .common import BaseQuerySchema, CursorPaginationQuerySchema, PaginatedResponseSchema


# ---------------------------------------------------------------------------
# Response schemas
# ---------------------------------------------------------------------------

class OrderSummarySchema(BaseSchema):
    """A single order in a list response."""
    fields = ma.fields.Dict(
        keys=ma.fields.String(),
        values=ma.fields.String(allow_none=True),
        metadata={
            'description': 'Order field values (e.g. llvm_project_revision)',
            'example': {'llvm_project_revision': 'abc123'},
        },
    )
    tag = ma.fields.String(
        allow_none=True,
        metadata={
            'description': 'User-assigned label (e.g. release-18.1)',
            'example': 'release-18.1',
        },
    )


class OrderNeighborSchema(BaseSchema):
    """Reference to a previous or next order."""
    fields = ma.fields.Dict(
        keys=ma.fields.String(),
        values=ma.fields.String(allow_none=True),
        metadata={
            'description': 'Order field values',
            'example': {'llvm_project_revision': 'abc123'},
        },
    )
    link = ma.fields.String(
        allow_none=True,
        metadata={'description': 'URL to fetch the referenced order'},
    )


class OrderDetailSchema(BaseSchema):
    """Full order detail including previous/next references."""
    fields = ma.fields.Dict(
        keys=ma.fields.String(),
        values=ma.fields.String(allow_none=True),
        metadata={
            'description': 'Order field values',
            'example': {'llvm_project_revision': 'abc123'},
        },
    )
    tag = ma.fields.String(
        allow_none=True,
        metadata={
            'description': 'User-assigned label (e.g. release-18.1)',
            'example': 'release-18.1',
        },
    )
    previous_order = ma.fields.Nested(
        OrderNeighborSchema, allow_none=True,
        metadata={'description': 'Previous order in the total ordering'},
    )
    next_order = ma.fields.Nested(
        OrderNeighborSchema, allow_none=True,
        metadata={'description': 'Next order in the total ordering'},
    )


# ---------------------------------------------------------------------------
# Request schemas
# ---------------------------------------------------------------------------

class OrderCreateSchema(BaseSchema):
    """Request body for POST /orders.

    The body should contain the order field values as top-level keys
    (e.g. ``{"llvm_project_revision": "abc123"}``).
    """
    class Meta:
        # Allow any keys since order fields are dynamic per test suite
        unknown = ma.INCLUDE


class OrderUpdateSchema(BaseSchema):
    """Request body for PATCH /orders/{order_value}.

    Currently a placeholder -- order metadata updates are limited until
    a ``parameters_data`` column is added to the Order model.
    """
    class Meta:
        unknown = ma.INCLUDE


# ---------------------------------------------------------------------------
# Paginated response schemas
# ---------------------------------------------------------------------------

class PaginatedOrderResponseSchema(PaginatedResponseSchema):
    """Paginated list of orders."""
    items = ma.fields.List(ma.fields.Nested(OrderSummarySchema))


# ---------------------------------------------------------------------------
# Query parameter schemas
# ---------------------------------------------------------------------------

class OrderListQuerySchema(CursorPaginationQuerySchema):
    """Query parameters for GET /orders."""
    tag = ma.fields.String(
        load_default=None,
        metadata={'description': 'Filter by exact tag'},
    )
    tag_prefix = ma.fields.String(
        load_default=None,
        metadata={'description': 'Filter by tag prefix'},
    )


class OrderDetailQuerySchema(BaseQuerySchema):
    """Query parameters for GET /orders/{order_value}.

    Only covers marshmallow-parseable params. Dynamic order field names
    for disambiguation continue to be read from request.args directly.
    """
    pass

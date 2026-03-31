"""Marshmallow schemas for test entity request/response in the v5 API."""

import marshmallow as ma

from . import BaseSchema
from .common import CursorPaginationQuerySchema, PaginatedResponseSchema


# ---------------------------------------------------------------------------
# Response schemas
# ---------------------------------------------------------------------------

class TestResponseSchema(BaseSchema):
    """Schema for a single test entity in responses."""
    name = ma.fields.String(
        required=True,
        metadata={'description': 'Test name (may contain slashes)'},
    )


# ---------------------------------------------------------------------------
# Paginated response schemas
# ---------------------------------------------------------------------------

class PaginatedTestResponseSchema(PaginatedResponseSchema):
    """Paginated list of tests."""
    items = ma.fields.List(ma.fields.Nested(TestResponseSchema))


# ---------------------------------------------------------------------------
# Query parameter schemas
# ---------------------------------------------------------------------------

class TestListQuerySchema(CursorPaginationQuerySchema):
    """Query parameters for GET /tests."""
    name_contains = ma.fields.String(
        load_default=None,
        metadata={'description': 'Filter by substring in test name'},
    )
    name_prefix = ma.fields.String(
        load_default=None,
        metadata={'description': 'Filter by test name prefix'},
    )

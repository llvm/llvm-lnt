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
    search = ma.fields.String(
        load_default=None,
        metadata={'description': 'Filter test names (case-insensitive substring match)'},
    )
    machine = ma.fields.String(
        load_default=None,
        metadata={
            'description': 'Only return tests that have sample data '
                           'for this machine',
        },
    )
    metric = ma.fields.String(
        load_default=None,
        metadata={
            'description': 'Only return tests that have non-NULL values '
                           'for this metric',
        },
    )

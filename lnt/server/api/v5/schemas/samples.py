"""Marshmallow schemas for sample responses in the v5 API."""

import marshmallow as ma

from . import BaseSchema
from .common import CursorPaginationQuerySchema, PaginatedResponseSchema


class SampleResponseSchema(BaseSchema):
    """Schema for a single sample in API responses.

    Each sample includes the test name and a ``metrics`` dict containing
    all non-null metric values.
    """
    test = ma.fields.String(
        required=True,
        metadata={'description': 'Name of the test this sample belongs to'},
    )
    metrics = ma.fields.Dict(
        keys=ma.fields.String(),
        values=ma.fields.Raw(),
        metadata={
            'description': 'Metric field values (metric -> value)',
            'example': {'compile_time': 1.23, 'exec_time': 0.45},
        },
    )


# ---------------------------------------------------------------------------
# Paginated response schemas
# ---------------------------------------------------------------------------

class PaginatedSampleResponseSchema(PaginatedResponseSchema):
    """Paginated list of samples."""
    items = ma.fields.List(ma.fields.Nested(SampleResponseSchema))


class SampleListResponseSchema(BaseSchema):
    """Non-paginated list of samples (used for run+test specific queries)."""
    items = ma.fields.List(ma.fields.Nested(SampleResponseSchema))


# ---------------------------------------------------------------------------
# Query parameter schemas
# ---------------------------------------------------------------------------

class RunSamplesQuerySchema(CursorPaginationQuerySchema):
    """Query parameters for GET /runs/{uuid}/samples."""
    pass

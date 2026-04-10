"""Marshmallow schemas for the trends endpoint in the v5 API."""

import marshmallow as ma

from . import BaseSchema


class TrendsQuerySchema(BaseSchema):
    """JSON body for POST /trends."""

    class Meta:
        ordered = True
        unknown = ma.RAISE

    metric = ma.fields.String(
        required=True,
        metadata={'description': 'Metric name (required)'},
    )
    machine = ma.fields.List(
        ma.fields.String(),
        load_default=[],
        metadata={'description': 'Filter by machine name(s)'},
    )
    after_time = ma.fields.String(
        load_default=None,
        metadata={'description': 'ISO datetime, only data points after this time'},
    )
    before_time = ma.fields.String(
        load_default=None,
        metadata={'description': 'ISO datetime, only data points before this time'},
    )


class TrendsItemSchema(BaseSchema):
    """Schema for a single trend item in the response."""
    machine = ma.fields.String(
        required=True,
        metadata={'description': 'Name of the machine'},
    )
    order = ma.fields.Dict(
        keys=ma.fields.String(),
        values=ma.fields.String(),
        required=True,
        metadata={
            'description': 'Order field values (e.g. llvm_project_revision)',
            'example': {'llvm_project_revision': 'abc123'},
        },
    )
    timestamp = ma.fields.String(
        allow_none=True,
        metadata={'description': 'Run start time (ISO 8601)'},
    )
    value = ma.fields.Float(
        required=True,
        metadata={'description': 'Geometric mean of sample values'},
    )


class TrendsResponseSchema(BaseSchema):
    """Response schema for POST /api/v5/{ts}/trends."""
    metric = ma.fields.String(
        required=True,
        metadata={'description': 'The metric that was queried'},
    )
    items = ma.fields.List(
        ma.fields.Nested(TrendsItemSchema),
        required=True,
        metadata={'description': 'Trend data points'},
    )

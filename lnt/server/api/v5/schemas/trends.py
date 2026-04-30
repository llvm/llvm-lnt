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
    last_n = ma.fields.Integer(
        load_default=None,
        validate=ma.validate.Range(min=1, max=10000),
        metadata={'description': 'Return only the last N commits by ordinal'},
    )


class TrendsItemSchema(BaseSchema):
    """Schema for a single trend item in the response."""
    machine = ma.fields.String(
        required=True,
        metadata={'description': 'Name of the machine'},
    )
    commit = ma.fields.String(
        required=True,
        metadata={
            'description': 'Commit string (e.g. revision hash)',
            'example': 'abc123',
        },
    )
    ordinal = ma.fields.Integer(
        required=True,
        metadata={'description': 'Commit ordinal position'},
    )
    tag = ma.fields.String(
        allow_none=True,
        metadata={'description': 'Commit tag (may be null)'},
    )
    submitted_at = ma.fields.String(
        allow_none=True,
        metadata={'description': 'Latest run submission time (ISO 8601)'},
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

"""Marshmallow schemas for the query endpoint in the v5 API."""

import marshmallow as ma

from . import BaseSchema
from .common import CursorSchema


class QueryDataPointSchema(BaseSchema):
    """Schema for a single data point in a query response."""
    test = ma.fields.String(
        required=True,
        metadata={'description': 'Name of the test this data point belongs to'},
    )
    machine = ma.fields.String(
        required=True,
        metadata={'description': 'Name of the machine this data point belongs to'},
    )
    metric = ma.fields.String(
        required=True,
        metadata={'description': 'Name of the sample field (metric)'},
    )
    value = ma.fields.Float(
        required=True,
        metadata={'description': 'The sample value for the field'},
    )
    commit = ma.fields.String(
        required=True,
        metadata={
            'description': 'Commit identity string (e.g. revision hash)',
            'example': 'abc123',
        },
    )
    ordinal = ma.fields.Integer(
        allow_none=True,
        metadata={'description': 'Commit ordinal position (may be null)'},
    )
    tag = ma.fields.String(
        allow_none=True,
        metadata={'description': 'Commit tag (may be null)'},
    )
    run_uuid = ma.fields.String(
        required=True,
        metadata={'description': 'UUID of the run this data point belongs to'},
    )
    submitted_at = ma.fields.String(
        allow_none=True,
        metadata={'description': 'Run submission time (ISO 8601)'},
    )


class QueryResponseSchema(BaseSchema):
    """Response schema for POST /api/v5/{ts}/query."""
    items = ma.fields.List(
        ma.fields.Nested(QueryDataPointSchema),
        required=True,
        metadata={'description': 'Query data points'},
    )
    cursor = ma.fields.Nested(CursorSchema)


# ---------------------------------------------------------------------------
# Request body schema
# ---------------------------------------------------------------------------

class QueryEndpointQuerySchema(BaseSchema):
    """JSON body for POST /query."""

    class Meta:
        ordered = True
        unknown = ma.RAISE

    machine = ma.fields.String(
        load_default=None,
        metadata={'description': 'Filter by machine name'},
    )
    test = ma.fields.List(
        ma.fields.String(),
        load_default=None,
        metadata={
            'description': 'Filter by test name(s) (disjunction).',
        },
    )
    metric = ma.fields.String(
        required=True,
        metadata={'description': 'Metric name (required)'},
    )
    commit = ma.fields.String(
        load_default=None,
        metadata={'description': 'Filter by exact commit (mutually exclusive with after_commit/before_commit)'},
    )
    after_commit = ma.fields.String(
        load_default=None,
        metadata={'description': 'Only return data points after this commit (by ordinal)'},
    )
    before_commit = ma.fields.String(
        load_default=None,
        metadata={'description': 'Only return data points before this commit (by ordinal)'},
    )
    after_time = ma.fields.String(
        load_default=None,
        metadata={'description': 'ISO datetime; only data points after this time (exclusive)'},
    )
    before_time = ma.fields.String(
        load_default=None,
        metadata={'description': 'ISO datetime; only data points before this time (exclusive)'},
    )
    sort = ma.fields.String(
        load_default=None,
        metadata={'description': 'Comma-separated sort fields: test, commit, '
                  'submitted_at (prefix with - for descending)'},
    )
    limit = ma.fields.Integer(
        load_default=100,
        metadata={'description': 'Maximum number of results per page (default 100, max 10000)'},
    )
    cursor = ma.fields.String(
        load_default=None,
        metadata={'description': 'Pagination cursor from a previous response'},
    )

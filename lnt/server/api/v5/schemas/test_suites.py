"""Marshmallow schemas for the /api/v5/test-suites endpoints."""

import marshmallow as ma

from . import BaseSchema
from .common import BaseQuerySchema


# ---------------------------------------------------------------------------
# Nested field-definition schemas for the POST body
# ---------------------------------------------------------------------------

class MachineFieldDefSchema(BaseSchema):
    name = ma.fields.String(
        required=True,
        metadata={'description': 'Machine field name'},
    )
    searchable = ma.fields.Boolean(
        load_default=False,
        metadata={'description': 'Enable search on this field'},
    )


class CommitFieldDefSchema(BaseSchema):
    name = ma.fields.String(
        required=True,
        metadata={'description': 'Commit field name'},
    )
    type = ma.fields.String(
        load_default='default',
        metadata={'description': 'Data type: default, text, integer, datetime'},
    )
    searchable = ma.fields.Boolean(
        load_default=False,
        metadata={'description': 'Enable search on this field'},
    )
    display = ma.fields.Boolean(
        load_default=False,
        metadata={'description': 'Use this field for display instead of the commit string'},
    )


class MetricDefSchema(BaseSchema):
    name = ma.fields.String(
        required=True,
        metadata={'description': 'Metric name'},
    )
    type = ma.fields.String(
        load_default='real',
        metadata={'description': 'Data type: real, status, or hash'},
    )
    bigger_is_better = ma.fields.Boolean(
        load_default=False,
        metadata={'description': 'Whether larger values indicate better performance'},
    )
    display_name = ma.fields.String(
        load_default=None,
        allow_none=True,
        metadata={'description': 'Human-readable display name'},
    )
    unit = ma.fields.String(
        load_default=None,
        allow_none=True,
        metadata={'description': 'Unit of measurement (e.g. "seconds", "bytes")'},
    )
    unit_abbrev = ma.fields.String(
        load_default=None,
        allow_none=True,
        metadata={'description': 'Abbreviated unit (e.g. "s", "B")'},
    )


# ---------------------------------------------------------------------------
# Request schema (POST body)
# ---------------------------------------------------------------------------

class TestSuiteCreateRequestSchema(BaseSchema):
    name = ma.fields.String(
        required=True,
        validate=ma.validate.Regexp(
            r'^[A-Za-z][A-Za-z0-9_]*$',
            error='Name must start with a letter and contain only '
                  'letters, digits, and underscores.',
        ),
    )
    metrics = ma.fields.List(
        ma.fields.Nested(MetricDefSchema),
        required=True,
    )
    commit_fields = ma.fields.List(
        ma.fields.Nested(CommitFieldDefSchema),
        load_default=[],
    )
    machine_fields = ma.fields.List(
        ma.fields.Nested(MachineFieldDefSchema),
        load_default=[],
    )


# ---------------------------------------------------------------------------
# Query parameter schemas
# ---------------------------------------------------------------------------

class TestSuiteListQuerySchema(BaseQuerySchema):
    pass


class TestSuiteCreateQuerySchema(BaseQuerySchema):
    pass


class TestSuiteDetailQuerySchema(BaseQuerySchema):
    pass


class TestSuiteDeleteQuerySchema(BaseQuerySchema):
    confirm = ma.fields.String(
        load_default=None,
        metadata={'description': 'Must be "true" to confirm deletion'},
    )


# ---------------------------------------------------------------------------
# Response schemas
# ---------------------------------------------------------------------------

class TestSuiteDetailResponseSchema(BaseSchema):
    name = ma.fields.String(required=True)
    schema = ma.fields.Dict(
        metadata={'description': 'Full test suite schema definition'},
    )
    links = ma.fields.Dict(
        keys=ma.fields.String(),
        values=ma.fields.String(),
        metadata={
            'description': 'Links to per-suite API resources',
            'example': {
                'machines': '/api/v5/nts/machines',
                'runs': '/api/v5/nts/runs',
            },
        },
    )


class TestSuiteListResponseSchema(BaseSchema):
    items = ma.fields.List(ma.fields.Nested(TestSuiteDetailResponseSchema))

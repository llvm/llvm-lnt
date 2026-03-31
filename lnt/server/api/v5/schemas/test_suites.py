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


class RunFieldDefSchema(BaseSchema):
    name = ma.fields.String(
        required=True,
        metadata={'description': 'Run field name'},
    )
    order = ma.fields.Boolean(
        load_default=False,
        metadata={'description': 'Whether this field defines the ordering of runs'},
    )


class MetricDefSchema(BaseSchema):
    name = ma.fields.String(
        required=True,
        metadata={'description': 'Metric name'},
    )
    type = ma.fields.String(
        load_default='Real',
        metadata={'description': 'Data type: Real or Status'},
    )
    bigger_is_better = ma.fields.Boolean(
        load_default=False,
        metadata={'description': 'Whether larger values indicate better performance'},
    )
    ignore_same_hash = ma.fields.Boolean(
        load_default=False,
        metadata={'description': 'Skip regression detection when hash is unchanged'},
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
    format_version = ma.fields.String(
        required=True,
        validate=ma.validate.Equal('2'),
    )
    name = ma.fields.String(
        required=True,
        validate=ma.validate.Regexp(
            r'^[A-Za-z][A-Za-z0-9_]*$',
            error='Name must start with a letter and contain only '
                  'letters, digits, and underscores.',
        ),
    )
    machine_fields = ma.fields.List(
        ma.fields.Nested(MachineFieldDefSchema),
        load_default=[],
    )
    run_fields = ma.fields.List(
        ma.fields.Nested(RunFieldDefSchema),
        load_default=[],
    )
    metrics = ma.fields.List(
        ma.fields.Nested(MetricDefSchema),
        required=True,
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

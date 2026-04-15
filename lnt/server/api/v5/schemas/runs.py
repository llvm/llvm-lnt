"""Marshmallow schemas for run request/response in the v5 API."""

import marshmallow as ma

from . import BaseSchema
from .common import BaseQuerySchema, CursorPaginationQuerySchema, PaginatedResponseSchema


# ---------------------------------------------------------------------------
# Request body schemas
# ---------------------------------------------------------------------------

class RunSubmitMachineSchema(BaseSchema):
    """Machine section of a run submission."""
    class Meta:
        unknown = ma.INCLUDE

    name = ma.fields.String(
        required=True,
        metadata={'description': 'Machine name'},
    )


class RunSubmitTestEntrySchema(BaseSchema):
    """A single test entry in a run submission."""
    class Meta:
        unknown = ma.INCLUDE

    name = ma.fields.String(
        required=True,
        metadata={'description': 'Test name'},
    )


class RunSubmitBodySchema(BaseSchema):
    """Request body for POST /runs (v5 report format).

    The ``tests`` entries may contain additional metric fields (e.g.
    ``execution_time``, ``compile_time``) whose names are defined by
    the test suite schema.  Metric values can be scalars or arrays;
    arrays create one sample per element.
    """
    class Meta:
        unknown = ma.INCLUDE

    format_version = ma.fields.Raw(
        required=True,
        metadata={'description': "Must be the string '5'", 'example': '5'},
    )
    machine = ma.fields.Nested(
        RunSubmitMachineSchema,
        required=True,
        metadata={'description': 'Machine definition (name + optional info fields)'},
    )
    commit = ma.fields.String(
        required=True,
        metadata={
            'description': 'Commit identifier for this run',
            'example': 'abc123def456',
        },
    )
    commit_fields = ma.fields.Dict(
        keys=ma.fields.String(),
        values=ma.fields.Raw(),
        load_default={},
        metadata={
            'description': 'Optional commit metadata (first-write-wins)',
            'example': {'llvm_project_revision': 'abc123'},
        },
    )
    run_parameters = ma.fields.Dict(
        keys=ma.fields.String(),
        values=ma.fields.Raw(),
        load_default={},
        metadata={
            'description': 'Optional run parameters stored as JSONB',
            'example': {'build_config': 'Release'},
        },
    )
    tests = ma.fields.List(
        ma.fields.Nested(RunSubmitTestEntrySchema),
        required=True,
        metadata={
            'description': 'Test results with metric values',
        },
    )


# ---------------------------------------------------------------------------
# Response schemas
# ---------------------------------------------------------------------------

class RunResponseSchema(BaseSchema):
    """Schema for a single run in responses."""
    uuid = ma.fields.String(
        required=True,
        metadata={'description': 'Server-generated UUID for the run'},
    )
    machine = ma.fields.String(
        required=True,
        metadata={'description': 'Name of the machine this run was on'},
    )
    commit = ma.fields.String(
        allow_none=True,
        metadata={
            'description': 'Commit string for this run',
            'example': 'abc123def456',
        },
    )
    submitted_at = ma.fields.String(
        allow_none=True,
        metadata={'description': 'Run submission time (ISO 8601)'},
    )
    run_parameters = ma.fields.Dict(
        keys=ma.fields.String(),
        values=ma.fields.Raw(),
        load_default=None,
        metadata={
            'description': 'Additional run parameters',
            'example': {'run_order': '1', 'optimization_level': '-O2'},
        },
    )


class RunSubmitResponseSchema(BaseSchema):
    """Schema for the POST /runs submission response."""
    success = ma.fields.Boolean(required=True)
    run_uuid = ma.fields.String(
        required=True,
        metadata={'description': 'UUID of the newly created run'},
    )
    result_url = ma.fields.String(
        metadata={'description': 'URL to fetch the submitted run'},
    )


# ---------------------------------------------------------------------------
# Paginated response schemas
# ---------------------------------------------------------------------------

class PaginatedRunResponseSchema(PaginatedResponseSchema):
    """Paginated list of runs."""
    items = ma.fields.List(ma.fields.Nested(RunResponseSchema))


# ---------------------------------------------------------------------------
# Query parameter schemas
# ---------------------------------------------------------------------------

class RunListQuerySchema(CursorPaginationQuerySchema):
    """Query parameters for GET /runs."""
    machine = ma.fields.String(
        load_default=None,
        metadata={'description': 'Filter by machine name'},
    )
    commit = ma.fields.String(
        load_default=None,
        metadata={'description': 'Filter by commit string'},
    )
    after = ma.fields.String(
        load_default=None,
        metadata={'description': 'ISO datetime, only runs submitted after this time'},
    )
    before = ma.fields.String(
        load_default=None,
        metadata={'description': 'ISO datetime, only runs submitted before this time'},
    )
    sort = ma.fields.String(
        load_default=None,
        metadata={'description': 'Sort order. Use -submitted_at for newest first'},
    )


class RunSubmitQuerySchema(BaseQuerySchema):
    """Query parameters for POST /runs."""
    on_machine_conflict = ma.fields.String(
        load_default='reject',
        validate=ma.validate.OneOf(['reject', 'update']),
        metadata={'description': "What to do when machine metadata differs: "
                  "'reject' aborts, 'update' updates the existing machine"},
    )

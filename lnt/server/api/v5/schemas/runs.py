"""Marshmallow schemas for run request/response in the v5 API."""

import marshmallow as ma

from . import BaseSchema
from .common import BaseQuerySchema, CursorPaginationQuerySchema, PaginatedResponseSchema


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
    order = ma.fields.Dict(
        keys=ma.fields.String(),
        values=ma.fields.String(),
        metadata={
            'description': 'Order field values (e.g. revision)',
            'example': {'llvm_project_revision': 'abc123'},
        },
    )
    start_time = ma.fields.String(
        allow_none=True,
        metadata={'description': 'Run start time (ISO 8601)'},
    )
    end_time = ma.fields.String(
        allow_none=True,
        metadata={'description': 'Run end time (ISO 8601)'},
    )
    parameters = ma.fields.Dict(
        keys=ma.fields.String(),
        values=ma.fields.String(),
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
    order = ma.fields.String(
        load_default=None,
        metadata={'description': 'Filter by primary order field value'},
    )
    after = ma.fields.String(
        load_default=None,
        metadata={'description': 'ISO datetime, only runs started after this time'},
    )
    before = ma.fields.String(
        load_default=None,
        metadata={'description': 'ISO datetime, only runs started before this time'},
    )
    sort = ma.fields.String(
        load_default=None,
        metadata={'description': 'Sort order. Use -start_time for newest first'},
    )


class RunSubmitQuerySchema(BaseQuerySchema):
    """Query parameters for POST /runs."""
    on_machine_conflict = ma.fields.String(
        load_default='reject',
        validate=ma.validate.OneOf(['reject', 'update']),
        metadata={'description': "What to do when machine metadata differs: "
                  "'reject' aborts, 'update' updates the existing machine"},
    )
    on_existing_run = ma.fields.String(
        load_default='reject',
        validate=ma.validate.OneOf(['reject', 'replace', 'create']),
        metadata={'description': "What to do when a run already exists for "
                  "this machine+order: 'reject' aborts, 'replace' overwrites "
                  "the existing run, 'create' creates a new run alongside it"},
    )

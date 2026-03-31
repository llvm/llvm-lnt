"""Marshmallow schemas for machine request/response in the v5 API."""

import marshmallow as ma

from . import BaseSchema
from .common import CursorPaginationQuerySchema, OffsetPaginationQuerySchema, PaginatedResponseSchema


# ---------------------------------------------------------------------------
# Request schemas
# ---------------------------------------------------------------------------

class MachineCreateSchema(BaseSchema):
    """Schema for POST /machines request body."""
    name = ma.fields.String(
        required=True,
        validate=ma.validate.Length(min=1),
        metadata={'description': 'Machine name'},
    )
    info = ma.fields.Dict(
        keys=ma.fields.String(),
        values=ma.fields.String(),
        load_default=None,
        metadata={
            'description': 'Optional key-value metadata for the machine',
            'example': {'os': 'linux', 'cpu': 'x86_64'},
        },
    )


class MachineUpdateSchema(BaseSchema):
    """Schema for PATCH /machines/{machine_name} request body."""
    name = ma.fields.String(
        load_default=None,
        validate=ma.validate.Length(min=1),
        metadata={'description': 'New machine name (rename)'},
    )
    info = ma.fields.Dict(
        keys=ma.fields.String(),
        values=ma.fields.String(),
        load_default=None,
        metadata={
            'description': 'Updated key-value metadata',
            'example': {'os': 'linux', 'cpu': 'x86_64'},
        },
    )


# ---------------------------------------------------------------------------
# Response schemas
# ---------------------------------------------------------------------------

class MachineResponseSchema(BaseSchema):
    """Schema for a single machine in responses."""
    name = ma.fields.String(required=True)
    info = ma.fields.Dict(
        keys=ma.fields.String(),
        values=ma.fields.String(),
        metadata={
            'description': 'Machine metadata / parameters',
            'example': {'os': 'linux', 'cpu': 'x86_64'},
        },
    )


class MachineRunResponseSchema(BaseSchema):
    """Schema for a run in the machine runs sub-resource."""
    uuid = ma.fields.String(required=True)
    order = ma.fields.Dict(
        keys=ma.fields.String(),
        values=ma.fields.String(),
        metadata={
            'description': 'Order field values',
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


# ---------------------------------------------------------------------------
# Paginated response schemas
# ---------------------------------------------------------------------------

class PaginatedMachineResponseSchema(PaginatedResponseSchema):
    """Paginated list of machines."""
    items = ma.fields.List(ma.fields.Nested(MachineResponseSchema))


class PaginatedMachineRunResponseSchema(PaginatedResponseSchema):
    """Paginated list of machine runs."""
    items = ma.fields.List(ma.fields.Nested(MachineRunResponseSchema))


# ---------------------------------------------------------------------------
# Query parameter schemas
# ---------------------------------------------------------------------------

class MachineListQuerySchema(OffsetPaginationQuerySchema):
    """Query parameters for GET /machines."""
    name_contains = ma.fields.String(
        load_default=None,
        metadata={'description': 'Filter by substring in machine name'},
    )
    name_prefix = ma.fields.String(
        load_default=None,
        metadata={'description': 'Filter by machine name prefix'},
    )


class MachineRunsQuerySchema(CursorPaginationQuerySchema):
    """Query parameters for GET /machines/{name}/runs."""
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

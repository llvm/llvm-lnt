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
    name = ma.fields.String(
        required=True,
        metadata={'description': 'Machine name'},
    )
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
    uuid = ma.fields.String(
        required=True,
        metadata={'description': 'Server-generated UUID for the run'},
    )
    commit = ma.fields.String(
        allow_none=True,
        metadata={'description': 'Commit string for this run'},
    )
    submitted_at = ma.fields.String(
        allow_none=True,
        metadata={'description': 'Run submission time (ISO 8601)'},
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
    search = ma.fields.String(
        load_default=None,
        metadata={'description': 'Search machines by prefix across name '
                  'and searchable machine fields'},
    )


class MachineRunsQuerySchema(CursorPaginationQuerySchema):
    """Query parameters for GET /machines/{name}/runs."""
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

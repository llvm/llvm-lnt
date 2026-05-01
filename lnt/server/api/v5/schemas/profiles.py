"""Marshmallow schemas for profile responses in the v5 API."""

import marshmallow as ma

from . import BaseSchema


class ProfileListItemSchema(BaseSchema):
    """Schema for a single item in the profile listing.

    Returned by GET /runs/{uuid}/profiles.
    """
    test = ma.fields.String(
        required=True,
        metadata={'description': 'Test name'},
    )
    uuid = ma.fields.String(
        required=True,
        metadata={'description': 'Profile UUID'},
    )


class ProfileMetadataSchema(BaseSchema):
    """Schema for profile metadata + top-level counters.

    Returned by GET /profiles/{uuid}.
    """
    uuid = ma.fields.String(
        required=True,
        metadata={'description': 'Profile UUID'},
    )
    test = ma.fields.String(
        required=True,
        metadata={'description': 'Test name'},
    )
    run_uuid = ma.fields.String(
        required=True,
        metadata={'description': 'Run UUID'},
    )
    counters = ma.fields.Dict(
        keys=ma.fields.String(),
        values=ma.fields.Raw(),
        metadata={
            'description': 'Top-level counters (absolute values)',
            'example': {'cycles': 1500000, 'branch-misses': 2300},
        },
    )
    disassembly_format = ma.fields.String(
        metadata={'description': 'Disassembly format (e.g. llvm-objdump)'},
    )


class FunctionInfoSchema(BaseSchema):
    """Schema for a single function in the function list."""
    name = ma.fields.String(
        required=True,
        metadata={'description': 'Function name'},
    )
    counters = ma.fields.Dict(
        keys=ma.fields.String(),
        values=ma.fields.Raw(),
        metadata={
            'description': 'Counter values as percentages',
            'example': {'cycles': 45.2, 'branch-misses': 12.1},
        },
    )
    length = ma.fields.Integer(
        metadata={'description': 'Number of instructions'},
    )


class FunctionListResponseSchema(BaseSchema):
    """Schema for GET /profiles/{uuid}/functions."""
    functions = ma.fields.List(
        ma.fields.Nested(FunctionInfoSchema),
        metadata={'description': 'Functions sorted by hotness (descending)'},
    )


class InstructionSchema(BaseSchema):
    """Schema for a single instruction in the disassembly."""
    address = ma.fields.Raw(
        metadata={'description': 'Instruction address'},
    )
    counters = ma.fields.Dict(
        keys=ma.fields.String(),
        values=ma.fields.Raw(),
        metadata={
            'description': 'Counter values as percentages',
            'example': {'cycles': 0.8, 'branch-misses': 0.1},
        },
    )
    text = ma.fields.String(
        metadata={'description': 'Disassembly text'},
    )


class FunctionDetailSchema(BaseSchema):
    """Schema for GET /profiles/{uuid}/functions/{fn_name}."""
    name = ma.fields.String(
        required=True,
        metadata={'description': 'Function name'},
    )
    counters = ma.fields.Dict(
        keys=ma.fields.String(),
        values=ma.fields.Raw(),
        metadata={
            'description': 'Function-level counter aggregates',
            'example': {'cycles': 45.2, 'branch-misses': 12.1},
        },
    )
    disassembly_format = ma.fields.String(
        metadata={'description': 'Disassembly format (e.g. llvm-objdump)'},
    )
    instructions = ma.fields.List(
        ma.fields.Nested(InstructionSchema),
        metadata={'description': 'Disassembly with per-instruction counters'},
    )

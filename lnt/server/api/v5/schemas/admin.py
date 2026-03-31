"""Marshmallow schemas for the Admin / API Key endpoints.

Schemas:
- APIKeyCreateRequestSchema  -- POST request body (name, scope)
- APIKeyCreateResponseSchema -- POST response (raw key shown once, prefix, scope)
- APIKeyItemSchema           -- Item in list response (prefix, name, scope, etc.)
- APIKeyListResponseSchema   -- GET list response
"""

import marshmallow as ma

from . import BaseSchema
from ..auth import SCOPE_LEVELS


def _validate_scope(value):
    """Validate that the scope string is one of the known scope names."""
    if value not in SCOPE_LEVELS:
        raise ma.ValidationError(
            "Invalid scope '%s'. Must be one of: %s"
            % (value, ', '.join(sorted(SCOPE_LEVELS.keys(),
                                       key=lambda s: SCOPE_LEVELS[s])))
        )


class APIKeyCreateRequestSchema(BaseSchema):
    """Request body for POST /api/v5/admin/api-keys."""

    name = ma.fields.String(
        required=True,
        metadata={'description': 'Human-readable name for the API key'},
    )
    scope = ma.fields.String(
        required=True,
        validate=_validate_scope,
        metadata={
            'description': 'Scope level: read, submit, triage, manage, admin',
        },
    )


class APIKeyCreateResponseSchema(BaseSchema):
    """Response for POST /api/v5/admin/api-keys.

    The raw ``key`` value is shown exactly once and is never stored in
    plaintext.
    """

    key = ma.fields.String(
        required=True,
        metadata={'description': 'Raw API key token (shown once)'},
    )
    prefix = ma.fields.String(
        required=True,
        metadata={'description': 'First 8 characters of the token (used as identifier)'},
    )
    scope = ma.fields.String(
        required=True,
        metadata={'description': 'Granted scope level'},
    )


class APIKeyItemSchema(BaseSchema):
    """Schema for a single API key in the list response.

    Never includes the key hash or the raw token.
    """

    prefix = ma.fields.String(required=True)
    name = ma.fields.String(required=True)
    scope = ma.fields.String(required=True)
    created_at = ma.fields.DateTime(required=True)
    last_used_at = ma.fields.DateTime(allow_none=True)
    is_active = ma.fields.Boolean(required=True)


class APIKeyListResponseSchema(BaseSchema):
    """Response for GET /api/v5/admin/api-keys."""

    items = ma.fields.List(
        ma.fields.Nested(APIKeyItemSchema),
        required=True,
    )

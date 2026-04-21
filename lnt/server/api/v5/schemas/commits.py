"""Marshmallow schemas for commit request/response in the v5 API.

Commits replace the v4 "orders" concept.  Each commit has a unique
commit string, an optional integer ordinal for sorting, and dynamic
commit_fields defined in the test suite schema.
"""

import marshmallow as ma

from . import BaseSchema
from .common import BaseQuerySchema, CursorPaginationQuerySchema, PaginatedResponseSchema


# ---------------------------------------------------------------------------
# Response schemas
# ---------------------------------------------------------------------------

class CommitSummarySchema(BaseSchema):
    """A single commit in a list response."""
    commit = ma.fields.String(
        required=True,
        metadata={'description': 'Unique commit identifier (e.g. git SHA)'},
    )
    ordinal = ma.fields.Integer(
        allow_none=True,
        metadata={'description': 'Optional integer for total ordering'},
    )
    tag = ma.fields.String(
        allow_none=True,
        metadata={'description': 'Optional human-readable tag (e.g. release-18)'},
    )
    fields = ma.fields.Dict(
        keys=ma.fields.String(),
        values=ma.fields.Raw(allow_none=True),
        metadata={
            'description': 'Commit field values defined by the test suite schema',
            'example': {'llvm_project_revision': 'abc123'},
        },
    )


class CommitNeighborSchema(BaseSchema):
    """Reference to a previous or next commit."""
    commit = ma.fields.String(
        metadata={'description': 'Commit identifier'},
    )
    ordinal = ma.fields.Integer(
        allow_none=True,
        metadata={'description': 'Ordinal value'},
    )
    tag = ma.fields.String(
        allow_none=True,
        metadata={'description': 'Tag value'},
    )
    link = ma.fields.String(
        allow_none=True,
        metadata={'description': 'URL to fetch the referenced commit'},
    )


class CommitDetailSchema(BaseSchema):
    """Full commit detail including previous/next neighbors."""
    commit = ma.fields.String(
        required=True,
        metadata={'description': 'Unique commit identifier (e.g. git SHA)'},
    )
    ordinal = ma.fields.Integer(
        allow_none=True,
        metadata={'description': 'Optional integer for total ordering'},
    )
    tag = ma.fields.String(
        allow_none=True,
        metadata={'description': 'Optional human-readable tag (e.g. release-18)'},
    )
    fields = ma.fields.Dict(
        keys=ma.fields.String(),
        values=ma.fields.Raw(allow_none=True),
        metadata={'description': 'Commit field values defined by the test suite schema'},
    )
    previous_commit = ma.fields.Nested(
        CommitNeighborSchema, allow_none=True,
        metadata={'description': 'Previous commit by ordinal'},
    )
    next_commit = ma.fields.Nested(
        CommitNeighborSchema, allow_none=True,
        metadata={'description': 'Next commit by ordinal'},
    )


# ---------------------------------------------------------------------------
# Paginated response schemas
# ---------------------------------------------------------------------------

class PaginatedCommitResponseSchema(PaginatedResponseSchema):
    """Paginated list of commits."""
    items = ma.fields.List(ma.fields.Nested(CommitSummarySchema))


# ---------------------------------------------------------------------------
# Query parameter schemas
# ---------------------------------------------------------------------------

class CommitListQuerySchema(CursorPaginationQuerySchema):
    """Query parameters for GET /commits."""
    search = ma.fields.String(
        load_default=None,
        metadata={'description': 'Search commits by prefix across commit '
                  'string and searchable commit fields'},
    )
    machine = ma.fields.String(
        load_default=None,
        metadata={'description': 'Filter to commits with runs on this machine'},
    )
    sort = ma.fields.String(
        load_default=None,
        validate=ma.validate.OneOf(['ordinal']),
        metadata={'description': "Sort order. Use 'ordinal' to sort by ordinal "
                  "(excludes commits without ordinals)"},
    )


class CommitDetailQuerySchema(BaseQuerySchema):
    """Query parameters for GET /commits/{value}."""
    pass


# ---------------------------------------------------------------------------
# Request body schemas
# ---------------------------------------------------------------------------

class CommitCreateSchema(BaseSchema):
    """Request body for POST /commits."""
    class Meta:
        unknown = ma.INCLUDE

    commit = ma.fields.String(
        required=True,
        metadata={'description': 'Unique commit identifier (e.g. git SHA)'},
    )
    ordinal = ma.fields.Integer(
        load_default=None,
        allow_none=True,
        metadata={'description': 'Optional integer for total ordering'},
    )


class CommitUpdateSchema(BaseSchema):
    """Request body for PATCH /commits/{value}."""
    class Meta:
        unknown = ma.INCLUDE

    ordinal = ma.fields.Integer(
        load_default=None,
        allow_none=True,
        metadata={'description': 'Integer for total ordering, or null to clear'},
    )
    tag = ma.fields.String(
        allow_none=True,
        validate=ma.validate.Length(max=256),
        metadata={'description': 'Human-readable tag, or null to clear'},
    )


# ---------------------------------------------------------------------------
# Batch resolve schemas
# ---------------------------------------------------------------------------

class CommitResolveRequestSchema(BaseSchema):
    """Request body for POST /commits/resolve."""
    commits = ma.fields.List(
        ma.fields.String(),
        required=True,
        validate=ma.validate.Length(min=1),
        metadata={
            'description': 'Commit identity strings to resolve',
            'example': ['abc123', 'def456'],
        },
    )


class CommitResolveResponseSchema(BaseSchema):
    """Response body for POST /commits/resolve."""
    results = ma.fields.Dict(
        keys=ma.fields.String(),
        values=ma.fields.Nested(CommitSummarySchema),
        required=True,
        metadata={'description': 'Resolved commits keyed by commit string'},
    )
    not_found = ma.fields.List(
        ma.fields.String(),
        required=True,
        metadata={'description': 'Commit strings not found in the database'},
    )

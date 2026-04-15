"""Common schemas used across v5 API endpoints: error responses, pagination
envelopes, and field metadata schemas.
"""

import marshmallow as ma

from . import BaseSchema


# ---------------------------------------------------------------------------
# Error schemas
# ---------------------------------------------------------------------------

class ErrorDetailSchema(BaseSchema):
    code = ma.fields.String(required=True,
                            metadata={'description': 'Machine-readable error code'})
    message = ma.fields.String(required=True,
                               metadata={'description': 'Human-readable error description'})


class ErrorResponseSchema(BaseSchema):
    error = ma.fields.Nested(ErrorDetailSchema, required=True)


# ---------------------------------------------------------------------------
# Pagination schemas
# ---------------------------------------------------------------------------

class CursorSchema(BaseSchema):
    next = ma.fields.String(allow_none=True, load_default=None,
                            metadata={'description': 'Cursor for the next page'})
    previous = ma.fields.String(allow_none=True, load_default=None,
                                metadata={'description': 'Reserved for future use (always null)'})


class PaginatedResponseSchema(BaseSchema):
    """Base envelope for paginated list responses.

    Subclasses should add an ``items`` field with the appropriate nested
    schema.
    """
    cursor = ma.fields.Nested(CursorSchema)
    total = ma.fields.Integer(allow_none=True, load_default=None,
                              metadata={'description': 'Total count (for bounded lists)'})


# ---------------------------------------------------------------------------
# Field metadata schemas
# ---------------------------------------------------------------------------

class TestSuiteLinksSchema(BaseSchema):
    """Links to resources within a test suite."""
    machines = ma.fields.String(metadata={'description': 'URL for machines list'})
    commits = ma.fields.String(metadata={'description': 'URL for commits list'})
    runs = ma.fields.String(metadata={'description': 'URL for runs list'})
    tests = ma.fields.String(metadata={'description': 'URL for tests list'})
    regressions = ma.fields.String(metadata={'description': 'URL for regressions list'})
    query = ma.fields.String(metadata={'description': 'URL for time-series query endpoint'})


class TestSuiteDiscoverySchema(BaseSchema):
    """A single test suite in the discovery response."""
    name = ma.fields.String(required=True)
    links = ma.fields.Nested(TestSuiteLinksSchema, required=True)


class DiscoveryLinksSchema(BaseSchema):
    """Top-level links in the discovery response."""
    openapi = ma.fields.String(metadata={'description': 'URL for OpenAPI JSON spec'})
    swagger_ui = ma.fields.String(metadata={'description': 'URL for Swagger UI'})
    test_suites = ma.fields.String(metadata={'description': 'URL for test suites list'})


class DiscoveryResponseSchema(BaseSchema):
    """Response schema for GET /api/v5/."""
    test_suites = ma.fields.List(ma.fields.Nested(TestSuiteDiscoverySchema))
    links = ma.fields.Nested(DiscoveryLinksSchema)


# ---------------------------------------------------------------------------
# Query parameter schemas
# ---------------------------------------------------------------------------

class BaseQuerySchema(BaseSchema):
    """Base class for query parameter schemas.

    Sets ``unknown = EXCLUDE`` so that marshmallow ignores unknown
    parameters (they are still rejected by ``reject_unknown_params``).
    """

    class Meta:
        ordered = True
        unknown = ma.EXCLUDE


class CursorPaginationQuerySchema(BaseQuerySchema):
    """Query parameters for cursor-paginated endpoints."""
    cursor = ma.fields.String(
        load_default=None,
        metadata={'description': 'Pagination cursor from a previous response'},
    )
    limit = ma.fields.Integer(
        load_default=25,
        metadata={'description': 'Maximum number of results per page (default 25, max 500)'},
    )


class OffsetPaginationQuerySchema(BaseQuerySchema):
    """Query parameters for offset-paginated endpoints."""
    limit = ma.fields.Integer(
        load_default=25,
        metadata={'description': 'Maximum number of results per page (default 25, max 500)'},
    )
    offset = ma.fields.Integer(
        load_default=0,
        metadata={'description': 'Number of results to skip (default 0)'},
    )

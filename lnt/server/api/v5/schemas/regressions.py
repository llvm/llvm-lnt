"""Marshmallow schemas for regression, indicator, and field change
request/response in the v5 API.
"""

import logging
import marshmallow as ma
from webargs import fields as webargs_fields

logger = logging.getLogger(__name__)

from . import BaseSchema
from .common import CursorPaginationQuerySchema, PaginatedResponseSchema


# ---------------------------------------------------------------------------
# State mapping: API string <-> DB integer (v5 values: 0-6)
# ---------------------------------------------------------------------------

STATE_TO_DB = {
    'detected': 0,
    'staged': 1,
    'active': 2,
    'not_to_be_fixed': 3,
    'ignored': 4,
    'fixed': 5,
    'detected_fixed': 6,
}

DB_TO_STATE = {v: k for k, v in STATE_TO_DB.items()}

VALID_STATES = sorted(STATE_TO_DB.keys())


def state_to_api(db_value):
    """Convert a DB integer state to the API string representation.

    Returns ``'unknown_<db_value>'`` and logs a warning when the value
    does not map to any known state, instead of silently falling back
    to ``'detected'`` which would mask data corruption.
    """
    try:
        return DB_TO_STATE[db_value]
    except KeyError:
        logger.warning("Unknown regression state in DB: %r", db_value)
        return f'unknown_{db_value}'


def state_to_db(api_string):
    """Convert an API string state to the DB integer representation.

    Returns None if the string is not a valid state.
    """
    return STATE_TO_DB.get(api_string)


# ---------------------------------------------------------------------------
# Indicator / field change schemas
# ---------------------------------------------------------------------------

class IndicatorResponseSchema(BaseSchema):
    """Schema for a single regression indicator (embedded in regression
    detail or in the indicators list endpoint).
    """
    field_change_uuid = ma.fields.String(
        required=True,
        metadata={'description': 'UUID of the field change'},
    )
    test = ma.fields.String(
        required=True,
        metadata={'description': 'Name of the test'},
    )
    machine = ma.fields.String(
        required=True,
        metadata={'description': 'Name of the machine'},
    )
    metric = ma.fields.String(
        required=True,
        metadata={'description': 'Metric name (as defined in the test suite schema)'},
    )
    old_value = ma.fields.Float(
        allow_none=True,
        metadata={'description': 'Previous value'},
    )
    new_value = ma.fields.Float(
        allow_none=True,
        metadata={'description': 'New value'},
    )
    start_commit = ma.fields.String(
        allow_none=True,
        metadata={'description': 'Start commit identity string'},
    )
    end_commit = ma.fields.String(
        allow_none=True,
        metadata={'description': 'End commit identity string'},
    )


class FieldChangeResponseSchema(BaseSchema):
    """Schema for an unassigned field change in the field-changes list."""
    uuid = ma.fields.String(
        required=True,
        metadata={'description': 'Field change UUID'},
    )
    test = ma.fields.String(
        required=True,
        metadata={'description': 'Name of the test'},
    )
    machine = ma.fields.String(
        required=True,
        metadata={'description': 'Name of the machine'},
    )
    metric = ma.fields.String(
        required=True,
        metadata={'description': 'Metric name (as defined in the test suite schema)'},
    )
    old_value = ma.fields.Float(
        allow_none=True,
        metadata={'description': 'Previous value'},
    )
    new_value = ma.fields.Float(
        allow_none=True,
        metadata={'description': 'New value'},
    )
    start_commit = ma.fields.String(
        allow_none=True,
        metadata={'description': 'Start commit identity string'},
    )
    end_commit = ma.fields.String(
        allow_none=True,
        metadata={'description': 'End commit identity string'},
    )


class FieldChangeCreateSchema(BaseSchema):
    """Schema for POST /field-changes request body."""
    machine = ma.fields.String(
        required=True,
        metadata={'description': 'Name of the machine'},
    )
    test = ma.fields.String(
        required=True,
        metadata={'description': 'Name of the test'},
    )
    metric = ma.fields.String(
        required=True,
        metadata={'description': 'Metric name (as defined in the test suite schema)'},
    )
    old_value = ma.fields.Float(
        required=True,
        metadata={'description': 'Previous value'},
    )
    new_value = ma.fields.Float(
        required=True,
        metadata={'description': 'New value'},
    )
    start_commit = ma.fields.String(
        required=True,
        metadata={'description': 'Commit identity string for start of change'},
    )
    end_commit = ma.fields.String(
        required=True,
        metadata={'description': 'Commit identity string for end of change'},
    )


# ---------------------------------------------------------------------------
# Regression request schemas
# ---------------------------------------------------------------------------

class RegressionCreateSchema(BaseSchema):
    """Schema for POST /regressions request body."""
    field_change_uuids = ma.fields.List(
        ma.fields.String(),
        required=True,
        validate=ma.validate.Length(min=1),
        metadata={'description': 'List of field change UUIDs to include'},
    )
    title = ma.fields.String(
        load_default=None,
        metadata={'description': 'Optional title (auto-generated if omitted)'},
    )
    bug = ma.fields.String(
        load_default=None,
        metadata={'description': 'Optional bug URL'},
    )
    state = ma.fields.String(
        load_default=None,
        validate=ma.validate.OneOf(VALID_STATES),
        metadata={'description': 'Optional initial state (default: detected)',
                  'enum': VALID_STATES},
    )


class RegressionUpdateSchema(BaseSchema):
    """Schema for PATCH /regressions/{uuid} request body."""
    title = ma.fields.String(
        metadata={'description': 'New title'},
    )
    bug = ma.fields.String(
        metadata={'description': 'New bug URL'},
    )
    state = ma.fields.String(
        validate=ma.validate.OneOf(VALID_STATES),
        metadata={'description': 'New state', 'enum': VALID_STATES},
    )


class RegressionMergeSchema(BaseSchema):
    """Schema for POST /regressions/{uuid}/merge request body."""
    source_regression_uuids = ma.fields.List(
        ma.fields.String(),
        required=True,
        validate=ma.validate.Length(min=1),
        metadata={'description': 'UUIDs of regressions to merge into this one'},
    )


class RegressionSplitSchema(BaseSchema):
    """Schema for POST /regressions/{uuid}/split request body."""
    field_change_uuids = ma.fields.List(
        ma.fields.String(),
        required=True,
        validate=ma.validate.Length(min=1),
        metadata={'description': 'Field change UUIDs to split into a new regression'},
    )


class IndicatorAddSchema(BaseSchema):
    """Schema for POST /regressions/{uuid}/indicators request body."""
    field_change_uuid = ma.fields.String(
        required=True,
        metadata={'description': 'UUID of the field change to add'},
    )


# ---------------------------------------------------------------------------
# Regression response schemas
# ---------------------------------------------------------------------------

class RegressionListItemSchema(BaseSchema):
    """Schema for a regression in list responses (without embedded
    indicators).
    """
    uuid = ma.fields.String(required=True)
    title = ma.fields.String(allow_none=True)
    bug = ma.fields.String(allow_none=True)
    state = ma.fields.String(
        required=True,
        metadata={'description': 'Regression state', 'enum': VALID_STATES},
    )


class RegressionDetailSchema(BaseSchema):
    """Schema for a single regression detail response (with embedded
    indicators).
    """
    uuid = ma.fields.String(required=True)
    title = ma.fields.String(allow_none=True)
    bug = ma.fields.String(allow_none=True)
    state = ma.fields.String(
        required=True,
        metadata={'description': 'Regression state', 'enum': VALID_STATES},
    )
    indicators = ma.fields.List(
        ma.fields.Nested(IndicatorResponseSchema),
        metadata={'description': 'Embedded list of regression indicators'},
    )


# ---------------------------------------------------------------------------
# Paginated response schemas
# ---------------------------------------------------------------------------

class PaginatedRegressionListSchema(PaginatedResponseSchema):
    """Paginated list of regressions (without embedded indicators)."""
    items = ma.fields.List(ma.fields.Nested(RegressionListItemSchema))


class PaginatedIndicatorResponseSchema(PaginatedResponseSchema):
    """Paginated list of regression indicators."""
    items = ma.fields.List(ma.fields.Nested(IndicatorResponseSchema))


class PaginatedFieldChangeResponseSchema(PaginatedResponseSchema):
    """Paginated list of unassigned field changes."""
    items = ma.fields.List(ma.fields.Nested(FieldChangeResponseSchema))


# ---------------------------------------------------------------------------
# Query parameter schemas
# ---------------------------------------------------------------------------

class RegressionListQuerySchema(CursorPaginationQuerySchema):
    """Query parameters for GET /regressions."""
    state = webargs_fields.DelimitedList(
        ma.fields.String(),
        load_default=[],
        metadata={'description': 'Filter by state (comma-separated, e.g. active,detected)'},
    )
    machine = ma.fields.String(
        load_default=None,
        metadata={'description': 'Filter by machine name'},
    )
    test = ma.fields.String(
        load_default=None,
        metadata={'description': 'Filter by test name'},
    )
    metric = ma.fields.String(
        load_default=None,
        metadata={'description': 'Filter by metric name'},
    )


class RegressionIndicatorsQuerySchema(CursorPaginationQuerySchema):
    """Query parameters for GET /regressions/{uuid}/indicators."""
    pass


class FieldChangeListQuerySchema(CursorPaginationQuerySchema):
    """Query parameters for GET /field-changes."""
    machine = ma.fields.String(
        load_default=None,
        metadata={'description': 'Filter by machine name'},
    )
    test = ma.fields.String(
        load_default=None,
        metadata={'description': 'Filter by test name'},
    )
    metric = ma.fields.String(
        load_default=None,
        metadata={'description': 'Filter by metric name'},
    )

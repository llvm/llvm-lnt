"""Marshmallow schemas for regression and indicator request/response
in the v5 API.
"""

import logging
import marshmallow as ma
from webargs import fields as webargs_fields

logger = logging.getLogger(__name__)

from . import BaseSchema
from .common import CursorPaginationQuerySchema, PaginatedResponseSchema


# ---------------------------------------------------------------------------
# State mapping: API string <-> DB integer (v5 values: 0-4)
# ---------------------------------------------------------------------------

STATE_TO_DB = {
    'detected': 0,
    'active': 1,
    'not_to_be_fixed': 2,
    'fixed': 3,
    'false_positive': 4,
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
# Indicator schemas
# ---------------------------------------------------------------------------

class IndicatorResponseSchema(BaseSchema):
    """Schema for a single regression indicator."""
    uuid = ma.fields.String(
        required=True,
        metadata={'description': 'Indicator UUID'},
    )
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
        metadata={'description': 'Metric name'},
    )


class IndicatorInputSchema(BaseSchema):
    """Schema for a single indicator input ({machine, test, metric})."""
    machine = ma.fields.String(
        required=True,
        metadata={'description': 'Machine name'},
    )
    test = ma.fields.String(
        required=True,
        metadata={'description': 'Test name'},
    )
    metric = ma.fields.String(
        required=True,
        metadata={'description': 'Metric name'},
    )


class IndicatorAddSchema(BaseSchema):
    """Schema for POST /regressions/{uuid}/indicators request body."""
    indicators = ma.fields.List(
        ma.fields.Nested(IndicatorInputSchema),
        required=True,
        validate=ma.validate.Length(min=1),
        metadata={'description': 'List of {machine, test, metric} indicators to add'},
    )


class IndicatorRemoveSchema(BaseSchema):
    """Schema for DELETE /regressions/{uuid}/indicators request body."""
    indicator_uuids = ma.fields.List(
        ma.fields.String(),
        required=True,
        validate=ma.validate.Length(min=1),
        metadata={'description': 'UUIDs of indicators to remove'},
    )


# ---------------------------------------------------------------------------
# Regression request schemas
# ---------------------------------------------------------------------------

class RegressionCreateSchema(BaseSchema):
    """Schema for POST /regressions request body."""
    title = ma.fields.String(
        load_default=None,
        metadata={'description': 'Optional title (auto-generated if omitted)'},
    )
    bug = ma.fields.String(
        load_default=None,
        metadata={'description': 'Optional bug URL'},
    )
    notes = ma.fields.String(
        load_default=None,
        metadata={'description': 'Optional investigation notes'},
    )
    state = ma.fields.String(
        load_default=None,
        validate=ma.validate.OneOf(VALID_STATES),
        metadata={'description': 'Optional initial state (default: detected)',
                  'enum': VALID_STATES},
    )
    commit = ma.fields.String(
        load_default=None,
        metadata={'description': 'Optional suspected introduction commit (resolved by value)'},
    )
    indicators = ma.fields.List(
        ma.fields.Nested(IndicatorInputSchema),
        load_default=[],
        metadata={'description': 'Optional list of {machine, test, metric} indicators'},
    )


class RegressionUpdateSchema(BaseSchema):
    """Schema for PATCH /regressions/{uuid} request body.

    Fields must NOT have ``load_default`` — the PATCH handler uses
    ``'key' in body`` to distinguish absent fields (leave unchanged) from
    fields sent as ``null`` (clear the value).
    """
    title = ma.fields.String(
        metadata={'description': 'New title'},
    )
    bug = ma.fields.String(
        allow_none=True,
        metadata={'description': 'New bug URL (null to clear)'},
    )
    notes = ma.fields.String(
        allow_none=True,
        metadata={'description': 'New notes (null to clear)'},
    )
    state = ma.fields.String(
        validate=ma.validate.OneOf(VALID_STATES),
        metadata={'description': 'New state', 'enum': VALID_STATES},
    )
    commit = ma.fields.String(
        allow_none=True,
        metadata={'description': 'Suspected introduction commit (null to clear)'},
    )


# ---------------------------------------------------------------------------
# Regression response schemas
# ---------------------------------------------------------------------------

class RegressionListItemSchema(BaseSchema):
    """Schema for a regression in list responses."""
    uuid = ma.fields.String(
        required=True,
        metadata={'description': 'Regression UUID'},
    )
    title = ma.fields.String(
        allow_none=True,
        metadata={'description': 'Regression title'},
    )
    bug = ma.fields.String(
        allow_none=True,
        metadata={'description': 'Bug tracker URL'},
    )
    state = ma.fields.String(
        required=True,
        metadata={'description': 'Regression state', 'enum': VALID_STATES},
    )
    commit = ma.fields.String(
        allow_none=True,
        metadata={'description': 'Suspected introduction commit (identity string)'},
    )
    machine_count = ma.fields.Integer(
        metadata={'description': 'Number of distinct machines across indicators'},
    )
    test_count = ma.fields.Integer(
        metadata={'description': 'Number of distinct tests across indicators'},
    )


class RegressionDetailSchema(BaseSchema):
    """Schema for a single regression detail response."""
    uuid = ma.fields.String(
        required=True,
        metadata={'description': 'Regression UUID'},
    )
    title = ma.fields.String(
        allow_none=True,
        metadata={'description': 'Regression title'},
    )
    bug = ma.fields.String(
        allow_none=True,
        metadata={'description': 'Bug tracker URL'},
    )
    notes = ma.fields.String(
        allow_none=True,
        metadata={'description': 'Investigation notes'},
    )
    state = ma.fields.String(
        required=True,
        metadata={'description': 'Regression state', 'enum': VALID_STATES},
    )
    commit = ma.fields.String(
        allow_none=True,
        metadata={'description': 'Suspected introduction commit (identity string)'},
    )
    indicators = ma.fields.List(
        ma.fields.Nested(IndicatorResponseSchema),
        metadata={'description': 'Embedded list of regression indicators'},
    )


# ---------------------------------------------------------------------------
# Paginated response schemas
# ---------------------------------------------------------------------------

class PaginatedRegressionListSchema(PaginatedResponseSchema):
    """Paginated list of regressions."""
    items = ma.fields.List(ma.fields.Nested(RegressionListItemSchema))


# ---------------------------------------------------------------------------
# Query parameter schemas
# ---------------------------------------------------------------------------

class RegressionListQuerySchema(CursorPaginationQuerySchema):
    """Query parameters for GET /regressions."""
    state = webargs_fields.DelimitedList(
        ma.fields.String(),
        load_default=[],
        metadata={'description': 'Filter by state (comma-separated)'},
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
    commit = ma.fields.String(
        load_default=None,
        metadata={'description': 'Filter by commit (regressions whose commit_id matches)'},
    )
    has_commit = ma.fields.Boolean(
        load_default=None,
        metadata={'description': 'Filter: true = has commit, false = no commit'},
    )

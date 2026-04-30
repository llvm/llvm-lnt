"""Base schema utilities for the v5 API.

Provides a common base class and helpers for building marshmallow schemas
that work with flask-smorest and LNT's dynamic test-suite models.
"""

import marshmallow as ma


class BaseSchema(ma.Schema):
    """Common base for all v5 API schemas.

    Configured to:
    - Raise on unknown fields by default
    - Use ``ordered`` output for consistent JSON
    """

    class Meta:
        ordered = True

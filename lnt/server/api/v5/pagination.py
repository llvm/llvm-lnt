"""Cursor-based and offset pagination utilities for the v5 API.

Cursor-based pagination encodes the last-seen primary key as base64.
Forward-only in v1 (``previous`` is always null).

Response envelope:
    {"items": [...], "cursor": {"next": "...", "previous": null}}
"""

import base64


def encode_cursor(value):
    """Encode an integer ID into a base64 cursor string."""
    return base64.urlsafe_b64encode(str(value).encode('utf-8')).decode('ascii')


def decode_cursor(cursor_str):
    """Decode a base64 cursor string back into an integer ID.

    Returns None if the cursor is malformed.
    """
    if not cursor_str:
        return None
    try:
        decoded = base64.urlsafe_b64decode(cursor_str.encode('ascii'))
        return int(decoded.decode('utf-8'))
    except (ValueError, TypeError, UnicodeDecodeError):
        return None


def cursor_paginate(query, id_column, cursor_str=None, limit=25,
                    descending=False):
    """Apply cursor-based pagination to a SQLAlchemy query.

    Parameters
    ----------
    query : sqlalchemy.orm.Query
        The base query to paginate.  Callers should **not** apply their
        own ``.order_by()`` for the paginated column -- this function
        handles ordering.
    id_column : sqlalchemy.Column
        The column used for ordering and cursor position (usually `Model.id`).
    cursor_str : str or None
        The cursor from the previous response (``cursor.next``).
    limit : int
        Maximum number of items to return.
    descending : bool
        When *True*, order by ``id_column DESC`` and page forward with
        ``id_column < last_id``.  Default is ascending order.

    Returns
    -------
    (items, next_cursor) : (list, str or None)
        The page of results and the cursor for the next page (or None if
        there are no more results).
    """
    limit = min(max(limit, 1), 10000)

    if cursor_str:
        last_id = decode_cursor(cursor_str)
        if last_id is None:
            from flask import abort
            abort(400, description="Invalid pagination cursor")
        if descending:
            query = query.filter(id_column < last_id)
        else:
            query = query.filter(id_column > last_id)

    if descending:
        query = query.order_by(id_column.desc())
    else:
        query = query.order_by(id_column.asc())

    # Fetch one extra to detect if there is a next page.
    items = query.limit(limit + 1).all()

    if len(items) > limit:
        items = items[:limit]
        next_cursor = encode_cursor(getattr(items[-1], id_column.key))
    else:
        next_cursor = None

    return items, next_cursor


def make_paginated_response(items, next_cursor, total=None):
    """Build the standard paginated response envelope.

    Parameters
    ----------
    items : list
        The serialized items for this page.
    next_cursor : str or None
        Cursor string for the next page.
    total : int or None
        Total count (included for offset-based pagination).

    Returns
    -------
    dict
    """
    result = {
        'items': items,
        'cursor': {
            'next': next_cursor,
            'previous': None,  # Forward-only in v1
        },
    }
    if total is not None:
        result['total'] = total
    return result

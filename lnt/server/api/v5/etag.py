"""ETag computation and conditional request support for the v5 API.

Uses weak ETags (``W/"<md5>"``) computed from the JSON-serialized response
body. Checks ``If-None-Match`` and returns 304 when appropriate.
"""

import hashlib
import json

from flask import request


def compute_etag(data):
    """Compute a weak ETag from a Python object (dict/list).

    The object is serialized to compact JSON and hashed with MD5.
    """
    serialized = json.dumps(data, sort_keys=True, separators=(',', ':'))
    md5 = hashlib.md5(serialized.encode('utf-8')).hexdigest()
    return 'W/"%s"' % md5


def check_etag(etag_value):
    """Check ``If-None-Match`` against the given ETag.

    Returns a 304 Not Modified response if the client already has the
    current version, otherwise returns None.
    """
    if_none_match = request.headers.get('If-None-Match', '')
    if not if_none_match:
        return None

    # Parse comma-separated ETags per RFC 7232
    client_etags = [e.strip() for e in if_none_match.split(',')]
    # Normalise: strip W/ prefix for comparison

    def normalise(e):
        if e.startswith('W/'):
            return e[2:]
        return e

    normalised_server = normalise(etag_value)
    for client_etag in client_etags:
        if client_etag == '*' or normalise(client_etag) == normalised_server:
            from flask import Response
            resp = Response(status=304)
            resp.headers['ETag'] = etag_value
            return resp

    return None


def add_etag_to_response(response, data):
    """Compute an ETag from *data* and set it on *response*.

    Also checks ``If-None-Match``. If the client already has the
    current version, returns a 304 response instead.
    """
    etag_value = compute_etag(data)

    not_modified = check_etag(etag_value)
    if not_modified is not None:
        return not_modified

    response.headers['ETag'] = etag_value
    return response

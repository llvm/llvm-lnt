"""Standardized error handling scoped to the v5 API.

Produces responses in the format:
    {"error": {"code": "not_found", "message": "Machine 'foo' not found"}}

Error handlers are registered on the flask-smorest Api / Flask app but only
apply to v5 API paths to avoid breaking v4 error format.

IMPORTANT: ``register_error_handlers`` must be called AFTER any app-level
error handlers (e.g. the 404/500 handlers in ``app.py``) so that we can
save and delegate to them for non-v5 routes.
"""

import logging

from flask import jsonify, request
from werkzeug.exceptions import HTTPException

logger = logging.getLogger(__name__)


# Map HTTP status codes to error code strings
STATUS_CODE_MAP = {
    400: 'validation_error',
    401: 'unauthorized',
    403: 'forbidden',
    404: 'not_found',
    405: 'method_not_allowed',
    409: 'conflict',
    415: 'unsupported_media_type',
    422: 'validation_error',
    429: 'rate_limited',
    500: 'internal_error',
}


class V5ApiError(Exception):
    """Custom exception for v5 API errors.

    Raised by ``abort_with_error`` and caught by a Flask error handler
    registered in ``register_error_handlers``.  This replaces the previous
    ``flask.abort(response)`` pattern which relied on Flask's undocumented
    behaviour of passing through Response objects wrapped in an HTTPException
    with ``code=None``.
    """

    def __init__(self, status_code, error_code, message):
        super().__init__(message)
        self.status_code = status_code
        self.error_code = error_code
        self.message = message


def _make_error_response(code, message, status_code):
    """Build a standardized error JSON response."""
    resp = jsonify({
        'error': {
            'code': code,
            'message': message,
        }
    })
    resp.status_code = status_code
    return resp


def _get_previous_handler(app, code):
    """Return the previously registered error handler for *code*, or None.

    Flask stores app-level handlers in
    ``app.error_handler_spec[None][code]``.  We look up the handler for
    the given integer status code (or ``None`` for exception-class-keyed
    handlers).
    """
    spec = app.error_handler_spec.get(None, {})
    handlers = spec.get(code, {})
    if not handlers:
        return None
    # The dict is keyed by exception class; return the first (there is
    # usually only one per code).
    for handler in handlers.values():
        return handler
    return None


def _non_v5_fallback(exc, previous_handler):
    """Handle *exc* on a non-v5 route.

    If a *previous_handler* (the one that was registered before v5's)
    exists, delegate to it so that app-level error formatting (e.g.
    the content-negotiating 404/500 handlers in ``app.py``) is
    preserved.  Otherwise fall back to werkzeug's default HTML
    response — which is exactly what Flask itself does when no error
    handler is registered.
    """
    if previous_handler is not None:
        return previous_handler(exc)
    return exc.get_response()


def register_error_handlers(smorest_api, app):
    """Register error handlers scoped to v5 API paths.

    We register on the Flask app itself, but the handlers check
    ``request.path`` so they only transform responses for ``/api/v5/``
    routes.  For non-v5 routes the previously registered handler (if
    any) is called, preserving v4 / Flask-RESTful error formatting.

    This function MUST be called after any app-level error handlers
    (404, 500, etc.) have been registered, so that the saved
    ``previous_handler`` references are valid.
    """

    @app.errorhandler(V5ApiError)
    def handle_v5_api_error(exc):
        return _make_error_response(exc.error_code, exc.message,
                                    exc.status_code)

    # -- HTTPException (generic) ------------------------------------------
    prev_http = _get_previous_handler(app, None)

    @app.errorhandler(HTTPException)
    def handle_http_exception(exc):
        if not request.path.startswith('/api/v5/'):
            if prev_http is not None:
                return prev_http(exc)
            return exc.get_response()

        status_code = exc.code or 500
        error_code = STATUS_CODE_MAP.get(status_code, 'error')
        message = exc.description or str(exc)

        return _make_error_response(error_code, message, status_code)

    # -- 422 Unprocessable Entity (webargs validation) --------------------
    prev_422 = _get_previous_handler(app, 422)

    @app.errorhandler(422)
    def handle_unprocessable(exc):
        if not request.path.startswith('/api/v5/'):
            return _non_v5_fallback(exc, prev_422)

        # flask-smorest/webargs validation errors include details
        messages = getattr(exc, 'data', {}).get('messages', {})
        if messages:
            detail = str(messages)
        else:
            detail = getattr(exc, 'description', str(exc))

        return _make_error_response('validation_error', detail, 422)

    # -- Per-status-code handlers -----------------------------------------
    # Register explicit handlers for common status codes so that they take
    # priority over the app-level 404/500 handlers registered in app.py.
    # Flask dispatches to the most-specific (by status code) handler, so a
    # generic HTTPException handler alone is not enough.
    for _code in (400, 401, 403, 404, 405, 409, 500):
        def _make_handler(code, previous_handler):
            def _handler(exc):
                if not request.path.startswith('/api/v5/'):
                    return _non_v5_fallback(exc, previous_handler)
                error_code = STATUS_CODE_MAP.get(code, 'error')
                message = getattr(exc, 'description', str(exc))
                return _make_error_response(error_code, message, code)
            _handler.__name__ = 'handle_v5_%d' % code
            return _handler
        _prev = _get_previous_handler(app, _code)
        app.errorhandler(_code)(_make_handler(_code, _prev))

    # -- Generic Exception handler ----------------------------------------
    @app.errorhandler(Exception)
    def handle_generic_exception(exc):
        # V5ApiError is handled by its own dedicated handler above.
        if isinstance(exc, V5ApiError):
            return handle_v5_api_error(exc)

        if not request.path.startswith('/api/v5/'):
            if isinstance(exc, HTTPException):
                # Delegate to the per-code or generic HTTP handler so that
                # app-level formatting is preserved.
                return handle_http_exception(exc)
            raise exc

        # If it is an HTTPException, delegate to the HTTP handler
        if isinstance(exc, HTTPException):
            return handle_http_exception(exc)

        logger.exception("Unhandled exception in v5 API")
        return _make_error_response('internal_error',
                                    'An unexpected error occurred.', 500)


def abort_with_error(status_code, message):
    """Abort the current request with a standardized v5 error response.

    Raises a :class:`V5ApiError` which is caught by the handler registered
    in :func:`register_error_handlers` and converted into a JSON response.
    """
    error_code = STATUS_CODE_MAP.get(status_code, 'error')
    raise V5ApiError(status_code, error_code, message)


def reject_unknown_params(valid_params):
    """Reject any query parameters not in *valid_params*.

    Call at the top of every GET/POST handler that reads ``request.args``
    so that typos like ``name_contain=foo`` instead of ``name_contains=foo``
    are caught early (400) rather than silently returning unfiltered data.
    """
    unknown = set(request.args.keys()) - valid_params
    if unknown:
        abort_with_error(
            400,
            "Unknown query parameter(s): %s. "
            "Valid parameters are: %s"
            % (', '.join(sorted(unknown)),
               ', '.join(sorted(valid_params))))

"""v5 API authentication: Bearer token validation and scope decorators.

Scope hierarchy (linear, each level includes all below):
    read (0) < submit (1) < triage (2) < manage (3) < admin (4)
"""

import hashlib
import hmac
import functools

from flask import current_app, g, request
import sqlalchemy.exc

from lnt.server.db.v5.models import APIKey, utcnow


# ---------------------------------------------------------------------------
# Scope hierarchy
# ---------------------------------------------------------------------------

SCOPE_LEVELS = {
    'read': 0,
    'submit': 1,
    'triage': 2,
    'manage': 3,
    'admin': 4,
}


def _get_scope_level(scope_name):
    """Return the integer level for a scope name."""
    return SCOPE_LEVELS.get(scope_name, -1)


def _hash_token(token):
    """SHA-256 hash of a raw token string."""
    return hashlib.sha256(token.encode('utf-8')).hexdigest()


def _resolve_bearer_token():
    """Extract and validate the Bearer token from the Authorization header.

    Returns a tuple of (scope_name, api_key_or_None). If no token is
    provided (no Authorization header, or non-Bearer scheme), returns
    (None, None) so the caller can allow unauthenticated reads.

    If a Bearer token IS provided but is invalid or revoked, aborts
    with 401 immediately — an explicitly-presented credential that
    fails validation must never be silently downgraded to
    unauthenticated access.
    """
    auth_header = request.headers.get('Authorization', '')
    if not auth_header.startswith('Bearer '):
        return None, None

    token = auth_header[len('Bearer '):]
    if not token:
        from flask import abort
        abort(401)

    # Check bootstrap token from lnt.cfg first
    legacy_token = getattr(current_app.old_config, 'api_auth_token', None)
    if legacy_token and hmac.compare_digest(token, legacy_token):
        return 'admin', None

    # Look up hashed token in the APIKey table
    session = getattr(g, 'db_session', None)
    if session is None:
        from flask import abort
        abort(401)

    key_hash = _hash_token(token)
    try:
        api_key = session.query(APIKey).filter(
            APIKey.key_hash == key_hash,
            APIKey.is_active.is_(True),
        ).first()
    except (sqlalchemy.exc.OperationalError, sqlalchemy.exc.ProgrammingError):
        # Table may not exist yet (pre-migration)
        return None, None

    if api_key is None:
        from flask import abort
        abort(401)

    # Update last_used_at (best effort)
    try:
        api_key.last_used_at = utcnow()
    except Exception:
        pass

    return api_key.scope, api_key


def get_current_auth():
    """Return (scope_name, api_key_or_None) for the current request.

    Caches the result on ``g`` for the duration of the request.
    """
    if hasattr(g, '_v5_auth'):
        return g._v5_auth
    result = _resolve_bearer_token()
    g._v5_auth = result
    return result


def require_scope(scope_name):
    """Decorator that enforces the given scope on a view function.

    If the endpoint requires only ``read`` scope and the deployment
    has not set ``require_auth_for_reads`` in lnt.cfg, unauthenticated
    requests are allowed (matching v4 behaviour).
    """
    required_level = _get_scope_level(scope_name)

    def decorator(fn):
        @functools.wraps(fn)
        def wrapper(*args, **kwargs):
            granted_scope, _api_key = get_current_auth()

            if granted_scope is None:
                # No token provided
                if required_level <= SCOPE_LEVELS['read']:
                    # Allow unauthenticated reads unless the deployment
                    # requires authentication for reads.
                    require_auth = getattr(
                        current_app.old_config,
                        'require_auth_for_reads', False)
                    if not require_auth:
                        return fn(*args, **kwargs)
                from flask import abort
                abort(401)

            granted_level = _get_scope_level(granted_scope)
            if granted_level < required_level:
                from flask import abort
                abort(403)

            return fn(*args, **kwargs)
        return wrapper
    return decorator

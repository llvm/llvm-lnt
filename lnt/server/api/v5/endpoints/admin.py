"""Admin endpoints: API key management.

GET    /api/v5/admin/api-keys          -- List all API keys (admin scope)
POST   /api/v5/admin/api-keys          -- Create a new API key (admin scope)
DELETE /api/v5/admin/api-keys/{prefix}  -- Revoke a key by prefix (admin scope)

Admin endpoints live OUTSIDE the {testsuite} namespace. The middleware opens
a DB session for auth validation but does NOT resolve a test suite.
"""

import secrets

from flask import g
from flask.views import MethodView
from flask_smorest import Blueprint

from lnt.server.db.v5.models import utcnow
from ..auth import APIKey, require_scope, _hash_token
from ..errors import reject_unknown_params
from ..helpers import format_utc
from ..schemas.admin import (
    APIKeyCreateRequestSchema,
    APIKeyCreateResponseSchema,
    APIKeyListResponseSchema,
)

blp = Blueprint(
    'Admin',
    __name__,
    url_prefix='/api/v5/admin',
    description='Create, list, and revoke API keys (scopes: read, submit, triage, manage, admin)',
)


@blp.route('/api-keys')
class APIKeyCollection(MethodView):
    """List and create API keys."""

    @require_scope('admin')
    @blp.response(200, APIKeyListResponseSchema)
    def get(self):
        """List all API keys.

        Returns metadata for every key (prefix, name, scope, timestamps,
        and active status). The raw token is never included.
        """
        reject_unknown_params(set())
        session = g.db_session
        keys = session.query(APIKey).order_by(APIKey.id).all()

        items = []
        for k in keys:
            items.append({
                'prefix': k.key_prefix,
                'name': k.name,
                'scope': k.scope,
                'created_at': format_utc(k.created_at),
                'last_used_at': format_utc(k.last_used_at),
                'is_active': k.is_active,
            })

        return {'items': items}

    @require_scope('admin')
    @blp.arguments(APIKeyCreateRequestSchema)
    @blp.response(201, APIKeyCreateResponseSchema)
    def post(self, payload):
        """Create a new API key.

        Returns the raw token exactly once. Store it securely -- it
        cannot be retrieved again.
        """
        name = payload['name']
        scope = payload['scope']

        # Generate a cryptographically random token
        raw_token = secrets.token_hex(32)  # 64-char hex string
        prefix = raw_token[:8]
        key_hash = _hash_token(raw_token)

        api_key = APIKey(
            name=name,
            key_prefix=prefix,
            key_hash=key_hash,
            scope=scope,
            created_at=utcnow(),
            is_active=True,
        )

        session = g.db_session
        session.add(api_key)
        session.flush()

        return {
            'key': raw_token,
            'prefix': prefix,
            'scope': scope,
        }


@blp.route('/api-keys/<prefix>')
class APIKeyByPrefix(MethodView):
    """Revoke a single API key identified by its prefix."""

    @require_scope('admin')
    @blp.response(204)
    def delete(self, prefix):
        """Revoke an API key by its prefix.

        The key is deactivated rather than deleted, preserving the
        audit trail.
        """
        session = g.db_session
        api_key = session.query(APIKey).filter(
            APIKey.key_prefix == prefix,
        ).first()

        if api_key is None:
            from ..errors import abort_with_error
            abort_with_error(
                404,
                "API key with prefix '%s' not found" % prefix,
            )

        api_key.is_active = False
        session.flush()

        return ''

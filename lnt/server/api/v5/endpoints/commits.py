"""Commit endpoints for the v5 API.

GET    /api/v5/{ts}/commits                  -- List commits (cursor-paginated)
POST   /api/v5/{ts}/commits                  -- Create commit
GET    /api/v5/{ts}/commits/{value}          -- Commit detail (includes prev/next)
PATCH  /api/v5/{ts}/commits/{value}          -- Update commit (ordinal, fields)
DELETE /api/v5/{ts}/commits/{value}          -- Delete commit (cascade)
POST   /api/v5/{ts}/commits/resolve          -- Batch resolve commit strings to summaries
"""

from flask import g, jsonify
from flask.views import MethodView
from flask_smorest import Blueprint
from sqlalchemy import or_

from ..auth import require_scope
from ..errors import abort_with_error, reject_unknown_params
from ..etag import add_etag_to_response
from ..helpers import dump_response, escape_like, lookup_machine
from ..pagination import (
    cursor_paginate,
    make_paginated_response,
)
from ..schemas.commits import (
    CommitCreateSchema,
    CommitDetailQuerySchema,
    CommitDetailSchema,
    CommitListQuerySchema,
    CommitResolveRequestSchema,
    CommitResolveResponseSchema,
    CommitSummarySchema,
    CommitUpdateSchema,
    PaginatedCommitResponseSchema,
)

_commit_summary_schema = CommitSummarySchema()
_commit_detail_schema = CommitDetailSchema()

blp = Blueprint(
    'Commits',
    __name__,
    url_prefix='/api/v5/<testsuite>',
    description='List, create, and inspect commits with previous/next navigation',
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _extract_commit_fields(data, ts, skip=('commit', 'ordinal')):
    """Extract commit_field values from a request payload.

    Returns a dict of {field_name: value} for fields defined in the
    schema, skipping any keys in *skip*.
    """
    names = {cf.name for cf in ts.schema.commit_fields}
    return {k: v for k, v in data.items()
            if k not in skip and k in names}


def _serialize_commit_fields(commit_obj, ts):
    """Return a dict of {field_name: value} for commit_fields."""
    result = {}
    for cf in ts.schema.commit_fields:
        val = getattr(commit_obj, cf.name, None)
        if val is not None:
            result[cf.name] = str(val)
    return result


def _serialize_commit_summary(commit_obj, ts):
    """Serialize a commit for list responses."""
    return dump_response(_commit_summary_schema, {
        'commit': commit_obj.commit,
        'ordinal': commit_obj.ordinal,
        'fields': _serialize_commit_fields(commit_obj, ts),
    })


def _serialize_commit_neighbor(commit_obj, testsuite):
    """Serialize a previous/next commit reference, or None."""
    if commit_obj is None:
        return None
    return {
        'commit': commit_obj.commit,
        'ordinal': commit_obj.ordinal,
        'link': '/api/v5/%s/commits/%s' % (testsuite, commit_obj.commit),
    }


def _get_neighbors(session, ts, commit_obj):
    """Find previous/next commits by ordinal.

    Returns (previous, next) where each is a Commit or None.
    """
    if commit_obj.ordinal is None:
        return None, None

    prev_commit = session.query(ts.Commit).filter(
        ts.Commit.ordinal.isnot(None),
        ts.Commit.ordinal < commit_obj.ordinal,
    ).order_by(ts.Commit.ordinal.desc()).first()

    next_commit = session.query(ts.Commit).filter(
        ts.Commit.ordinal.isnot(None),
        ts.Commit.ordinal > commit_obj.ordinal,
    ).order_by(ts.Commit.ordinal.asc()).first()

    return prev_commit, next_commit


def _serialize_commit_detail(commit_obj, testsuite, ts, session):
    """Serialize a commit for detail responses, including prev/next."""
    prev_commit, next_commit = _get_neighbors(session, ts, commit_obj)
    return dump_response(_commit_detail_schema, {
        'commit': commit_obj.commit,
        'ordinal': commit_obj.ordinal,
        'fields': _serialize_commit_fields(commit_obj, ts),
        'previous_commit': _serialize_commit_neighbor(
            prev_commit, testsuite),
        'next_commit': _serialize_commit_neighbor(
            next_commit, testsuite),
    })


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@blp.route('/commits')
class CommitList(MethodView):
    """List and create commits."""

    @require_scope('read')
    @blp.arguments(CommitListQuerySchema, location="query")
    @blp.response(200, PaginatedCommitResponseSchema)
    def get(self, query_args, testsuite):
        """List commits (cursor-paginated)."""
        reject_unknown_params({'cursor', 'limit', 'search', 'machine', 'sort'})
        ts = g.ts
        session = g.db_session

        query = session.query(ts.Commit)

        search = query_args.get('search')
        if search:
            escaped = escape_like(search)
            conditions = [ts.Commit.commit.like(escaped + '%', escape='\\')]
            for cf in ts.schema.searchable_commit_fields:
                col = getattr(ts.Commit, cf.name)
                conditions.append(
                    col.like(escaped + '%', escape='\\'))
            query = query.filter(or_(*conditions))

        machine_name = query_args.get('machine')
        if machine_name:
            machine = lookup_machine(session, ts, machine_name)
            query = query.filter(
                session.query(ts.Run).filter(
                    ts.Run.commit_id == ts.Commit.id,
                    ts.Run.machine_id == machine.id,
                ).exists()
            )

        sort_param = query_args.get('sort')
        if sort_param == 'ordinal':
            query = query.filter(ts.Commit.ordinal.isnot(None))
            cursor_col = ts.Commit.ordinal
        else:
            cursor_col = ts.Commit.id

        cursor_str = query_args.get('cursor')
        limit = query_args['limit']
        items, next_cursor = cursor_paginate(
            query, cursor_col, cursor_str, limit)

        serialized = [_serialize_commit_summary(c, ts) for c in items]
        return jsonify(make_paginated_response(serialized, next_cursor))

    @require_scope('submit')
    @blp.arguments(CommitCreateSchema)
    @blp.response(201, CommitDetailSchema)
    def post(self, body, testsuite):
        """Create a commit explicitly."""
        ts = g.ts
        session = g.db_session

        commit_str = body['commit']

        # Check if commit already exists.
        existing = ts.get_commit(session, commit=commit_str)
        if existing is not None:
            abort_with_error(409, "Commit '%s' already exists" % commit_str)

        metadata = _extract_commit_fields(body, ts)
        commit_obj = ts.get_or_create_commit(session, commit_str, **metadata)

        # Set ordinal if provided.
        ordinal = body.get('ordinal')
        if ordinal is not None:
            ts.update_commit(session, commit_obj, ordinal=ordinal)

        session.flush()

        result = _serialize_commit_detail(commit_obj, testsuite, ts, session)
        resp = jsonify(result)
        resp.status_code = 201
        return resp


@blp.route('/commits/<string:commit_value>')
class CommitDetail(MethodView):
    """Commit detail, update, and delete."""

    @require_scope('read')
    @blp.arguments(CommitDetailQuerySchema, location="query")
    @blp.response(200, CommitDetailSchema)
    def get(self, query_args, testsuite, commit_value):
        """Get commit detail by commit string.

        The response includes previous_commit and next_commit references
        (based on ordinal ordering).
        """
        reject_unknown_params(set())
        ts = g.ts
        session = g.db_session

        commit_obj = ts.get_commit(session, commit=commit_value)
        if commit_obj is None:
            abort_with_error(404, "Commit '%s' not found" % commit_value)

        data = _serialize_commit_detail(commit_obj, testsuite, ts, session)
        return add_etag_to_response(jsonify(data), data)

    @require_scope('manage')
    @blp.arguments(CommitUpdateSchema)
    @blp.response(200, CommitDetailSchema)
    def patch(self, body, testsuite, commit_value):
        """Update commit ordinal and/or commit_fields."""
        ts = g.ts
        session = g.db_session

        commit_obj = ts.get_commit(session, commit=commit_value)
        if commit_obj is None:
            abort_with_error(404, "Commit '%s' not found" % commit_value)

        # Update ordinal if provided.
        if 'ordinal' in body:
            ordinal_val = body['ordinal']
            if ordinal_val is None:
                ts.update_commit(session, commit_obj, clear_ordinal=True)
            else:
                ts.update_commit(session, commit_obj, ordinal=ordinal_val)

        # Update commit_fields.
        field_updates = _extract_commit_fields(body, ts, skip=('ordinal',))
        if field_updates:
            ts.update_commit(session, commit_obj, **field_updates)

        try:
            session.flush()
        except Exception as exc:
            session.rollback()
            abort_with_error(
                409, "Failed to update commit: %s" % exc)

        return jsonify(
            _serialize_commit_detail(commit_obj, testsuite, ts, session))

    @require_scope('manage')
    @blp.response(204)
    def delete(self, testsuite, commit_value):
        """Delete a commit and cascade to its runs/samples.

        Returns 409 if regressions reference this commit.
        """
        ts = g.ts
        session = g.db_session

        commit_obj = ts.get_commit(session, commit=commit_value)
        if commit_obj is None:
            abort_with_error(404, "Commit '%s' not found" % commit_value)

        try:
            ts.delete_commit(session, commit_obj.id)
        except ValueError as exc:
            abort_with_error(409, str(exc))

        session.flush()
        return '', 204


@blp.route('/commits/resolve')
class CommitResolve(MethodView):
    """Batch resolve commit strings to summaries with field values."""

    @require_scope('read')
    @blp.arguments(CommitResolveRequestSchema, location="json")
    @blp.response(200, CommitResolveResponseSchema)
    def post(self, body, testsuite):
        """Resolve a list of commit strings to their summaries.

        Returns each found commit's ordinal and field values in a dict
        keyed by commit string.  Commit strings not found in the database
        are returned in a separate ``not_found`` list.

        Duplicate commit values in the request are deduplicated; each
        appears at most once in the response.
        """
        ts = g.ts
        session = g.db_session

        requested = body['commits']
        unique_values = list(dict.fromkeys(requested))

        commit_objs = ts.get_commits_by_values(session, unique_values)
        found_map = {obj.commit: obj for obj in commit_objs}

        # Build response preserving request order (deduplicated).
        results = {}
        not_found = []
        for val in unique_values:
            obj = found_map.get(val)
            if obj is not None:
                results[val] = _serialize_commit_summary(obj, ts)
            else:
                not_found.append(val)

        return jsonify({'results': results, 'not_found': not_found})

"""Profile endpoints for the v5 API.

GET /api/v5/{ts}/runs/{run_uuid}/profiles
    -- List profiles for a run
GET /api/v5/{ts}/profiles/{profile_uuid}
    -- Profile metadata + top-level counters
GET /api/v5/{ts}/profiles/{profile_uuid}/functions
    -- List functions with counters
GET /api/v5/{ts}/profiles/{profile_uuid}/functions/{fn_name}
    -- Disassembly + per-instruction counters
"""

from flask import g, jsonify
from flask.views import MethodView
from flask_smorest import Blueprint

from ..auth import require_scope
from ..errors import abort_with_error, reject_unknown_params
from ..helpers import dump_response, lookup_profile, lookup_run_by_uuid
from ..schemas.profiles import (
    FunctionDetailSchema,
    FunctionListResponseSchema,
    ProfileListItemSchema,
    ProfileMetadataSchema,
)
from lnt.server.db.v5.profile import ProfileData, ProfileParseError

blp = Blueprint(
    'Profiles',
    __name__,
    url_prefix='/api/v5/<testsuite>',
    description='Inspect hardware performance counter profiles',
)

# Pre-instantiated schemas for dump_response validation.
_profile_list_item_schema = ProfileListItemSchema()
_profile_metadata_schema = ProfileMetadataSchema()
_function_list_schema = FunctionListResponseSchema()
_function_detail_schema = FunctionDetailSchema()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _deserialize_profile(profile):
    """Deserialize a Profile's binary data.  Aborts with 500 on error."""
    try:
        return ProfileData.deserialize(profile.data)
    except ProfileParseError as e:
        abort_with_error(
            500,
            "Failed to parse profile data: %s" % str(e))


# ---------------------------------------------------------------------------
# Profile listing (per run)
# ---------------------------------------------------------------------------

@blp.route('/runs/<string:run_uuid>/profiles')
class ProfileList(MethodView):
    """List profiles attached to a run."""

    @require_scope('read')
    @blp.response(200, ProfileListItemSchema(many=True))
    def get(self, testsuite, run_uuid):
        """List profiles for a run.

        Returns an array of {test, uuid} objects for all profiles
        attached to the given run.
        """
        reject_unknown_params(set())
        ts = g.ts
        session = g.db_session
        run = lookup_run_by_uuid(session, ts, run_uuid)

        profiles = ts.get_profiles_for_run(session, run)
        items = [
            dump_response(_profile_list_item_schema,
                          {'test': test_name, 'uuid': uuid})
            for uuid, test_name in profiles
        ]
        return jsonify(items)


# ---------------------------------------------------------------------------
# Profile data (by UUID)
# ---------------------------------------------------------------------------

@blp.route('/profiles/<string:profile_uuid>')
class ProfileMetadata(MethodView):
    """Profile metadata and top-level counters."""

    @require_scope('read')
    @blp.response(200, ProfileMetadataSchema)
    def get(self, testsuite, profile_uuid):
        """Get profile metadata and top-level counters."""
        reject_unknown_params(set())
        ts = g.ts
        session = g.db_session
        profile = lookup_profile(session, ts, profile_uuid, load_data=True)
        p = _deserialize_profile(profile)

        return jsonify(dump_response(_profile_metadata_schema, {
            'uuid': profile.uuid,
            'test': profile.test.name,
            'run_uuid': profile.run.uuid,
            'counters': p.get_top_level_counters(),
            'disassembly_format': p.get_disassembly_format(),
        }))


@blp.route('/profiles/<string:profile_uuid>/functions')
class ProfileFunctions(MethodView):
    """List functions in a profile with their counters."""

    @require_scope('read')
    @blp.response(200, FunctionListResponseSchema)
    def get(self, testsuite, profile_uuid):
        """List functions with counters.

        Returns all functions sorted by total counter value descending
        (hottest first).
        """
        reject_unknown_params(set())
        ts = g.ts
        session = g.db_session
        profile = lookup_profile(session, ts, profile_uuid, load_data=True)
        p = _deserialize_profile(profile)

        functions_dict = p.get_functions()
        functions = []
        for fn_name, fn_info in functions_dict.items():
            functions.append({
                'name': fn_name,
                'counters': fn_info.counters,
                'length': fn_info.length,
            })

        # Sort by total counter value descending (hottest first)
        def _total_counters(fn):
            return sum(fn['counters'].values())
        functions.sort(key=_total_counters, reverse=True)

        return jsonify(dump_response(_function_list_schema,
                                     {'functions': functions}))


@blp.route('/profiles/<string:profile_uuid>/functions/<path:fn_name>')
class ProfileFunctionDetail(MethodView):
    """Disassembly and per-instruction counters for a function."""

    @require_scope('read')
    @blp.response(200, FunctionDetailSchema)
    def get(self, testsuite, profile_uuid, fn_name):
        """Get disassembly and per-instruction counters for a function."""
        reject_unknown_params(set())
        ts = g.ts
        session = g.db_session
        profile = lookup_profile(session, ts, profile_uuid, load_data=True)
        p = _deserialize_profile(profile)

        functions_dict = p.get_functions()
        if fn_name not in functions_dict:
            abort_with_error(
                404,
                "Function '%s' not found in profile" % fn_name)

        fn_info = functions_dict[fn_name]
        instructions = [
            {
                'address': insn.address,
                'counters': insn.counters,
                'text': insn.text,
            }
            for insn in p.get_code_for_function(fn_name)
        ]

        return jsonify(dump_response(_function_detail_schema, {
            'name': fn_name,
            'counters': fn_info.counters,
            'disassembly_format': p.get_disassembly_format(),
            'instructions': instructions,
        }))

"""Profile endpoints for the v5 API.

GET /api/v5/{ts}/runs/{uuid}/tests/{test_name}/profile
    -- Profile metadata + top-level counters
GET /api/v5/{ts}/runs/{uuid}/tests/{test_name}/profile/functions
    -- List functions with counters
GET /api/v5/{ts}/runs/{uuid}/tests/{test_name}/profile/functions/{fn_name}
    -- Disassembly + per-instruction counters
"""

from flask import current_app, g, jsonify
from flask.views import MethodView
from flask_smorest import Blueprint

from ..auth import require_scope
from ..errors import abort_with_error, reject_unknown_params
from ..helpers import lookup_run_by_uuid, lookup_test
from ..schemas.profiles import (
    FunctionDetailSchema,
    FunctionListResponseSchema,
    ProfileMetadataSchema,
)

blp = Blueprint(
    'Profiles',
    __name__,
    url_prefix='/api/v5/<testsuite>',
    description='Inspect hardware performance counter profiles attached to samples',
)


def _get_sample_with_profile(session, ts, run, test):
    """Find the sample for run+test that has a profile attached.

    Aborts with 404 if no sample with profile is found.
    """
    sample = session.query(ts.Sample).filter(
        ts.Sample.run_id == run.id,
        ts.Sample.test_id == test.id,
        ts.Sample.profile_id.isnot(None),
    ).first()
    if sample is None:
        abort_with_error(
            404,
            "No profile found for test '%s' in run '%s'" %
            (test.name, run.uuid))
    return sample


def _load_profile(sample):
    """Load the profile from disk for the given sample.

    Uses current_app.old_config.profileDir to locate profile files.
    Aborts with 404 if the profile file is missing or cannot be loaded.
    """
    profile_dir = current_app.old_config.profileDir
    try:
        p = sample.profile.load(profile_dir)
    except Exception:
        abort_with_error(
            404,
            "Profile file for this sample is missing or cannot be loaded. "
            "The profile data file may have been deleted from disk.")
    if p is None:
        abort_with_error(
            404,
            "Profile file for this sample is missing or cannot be loaded.")
    return p


@blp.route('/runs/<string:run_uuid>/tests/<path:test_name>/profile')
class ProfileMetadata(MethodView):
    """Profile metadata and top-level counters."""

    @require_scope('read')
    @blp.response(200, ProfileMetadataSchema)
    def get(self, testsuite, run_uuid, test_name):
        """Get profile metadata and top-level counters.

        Returns the test name and absolute counter values for the
        entire profile.
        """
        reject_unknown_params(set())
        ts = g.ts
        session = g.db_session
        run = lookup_run_by_uuid(session, ts, run_uuid)
        test = lookup_test(session, ts, test_name)
        sample = _get_sample_with_profile(session, ts, run, test)
        p = _load_profile(sample)

        counters = p.getTopLevelCounters()
        return jsonify({
            'test': test.name,
            'counters': counters,
        })


@blp.route(
    '/runs/<string:run_uuid>/tests/<path:test_name>/profile/functions')
class ProfileFunctions(MethodView):
    """List functions in a profile with their counters."""

    @require_scope('read')
    @blp.response(200, FunctionListResponseSchema)
    def get(self, testsuite, run_uuid, test_name):
        """List functions with counters.

        Returns all functions in the profile with their counter values
        (as percentages) and instruction count. The function list is
        NOT paginated (typically small).
        """
        reject_unknown_params(set())
        ts = g.ts
        session = g.db_session
        run = lookup_run_by_uuid(session, ts, run_uuid)
        test = lookup_test(session, ts, test_name)
        sample = _get_sample_with_profile(session, ts, run, test)
        p = _load_profile(sample)

        functions_dict = p.getFunctions()
        functions = []
        for fn_name, fn_info in functions_dict.items():
            functions.append({
                'name': fn_name,
                'counters': fn_info.get('counters', {}),
                'length': fn_info.get('length', 0),
            })

        return jsonify({'functions': functions})


@blp.route(
    '/runs/<string:run_uuid>/tests/<path:test_name>'
    '/profile/functions/<path:fn_name>')
class ProfileFunctionDetail(MethodView):
    """Disassembly and per-instruction counters for a function."""

    @require_scope('read')
    @blp.response(200, FunctionDetailSchema)
    def get(self, testsuite, run_uuid, test_name, fn_name):
        """Get disassembly and per-instruction counters for a function.

        Returns the function's counters, disassembly format, and a list
        of instructions with their addresses, counter values, and
        disassembly text.
        """
        reject_unknown_params(set())
        ts = g.ts
        session = g.db_session
        run = lookup_run_by_uuid(session, ts, run_uuid)
        test = lookup_test(session, ts, test_name)
        sample = _get_sample_with_profile(session, ts, run, test)
        p = _load_profile(sample)

        functions_dict = p.getFunctions()
        if fn_name not in functions_dict:
            abort_with_error(
                404,
                "Function '%s' not found in profile" % fn_name)

        fn_info = functions_dict[fn_name]
        disassembly_format = p.getDisassemblyFormat()

        instructions = []
        try:
            for address, counters, text in p.getCodeForFunction(fn_name):
                instructions.append({
                    'address': address,
                    'counters': counters,
                    'text': text,
                })
        except KeyError:
            abort_with_error(
                404,
                "Function '%s' not found in profile" % fn_name)

        return jsonify({
            'name': fn_name,
            'counters': fn_info.get('counters', {}),
            'disassembly_format': disassembly_format,
            'instructions': instructions,
        })

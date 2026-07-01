"""Sample endpoints for the v5 API.

GET /api/v5/{ts}/runs/{uuid}/samples                    -- All samples for a run
GET /api/v5/{ts}/runs/{uuid}/tests/{test_name}/samples   -- Samples for a test
"""

from flask import g, jsonify
from flask.views import MethodView
from flask_smorest import Blueprint
from sqlalchemy.orm import joinedload

from ..auth import require_scope
from ..errors import reject_unknown_params
from ..helpers import dump_response, lookup_run_by_uuid, lookup_test
from ..pagination import (
    cursor_paginate,
    make_paginated_response,
)
from ..schemas.samples import (
    PaginatedSampleResponseSchema,
    RunSamplesQuerySchema,
    SampleListResponseSchema,
    SampleResponseSchema,
)

_sample_schema = SampleResponseSchema()

blp = Blueprint(
    'Samples',
    __name__,
    url_prefix='/api/v5/<testsuite>',
    description='List metric measurements collected for each test in a run',
)


def _serialize_sample(sample, ts):
    """Serialize a Sample model instance for the API response.

    Returns a dict with test name and a metrics dict containing all
    non-null metric values.
    """
    metrics = {}
    for metric in ts.schema.metrics:
        value = getattr(sample, metric.name, None)
        if value is not None:
            metrics[metric.name] = value

    return dump_response(_sample_schema, {
        'test': sample.test.name,
        'metrics': metrics,
    })


@blp.route('/runs/<string:run_uuid>/samples')
class RunSamples(MethodView):
    """List all samples for a run."""

    @require_scope('read')
    @blp.arguments(RunSamplesQuerySchema, location="query")
    @blp.response(200, PaginatedSampleResponseSchema)
    def get(self, query_args, testsuite, run_uuid):
        """List samples for a run (cursor-paginated)."""
        reject_unknown_params({'cursor', 'limit'})
        ts = g.ts
        session = g.db_session
        run = lookup_run_by_uuid(session, ts, run_uuid)

        query = session.query(ts.Sample).options(
            joinedload(ts.Sample.test)
        ).filter(
            ts.Sample.run_id == run.id
        )

        cursor_str = query_args.get('cursor')
        limit = query_args['limit']
        items, next_cursor = cursor_paginate(
            query, ts.Sample.id, cursor_str, limit)

        serialized = [_serialize_sample(s, ts) for s in items]
        return jsonify(make_paginated_response(serialized, next_cursor))


@blp.route('/runs/<string:run_uuid>/tests/<path:test_name>/samples')
class RunTestSamples(MethodView):
    """List samples for a specific test in a run."""

    @require_scope('read')
    @blp.response(200, SampleListResponseSchema)
    def get(self, testsuite, run_uuid, test_name):
        """Get samples for a specific test in a run.

        Returns a list because a run may have multiple samples for the
        same test.
        """
        reject_unknown_params(set())
        ts = g.ts
        session = g.db_session
        run = lookup_run_by_uuid(session, ts, run_uuid)

        # Look up the test by name
        test = lookup_test(session, ts, test_name)

        samples = session.query(ts.Sample).options(
            joinedload(ts.Sample.test)
        ).filter(
            ts.Sample.run_id == run.id,
            ts.Sample.test_id == test.id,
        ).all()

        serialized = [_serialize_sample(s, ts) for s in samples]
        return jsonify({'items': serialized})

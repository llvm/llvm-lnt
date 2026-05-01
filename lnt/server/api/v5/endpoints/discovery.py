"""Discovery endpoint: GET /api/v5/

Returns a list of available test suites with links to their resources.
No authentication required.
"""

from flask import g
from flask.views import MethodView
from flask_smorest import Blueprint

from ..errors import reject_unknown_params
from ..schemas.common import DiscoveryResponseSchema
from .test_suites import _suite_links

blp = Blueprint(
    'Discovery',
    __name__,
    url_prefix='/api/v5',
    description='Discover available test suites and their resource URLs',
)


@blp.route('/')
class Discovery(MethodView):
    """Discover available test suites."""

    @blp.response(200, DiscoveryResponseSchema)
    def get(self):
        """List all available test suites with links.

        No authentication required.
        """
        reject_unknown_params(set())
        db = getattr(g, 'db', None)
        if db is None:
            return {'test_suites': []}

        suites = []
        for name in sorted(db.testsuite.keys()):
            suites.append({
                'name': name,
                'links': _suite_links(name),
            })

        return {
            'test_suites': suites,
            'links': {
                'openapi': '/api/v5/openapi/openapi.json',
                'swagger_ui': '/api/v5/openapi/swagger-ui',
                'test_suites': '/api/v5/test-suites',
            },
        }

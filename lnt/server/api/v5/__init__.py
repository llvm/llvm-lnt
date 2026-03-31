"""LNT v5 REST API factory.

Creates and configures the flask-smorest Api instance, registers middleware,
and hooks up all endpoint blueprints.
"""

from flask_smorest import Api as SmorestApi


def create_v5_api(app):
    """Create and register the v5 REST API on the given Flask app.

    Returns the flask-smorest Api instance.
    """
    app.config.update({
        "API_TITLE": "LNT API",
        "API_VERSION": "v5",
        "OPENAPI_VERSION": "3.0.3",
        "OPENAPI_URL_PREFIX": "/api/v5/openapi",
        "OPENAPI_JSON_PATH": "openapi.json",
        "OPENAPI_SWAGGER_UI_PATH": "/swagger-ui",
        "OPENAPI_SWAGGER_UI_URL": "https://cdn.jsdelivr.net/npm/swagger-ui-dist/",
    })
    smorest_api = SmorestApi(app)

    from .middleware import register_middleware
    register_middleware(app)

    from .errors import register_error_handlers
    register_error_handlers(smorest_api, app)

    from .endpoints import register_all_endpoints
    register_all_endpoints(smorest_api)

    return smorest_api

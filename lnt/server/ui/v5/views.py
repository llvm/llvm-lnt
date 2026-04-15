from flask import g, render_template, request

from . import v5_frontend, _setup_testsuite
from lnt.server.ui.views import ts_data
from lnt.server.ui.decorators import _make_db_session


def _v5_render(**kwargs):
    """Render the v5 SPA shell with common template variables."""
    return render_template("v5_app.html",
                           lnt_url_base='',
                           v4_url='',
                           **kwargs)


@v5_frontend.route("/v5/", strict_slashes=False)
@v5_frontend.route("/v5/test-suites", strict_slashes=False)
@v5_frontend.route("/v5/admin", strict_slashes=False)
@v5_frontend.route("/v5/graph", strict_slashes=False)
@v5_frontend.route("/v5/compare", strict_slashes=False)
def v5_global():
    """Suite-agnostic pages (dashboard, test suites, admin, graph, compare).

    Serves the SPA shell with an empty testsuite. Each page manages
    suite selection internally via its own UI controls. The list of
    available test suites is provided via data-testsuites.
    """
    g.testsuite_name = ''
    _make_db_session(None)
    try:
        db = request.get_db()
        return _v5_render(testsuites=sorted(db.testsuite.keys()))
    finally:
        request.session.close()


@v5_frontend.route("/v5/<testsuite_name>/")
@v5_frontend.route("/v5/<testsuite_name>/<path:subpath>")
def v5_app(testsuite_name, subpath=None):
    """Catch-all route for the v5 SPA.

    All client-side routes (dashboard, machines, graph, compare, etc.)
    hit this single endpoint, which serves the SPA shell. The TypeScript
    router handles the rest.
    """
    _setup_testsuite(testsuite_name)
    try:
        ts = request.get_testsuite()
        data = ts_data(ts)
        db = request.get_db()
        data['testsuites'] = sorted(db.testsuite.keys())
        return _v5_render(**data)
    finally:
        request.session.close()

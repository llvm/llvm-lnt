from flask import abort, render_template, request

from . import v5_frontend, _setup_testsuite


def _v5_url_base():
    """Compute the LNT URL base for the v5 SPA."""
    return request.script_root


def _v5_render(**kwargs):
    """Render the v5 SPA shell with common template variables."""
    return render_template("v5_app.html",
                           lnt_url_base=_v5_url_base(),
                           **kwargs)


@v5_frontend.route("/v5/", strict_slashes=False)
@v5_frontend.route("/v5/test-suites", strict_slashes=False)
@v5_frontend.route("/v5/admin", strict_slashes=False)
@v5_frontend.route("/v5/graph", strict_slashes=False)
@v5_frontend.route("/v5/compare", strict_slashes=False)
@v5_frontend.route("/v5/profiles", strict_slashes=False)
def v5_global():
    """Suite-agnostic pages (dashboard, test suites, admin, graph, compare, profiles).

    Serves the SPA shell with an empty testsuite. Each page manages
    suite selection internally via its own UI controls. The list of
    available test suites is provided via data-testsuites.
    """
    _setup_testsuite('')
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
        db = request.get_db()
        if testsuite_name not in db.testsuite:
            abort(404)
        return _v5_render(testsuites=sorted(db.testsuite.keys()))
    finally:
        request.session.close()

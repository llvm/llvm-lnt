import flask
from flask import g, request

from lnt.server.ui.decorators import _make_db_session

v5_frontend = flask.Blueprint(
    "lnt_v5", __name__,
    template_folder="templates/",
    static_folder="static/",
    static_url_path="/v5/static",
)


def _setup_testsuite(testsuite_name, db_name=None):
    """Shared setup for v5 UI routes: DB session + testsuite resolution.

    Calls ``ensure_fresh`` so that server-side rendering of
    ``data-testsuites`` always reflects the latest suites, even when
    another worker created or deleted one since this worker last checked.
    """
    g.testsuite_name = testsuite_name
    _make_db_session(db_name)
    request.db.ensure_fresh(request.session)


from . import views  # noqa: E402, F401 — register routes on the blueprint

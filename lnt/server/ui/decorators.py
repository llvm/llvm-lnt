import flask
from flask import abort
from flask import current_app, g, render_template
from flask import request

frontend = flask.Blueprint("lnt", __name__, template_folder="ui/templates/",
                           static_folder="ui/static")


def _make_db_session(db_name):
    # Initialize the database parameters on the app globals object.
    g.db_name = db_name or "default"
    g.db_info = current_app.old_config.databases.get(g.db_name)
    if g.db_info is None:
        abort(404, "Unknown database.")
    request.db = current_app.instance.get_database(g.db_name)
    request.session = request.db.make_session()


def db_route(rule, **options):
    """
    LNT specific route for endpoints which always refer to some database
    object.

    This decorator handles adding the routes for both the default and explicit
    database, as well as initializing the global database information objects.
    """
    def decorator(f):
        def wrap(db_name=None, **args):
            _make_db_session(db_name)
            try:
                return f(**args)
            finally:
                request.session.close()

        frontend.add_url_rule(rule, f.__name__, wrap, **options)
        frontend.add_url_rule("/db_<db_name>" + rule,
                              f.__name__, wrap, **options)

        return wrap
    return decorator


def v4_route(rule, **options):
    """
    LNT V4 specific route for endpoints which always refer to some testsuite
    object.
    """
    def decorator(f):
        def wrap(testsuite_name, db_name=None, **args):
            g.testsuite_name = testsuite_name
            _make_db_session(db_name)
            try:
                return f(**args)
            finally:
                request.session.close()

        frontend.add_url_rule("/v4/<testsuite_name>" + rule,
                              f.__name__, wrap, **options)
        frontend.add_url_rule("/db_<db_name>/v4/<testsuite_name>" + rule,
                              f.__name__, wrap, **options)

        return wrap
    return decorator


def in_db(func):
    """Extract the database information off the request and attach to
    particular test suite and database. Used by the REST api."""
    def wrap(*args, **kwargs):
        db = kwargs.pop('db')
        ts = kwargs.pop('ts')
        g.testsuite_name = ts
        _make_db_session(db)
        try:
            return func(*args, **kwargs)
        finally:
            request.session.close()

    return wrap

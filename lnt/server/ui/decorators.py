import flask
from flask import abort
from flask import current_app, g, render_template
from flask import request

frontend = flask.Module(__name__)

# Decorator for implementing per-database routes.
def db_route(rule, only_v3 = True, **options):
    """
    LNT specific route for endpoints which always refer to some database
    object.

    This decorator handles adding the routes for both the default and explicit
    database, as well as initializing the global database information objects.
    """
    def decorator(f):
        def wrap(db_name = None, **args):
            # Initialize the database parameters on the app globals object.
            g.db_name = db_name or "default"
            g.db_info = current_app.old_config.databases.get(g.db_name)
            if g.db_info is None:
                abort(404)

            # Disable non-v0.3 database support, if requested.
            if only_v3 and g.db_info.db_version != '0.3':
                return render_template("error.html", message="""\
UI support for database with version %r is not yet implemented.""" % (
                        g.db_info.db_version))

            # Compute result.
            result = f(**args)

            # Make sure that any transactions begun by this request are finished.
            request.get_db().rollback()

            # Return result.
            return result

        frontend.add_url_rule(rule, f.__name__, wrap, **options)
        frontend.add_url_rule("/db_<db_name>" + rule,
                              f.__name__, wrap, **options)

        return wrap
    return decorator

# Decorator for implementing per-testsuite routes.
def v4_route(rule, **options):
    """
    LNT V4 specific route for endpoints which always refer to some testsuite
    object.
    """

    # FIXME: This is manually composed with db_route.
    def decorator(f):
        def wrap(testsuite_name, db_name = None, **args):
            # Initialize the test suite parameters on the app globals object.
            g.testsuite_name = testsuite_name

            # Initialize the database parameters on the app globals object.
            g.db_name = db_name or "default"
            g.db_info = current_app.old_config.databases.get(g.db_name)
            if g.db_info is None:
                abort(404)

            # Compute result.
            result = f(**args)

            # Make sure that any transactions begun by this request are finished.
            request.get_db().rollback()

            # Return result.
            return result

        frontend.add_url_rule("/v4/<testsuite_name>" + rule,
                              f.__name__, wrap, **options)
        frontend.add_url_rule("/db_<db_name>/v4/<testsuite_name>" + rule,
                              f.__name__, wrap, **options)

        return wrap
    return decorator

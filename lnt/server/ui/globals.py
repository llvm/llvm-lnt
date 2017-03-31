"""
Module for defining additional Jinja global functions.
"""

import flask

import lnt.server.ui.util


def db_url_for(*args, **kwargs):
    """
    Like url_for, but handles automatically providing the db_name argument.
    """
    return flask.url_for(*args, db_name=flask.g.db_name, **kwargs)


def v4_url_for(*args, **kwargs):
    """
    Like url_for, but handles automatically providing the db_name and
    testsuite_name arguments.
    """
    return flask.url_for(*args, db_name=flask.g.db_name,
                          testsuite_name=flask.g.testsuite_name, **kwargs)


def v4_url_available(*args, **kwargs):
    """
    Return True if v4_url_for can be used; if there is a testsuite_name
    in the global context.
    """
    try:
        flask.g.testsuite_name
        return True
    except:
        return False


def register(env):
    # Add some normal Python builtins which can be useful in templates.
    env.globals.update(zip=zip)

    # Add our custom global functions.
    env.globals.update(
        db_url_for=db_url_for,
        v4_url_for=v4_url_for,
        v4_url_available=v4_url_available,
        baseline_key=lnt.server.ui.util.baseline_key)



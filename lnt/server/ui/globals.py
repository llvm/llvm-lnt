"""
Module for defining additional Jinja global functions.
"""

import flask
from flask import Response


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
    except Exception:
        return False


class fixed_location_response(Response):
    autocorrect_location_header = False


def v4_redirect(*args, **kwargs):
    """
    Like redirect but can be used to allow relative URL redirection.
    Flask's default response makes URLs absolute before putting in the
    Location header due to adhering to the out-dated RFC 2616 which has
    been superseded by RFC 7231.

    The RFC outdated in 2018 but Flask still does not implement the new
    standard.
    """
    return flask.redirect(*args, Response=fixed_location_response, **kwargs)


def register(env):
    # Add some normal Python builtins which can be useful in templates.
    env.globals.update(zip=zip)

    # Add our custom global functions.
    env.globals.update(
        db_url_for=db_url_for,
        v4_url_for=v4_url_for,
        v4_redirect=v4_redirect,
        v4_url_available=v4_url_available)

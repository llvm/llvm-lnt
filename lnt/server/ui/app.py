import jinja2
import logging
import logging.handlers
import os
import time

import flask
from flask import current_app
from flask import g
from flask import url_for

import lnt
import lnt.server.db.v4db
import lnt.server.instance
import lnt.server.ui.filters
import lnt.server.ui.globals
import lnt.server.ui.views

class RootSlashPatchMiddleware(object):
    def __init__(self, app):
        self.app = app

    def __call__(self, environ, start_response):
        if environ['PATH_INFO'] == '':
            return flask.redirect(environ['SCRIPT_NAME'] + '/')(
                environ, start_response)
        return self.app(environ, start_response)

class Request(flask.Request):
    def __init__(self, *args, **kwargs):
        super(Request, self).__init__(*args, **kwargs)

        self.request_time = time.time()
        self.db = None
        self.testsuite = None

    def elapsed_time(self):
        return time.time() - self.request_time

    # Utility Methods

    def get_db(self):
        """
        get_db() -> <db instance>

        Get the active database and add a logging handler if part of the request
        arguments.
        """

        if self.db is None:
            echo = bool(self.args.get('db_log') or self.form.get('db_log'))

            self.db = current_app.old_config.get_database(g.db_name, echo=echo)

            # Enable SQL logging with db_log.
            #
            # FIXME: Conditionalize on an is_production variable.
            if echo:
                import logging, StringIO
                g.db_log = StringIO.StringIO()
                logger = logging.getLogger("sqlalchemy")
                logger.addHandler(logging.StreamHandler(g.db_log))

        return self.db

    def get_testsuite(self):
        """
        get_testsuite() -> server.db.testsuite.TestSuite

        Get the active testsuite.
        """

        if self.testsuite is None:
            testsuites = self.get_db().testsuite
            if g.testsuite_name not in testsuites:
                flask.abort(404)

            self.testsuite = testsuites[g.testsuite_name]

        return self.testsuite

class App(flask.Flask):
    @staticmethod
    def create_standalone(config_path):
        # Construct the application.
        app = App(__name__)

        # Register additional filters.
        lnt.server.ui.filters.register(app)

        # Set up strict undefined mode for templates.
        app.jinja_env.undefined = jinja2.StrictUndefined

        # Load the application configuration.
        app.load_config(config_path)

        # Load the application routes.
        app.register_module(lnt.server.ui.views.frontend)
                        
        return app

    def __init__(self, name):
        super(App, self).__init__(name)
        self.start_time = time.time()

        # Override the request class.
        self.request_class = Request

        # Store a few global things we want available to templates.
        self.version = lnt.__version__

        # Inject a fix for missing slashes on the root URL (see Flask issue
        # #169).
        self.wsgi_app = RootSlashPatchMiddleware(self.wsgi_app)

    def load_config(self, config_path):
        self.instance = lnt.server.instance.Instance.frompath(config_path)
        self.old_config = self.instance.config

        self.jinja_env.globals.update(
            app=current_app,
            old_config=self.old_config)

        lnt.server.ui.globals.register(self)

        # Set the application secret key.
        self.secret_key = self.old_config.secretKey

import importlib.metadata
import io
import logging
import logging.handlers
import sys
import time
import traceback
from logging import Formatter

import datetime
import flask
import jinja2
from flask import current_app
from flask import g
from flask import session
from flask import request
from flask import jsonify
from flask import render_template
from flask_restful import Api
from sqlalchemy.ext.declarative import DeclarativeMeta

import lnt
import lnt.server.db.rules_manager
import lnt.server.db.v4db
import lnt.server.instance
import lnt.server.ui.filters
import lnt.server.ui.globals
import lnt.server.ui.profile_views
import lnt.server.ui.regression_views
import lnt.server.ui.views
from lnt.server.ui.api import load_api_resources
from lnt.util import logger


# The default name of the log file.
LOG_FILENAME = "lnt.log"


class RootSlashPatchMiddleware(object):
    def __init__(self, app):
        self.app = app

    def __call__(self, environ, start_response):
        if environ['PATH_INFO'] == '':
            return flask.redirect(environ['SCRIPT_NAME'] + '/')(
                environ, start_response)
        return self.app(environ, start_response)


class LNTObjectJSONEncoder(flask.json.provider.DefaultJSONProvider):
    """Take SQLAlchemy objects and jsonify them. If the object has an __json__
    method, use that instead."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)

    def default(self, obj):
        if hasattr(obj, '__json__'):
            return obj.__json__()
        if isinstance(obj, datetime.datetime):
            return obj.isoformat()
        if isinstance(obj.__class__, DeclarativeMeta):
            fields = {}
            for field in [x for x in dir(obj)
                          if not x.startswith('_') and x != 'metadata']:
                data = obj.__getattribute__(field)
                if isinstance(data, datetime.datetime):
                    fields[field] = data.isoformat()
                else:
                    try:
                        flask.json.dumps(data)
                        fields[field] = data
                    except TypeError:
                        fields[field] = None

            return fields

        return super().default(self, obj)


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
        assert self.db is not None
        # Enable SQL logging with db_log.
        #
        # FIXME: Conditionalize on an is_production variable.
        show_sql = bool(self.args.get('db_log') or self.form.get('db_log'))
        if show_sql:
            g.db_log = io.StringIO()
            logger = logging.getLogger("sqlalchemy")
            logger.addHandler(logging.StreamHandler(g.db_log))
        return self.db

    def get_testsuite(self):
        """
        get_testsuite() -> server.db.testsuite.TestSuite

        Get the active testsuite.
        """

        if self.testsuite is None:
            testsuites = self.db.testsuite
            if g.testsuite_name not in testsuites:
                flask.abort(404)

            self.testsuite = testsuites[g.testsuite_name]

        return self.testsuite

    def close(self):
        t = self.elapsed_time()
        if t > 10:
            logger.warning("Request {} took {}s".format(self.url, t))
        db = getattr(self, 'db', None)
        if db is not None:
            db.close()
        return super(Request, self).close()


class LNTExceptionLoggerFlask(flask.Flask):
    def log_exception(self, exc_info):
        # We need to stringify the traceback, since logs are sent via
        # pickle.
        logger.error("Exception: " + traceback.format_exc())


class App(LNTExceptionLoggerFlask):
    @staticmethod
    def create_with_instance(instance):
        # Construct the application.
        app = App(__name__)

        app.json = LNTObjectJSONEncoder(app)
        # Register additional filters.
        create_jinja_environment(app.jinja_env)

        # Set up strict undefined mode for templates.
        app.jinja_env.undefined = jinja2.StrictUndefined

        # Load the application configuration.
        app.load_config(instance)

        # Load the application routes.
        app.register_blueprint(lnt.server.ui.views.frontend)

        # Load the flaskRESTful API.
        app.api = Api(app)
        load_api_resources(app.api)

        @app.before_request
        def set_session():
            """Make our session cookies last."""
            session.permanent = True

        @app.errorhandler(404)
        def page_not_found(e):
            message = "{}: {}".format(e.name, e.description)
            if request.accept_mimetypes.accept_json and \
                    not request.accept_mimetypes.accept_html:
                response = jsonify({
                    'error': 'The page you are looking for does not exist.',
                })
                response.status_code = 404
                return response
            return render_template('error.html', message=message), 404

        @app.errorhandler(500)
        def internal_server_error(e):
            if request.accept_mimetypes.accept_json and \
                    not request.accept_mimetypes.accept_html:
                response = jsonify({
                    'error': 'internal server error',
                    'message': repr(e),
                })
                response.status_code = 500
                return response
            return render_template('error.html', message=repr(e)), 500

        return app

    @staticmethod
    def create_standalone(config_path, log_file=None):
        """
        Create an instance of a lnt Flask application from a config file.

        :param config_path: path to lnt config (directory or config file).

        :param log_file: instead of setting up logging, use this log file.
        when running in a multiprocess server like gunicorn, you need to use
        gunicorn's logging instead (since it is multiprocess safe. In this case
        LNT will print to to stderr and it can be collected by gunicorn. The
        LNT logs page will show this unified log page.

        :return: a LNT Flask App, ready to be loaded into a wsgi server.

        """
        instance = lnt.server.instance.Instance.frompath(config_path)
        app = App.create_with_instance(instance)
        app.start_file_logging(log_file)
        return app

    def __init__(self, name):
        super(App, self).__init__(name)
        self.start_time = time.time()
        # Override the request class.
        self.request_class = Request

        # Store a few global things we want available to templates.
        self.version = importlib.metadata.version('llvm-lnt')

        # Inject a fix for missing slashes on the root URL (see Flask issue
        # #169).
        self.wsgi_app = RootSlashPatchMiddleware(self.wsgi_app)
        self.logger.setLevel(logging.DEBUG)

    def load_config(self, instance):
        self.instance = instance
        self.old_config = self.instance.config

        self.jinja_env.globals.update(
            app=current_app,
            old_config=self.old_config)

        # Set the application secret key.
        self.secret_key = self.old_config.secretKey

        lnt.server.db.rules_manager.register_hooks()

    def start_file_logging(self, log_file_name):
        """Start server production logging.  At this point flask already logs
        to stderr, so just log to a file as well.

        """
        # Always Print to screen.
        ch = logging.StreamHandler()
        ch.setLevel(logging.DEBUG)
        ch.setFormatter(Formatter('%(levelname)s: %(message)s '
                                  '[in %(filename)s:%(lineno)d %(asctime)s]'))
        self.logger.addHandler(ch)

        # When running in a server config, use the server to setup the log
        # file. If there is more than one process running, this will not work
        # well.
        if not log_file_name:
            self.config['log_file_name'] = LOG_FILENAME
            try:
                rotating = logging.handlers.RotatingFileHandler(
                    LOG_FILENAME, maxBytes=1048576, backupCount=5)
                rotating.setFormatter(Formatter(
                    '%(asctime)s %(levelname)s: %(message)s '
                    '[in %(filename)s:%(lineno)d]'
                ))
                rotating.setLevel(logging.DEBUG)
                self.logger.addHandler(rotating)
            except (OSError, IOError) as e:
                print("Error making log file",
                      LOG_FILENAME, str(e), file=sys.stderr)
                print("Will not log to file.", file=sys.stderr)
            else:
                self.logger.info("Started file logging.")
                print("Logging to :", LOG_FILENAME)
        else:
            self.config['log_file_name'] = log_file_name


def create_jinja_environment(env=None):
    """
    create_jinja_environment([env]) -> jinja2.Environment

    Create (or modify) a new Jinja2 environment suitable for rendering the LNT
    templates.
    """

    if env is None:
        env = jinja2.Environment(loader=jinja2.PackageLoader(
            'lnt.server.ui', 'templates'))
    lnt.server.ui.globals.register(env)
    lnt.server.ui.filters.register(env)

    return env

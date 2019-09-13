from __future__ import print_function
import click
import platform


kConfigVersion = (0, 1, 0)
kConfigTemplate = """\
# LNT configuration file
#
# Paths are resolved relative to this file.

# The configuration file version.
config_version = %(cfg_version)r

# Name to use for this installation. This appears in web page headers, for
# example.
name = %(name)r

# Path to the LNT server. This is required for use in emails where we need to
# provide an absolute URL to the server.
zorgURL = %(hosturl)r

# Temporary directory, for use by the web app. This must be writable by the
# user the web app runs as.
tmp_dir = %(tmp_dir)r

# Database directory, for easily rerooting the entire set of databases.
# Database paths are resolved relative to the config path + this path.
db_dir = %(db_dir)r

# Profile directory, where profiles are kept.
profile_dir = %(profile_dir)r

# Secret key for this server instance.
secret_key = %(secret_key)r

# REST API authentication
# api_auth_token = 'secret'

# The list of available databases, and their properties. At a minimum, there
# should be a 'default' entry for the default database.
databases = {
    'default' : { 'path' : %(default_db)r },
    }

# The LNT email configuration.
#
# The 'to' field can be either a single email address, or a list of
# (regular-expression, address) pairs. In the latter form, the machine name of
# the submitted results is matched against the regular expressions to determine
# which email address to use for the results.
nt_emailer = {
    'enabled' : False,
    'host' : None,
    'from' : None,

    # This is a list of (filter-regexp, address) pairs -- it is evaluated in
    # order based on the machine name. This can be used to dispatch different
    # reports to different email address.
    'to' : [(".*", None)],
    }

# Enable automatic restart using the wsgi_restart module; this should be off in
# a production environment.
wsgi_restart = False
"""

kWSGITemplate = """\
#!%(python_executable)s
# -*- Python -*-

import lnt.server.ui.app

application = lnt.server.ui.app.App.create_standalone(
  %(cfg_path)r)

if __name__ == "__main__":
    import werkzeug
    werkzeug.run_simple('%(hostname)s', 8000, application)
"""


@click.command("create", short_help="create an LLVM nightly test installation")
@click.argument("instance_path", type=click.UNPROCESSED)
@click.option("--name", default="LNT", show_default=True,
              help="name to use for the installation")
@click.option("--config", default="lnt.cfg", show_default=True,
              help="name of the LNT config file")
@click.option("--wsgi", default="lnt.wsgi", show_default=True,
              help="name of the WSGI app")
@click.option("--tmp-dir", default="lnt_tmp", show_default=True,
              help="name of the temp file directory")
@click.option("--db-dir", default="data", show_default=True,
              help="name of the directory to hold databases")
@click.option("--profile-dir", default="data/profiles", show_default=True,
              help="name of the directory to hold profiles")
@click.option("--default-db", default="lnt.db", show_default=True,
              help="name for the default db")
@click.option("--secret-key", default=None,
              help="secret key to use for this installation")
@click.option("--hostname", default=platform.uname()[1], show_default=True,
              help="host name of the server")
@click.option("--hostsuffix", default="perf", show_default=True,
              help="suffix at which WSGI app lives")
@click.option("--show-sql", is_flag=True,
              help="show SQL statements executed during construction")
def action_create(instance_path, name, config, wsgi, tmp_dir, db_dir,
                  profile_dir, default_db, secret_key, hostname, hostsuffix,
                  show_sql):
    """create an LLVM nightly test installation

\b
* INSTANCE_PATH should point to a directory that will keep
LNT configuration.
    """
    from .common import init_logger
    import hashlib
    import lnt.server.db.migrate
    import lnt.server.db.util
    import lnt.testing
    import logging
    import os
    import random
    import sys

    init_logger(logging.INFO if show_sql else logging.WARNING,
                show_sql=show_sql)

    basepath = os.path.abspath(instance_path)
    if os.path.exists(basepath):
        raise SystemExit("error: invalid path: %r already exists" % basepath)

    hosturl = "http://%s/%s" % (hostname, hostsuffix)

    python_executable = sys.executable
    cfg_path = os.path.join(basepath, config)
    tmp_path = os.path.join(basepath, tmp_dir)
    wsgi_path = os.path.join(basepath, wsgi)
    schemas_path = os.path.join(basepath, "schemas")
    secret_key = (secret_key or
                  hashlib.sha1(str(random.getrandbits(256))).hexdigest())

    os.mkdir(instance_path)
    os.mkdir(tmp_path)
    os.mkdir(schemas_path)

    # If the path does not contain database type, assume relative path.
    if lnt.server.db.util.path_has_no_database_type(db_dir):
        db_dir_path = os.path.join(basepath, db_dir)
        db_path = os.path.join(db_dir_path, default_db)
        os.mkdir(db_dir_path)
    else:
        db_path = os.path.join(db_dir, default_db)

    cfg_version = kConfigVersion
    cfg_file = open(cfg_path, 'w')
    cfg_file.write(kConfigTemplate % locals())
    cfg_file.close()

    wsgi_file = open(wsgi_path, 'w')
    wsgi_file.write(kWSGITemplate % locals())
    wsgi_file.close()
    os.chmod(wsgi_path, 0o755)

    # Execute an upgrade on the database to initialize the schema.
    lnt.server.db.migrate.update_path(db_path)

    print('created LNT configuration in %r' % basepath)
    print('  configuration file: %s' % cfg_path)
    print('  WSGI app          : %s' % wsgi_path)
    print('  database file     : %s' % db_path)
    print('  temporary dir     : %s' % tmp_path)
    print('  host URL          : %s' % hosturl)
    print()
    print('You can execute:')
    print('  %s' % wsgi_path)
    print('to test your installation with the builtin server.')
    print()
    print('For production use configure this application to run with any')
    print('WSGI capable web server. You may need to modify the permissions')
    print('on the database and temporary file directory to allow writing')
    print('by the web app.')
    print()

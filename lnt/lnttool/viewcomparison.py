import logging
import os
import shutil
import sys
import tempfile
import thread
import time
import urllib
import webbrowser
from optparse import OptionParser
import contextlib

from lnt.util.ImportData import import_and_report
from lnt.testing.util.commands import note, warning


def start_browser(url, debug=False):
    def url_is_up(url):
        try:
            o = urllib.urlopen(url)
        except IOError:
            return False
        o.close()
        return True

    # Wait for server to start...
    if debug:
        note('waiting for server to start...')
    for i in range(10000):
        if url_is_up(url):
            break
        if debug:
            sys.stderr.write('.')
            sys.stderr.flush()
        time.sleep(.01)
    else:
        warning('unable to detect that server started')
                
    if debug:
        note('opening webbrowser...')
    webbrowser.open(url)


def action_view_comparison(name, args):
    """view a report comparison using a temporary server"""

    import lnt.server.instance
    import lnt.server.ui.app
    import lnt.server.db.migrate

    parser = OptionParser("%s [options] <report A> <report B>" % (name,))
    parser.add_option("", "--hostname", dest="hostname", type=str,
                      help="host interface to use [%default]",
                      default='localhost')
    parser.add_option("", "--port", dest="port", type=int, metavar="N",
                      help="local port to use [%default]", default=8000)
    parser.add_option("", "--dry-run", dest="dry_run",
                      help="Do a dry run through the comparison. [%default]"
                      " [%default]", action="store_true", default=False)
    (opts, args) = parser.parse_args(args)

    if len(args) != 2:
        parser.error("invalid number of arguments")

    report_a_path, report_b_path = args

    # Set up the default logger.
    logger = logging.getLogger("lnt")
    logger.setLevel(logging.ERROR)
    handler = logging.StreamHandler(sys.stderr)
    handler.setFormatter(logging.Formatter(
        '%(asctime)s %(levelname)s: %(message)s',
        datefmt='%Y-%m-%d %H:%M:%S'))
    logger.addHandler(handler)

    # Create a temporary directory to hold the instance.
    tmpdir = tempfile.mkdtemp(suffix='lnt')

    try:
        # Create a temporary instance.
        url = 'http://%s:%d' % (opts.hostname, opts.port)
        db_path = os.path.join(tmpdir, 'data.db')
        db_info = lnt.server.config.DBInfo(
            'sqlite:///%s' % (db_path,), '0.4', None,
            lnt.server.config.EmailConfig(False, '', '', []), "0")
        # _(self, name, zorgURL, dbDir, tempDir,
        # profileDir, secretKey, databases, blacklist):
        config = lnt.server.config.Config('LNT', url, db_path, tmpdir,
                                          None, "Not secret key.", {'default': db_info},
                                          None)
        instance = lnt.server.instance.Instance(None, config)

        # Create the database.
        lnt.server.db.migrate.update_path(db_path)

        # Import the two reports.
        with contextlib.closing(config.get_database('default')) as db:
            import_and_report(
                config, 'default', db, report_a_path,
                '<auto>', commit=True)
            import_and_report(
                config, 'default', db, report_b_path,
                '<auto>', commit=True)

            # Dispatch another thread to start the webbrowser.
            comparison_url = '%s/v4/nts/2?compare_to=1' % (url,)
            note("opening comparison view: %s" % (comparison_url,))
            
            if not opts.dry_run:
                thread.start_new_thread(start_browser, (comparison_url, True))

            # Run the webserver.
            app = lnt.server.ui.app.App.create_with_instance(instance)
            app.debug = True
            
            if opts.dry_run:
                # Don't catch out exceptions.
                app.testing = True
                # Create a test client.
                client = app.test_client()
                response = client.get(comparison_url)
                assert response.status_code == 200, "Page did not return 200."
            else:
                app.run(opts.hostname, opts.port, use_reloader=False)
    finally:
        shutil.rmtree(tmpdir)

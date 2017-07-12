import click


def _start_browser(url, debug=False):
    def url_is_up(url):
        try:
            o = urllib.urlopen(url)
        except IOError:
            return False
        o.close()
        return True

    # Wait for server to start...
    if debug:
        logger.info('waiting for server to start...')
    for i in range(10000):
        if url_is_up(url):
            break
        if debug:
            sys.stderr.write('.')
            sys.stderr.flush()
        time.sleep(.01)
    else:
        logger.warning('unable to detect that server started')

    if debug:
        logger.info('opening webbrowser...')
    webbrowser.open(url)


@click.command("view-comparison")
@click.argument("report_a", type=click.Path(exists=True))
@click.argument("report_b", type=click.Path(exists=True))
@click.option("--hostname", default="localhost", show_default=True,
              help="host interface to use")
@click.option("--port", default=8000, show_default=True,
              help="local port to use")
@click.option("--dry-run", is_flag=True,
              help="do a dry run through the comparison")
@click.option("--testsuite", "-s", default='nts')
def action_view_comparison(report_a, report_b, hostname, port, dry_run,
                           testsuite):
    """view a report comparison using a temporary server"""
    from .common import init_logger
    from lnt.util import logger
    from lnt.util.ImportData import import_and_report
    import contextlib
    import lnt.server.db.migrate
    import lnt.server.instance
    import lnt.server.ui.app
    import logging
    import os
    import shutil
    import sys
    import tempfile
    import thread
    import time
    import urllib
    import webbrowser

    init_logger(logging.ERROR)

    # Create a temporary directory to hold the instance.
    tmpdir = tempfile.mkdtemp(suffix='lnt')

    try:
        # Create a temporary instance.
        url = 'http://%s:%d' % (hostname, port)
        db_path = os.path.join(tmpdir, 'data.db')
        db_info = lnt.server.config.DBInfo(
            'sqlite:///%s' % (db_path,), '0.4', None,
            lnt.server.config.EmailConfig(False, '', '', []), "0")
        # _(self, name, zorgURL, dbDir, tempDir,
        # profileDir, secretKey, databases, blacklist):
        config = lnt.server.config.Config('LNT', url, db_path, tmpdir,
                                          None, "Not secret key.",
                                          {'default': db_info}, None,
                                          None)
        instance = lnt.server.instance.Instance(None, config)

        # Create the database.
        lnt.server.db.migrate.update_path(db_path)

        # Import the two reports.
        with contextlib.closing(config.get_database('default')) as db:
            r = import_and_report(config, 'default', db, report_a, '<auto>',
                                  testsuite, commit=True)
            import_and_report(config, 'default', db, report_b, '<auto>',
                              testsuite, commit=True)

            # Dispatch another thread to start the webbrowser.
            comparison_url = '%s/v4/nts/2?compare_to=1' % (url,)
            logger.info("opening comparison view: %s" % (comparison_url,))

            if not dry_run:
                thread.start_new_thread(_start_browser, (comparison_url, True))

            # Run the webserver.
            app = lnt.server.ui.app.App.create_with_instance(instance)
            app.debug = True

            if dry_run:
                # Don't catch out exceptions.
                app.testing = True
                # Create a test client.
                client = app.test_client()
                response = client.get(comparison_url)
                assert response.status_code == 200, "Page did not return 200."
            else:
                app.run(hostname, port, use_reloader=False)
    finally:
        shutil.rmtree(tmpdir)

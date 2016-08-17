"""Implement the command line 'lnt' tool."""

import logging
import os
import sys
import tempfile
import json
from optparse import OptionParser, OptionGroup
import contextlib

import werkzeug.contrib.profiler

import StringIO
import lnt
import lnt.util.multitool
import lnt.util.ImportData
from lnt import testing
from lnt.testing.util.commands import note, warning, error, fatal, LOGGER_NAME
import lnt.testing.profile.profile as profile

import code

def action_runserver(name, args):
    """start a new development server"""

    parser = OptionParser("""\
%s [options] <instance path>

Start the LNT server using a development WSGI server. Additional options can be
used to control the server host and port, as well as useful development features
such as automatic reloading.

The command has built-in support for running the server on an instance which has
been packed into a (compressed) tarball. The tarball will be automatically
unpacked into a temporary directory and removed on exit. This is useful for
passing database instances back and forth, when others only need to be able to
view the results.\
""" % name)
    parser.add_option("", "--hostname", dest="hostname", type=str,
                      help="host interface to use [%default]",
                      default='localhost')
    parser.add_option("", "--port", dest="port", type=int, metavar="N",
                      help="local port to use [%default]", default=8000)
    parser.add_option("", "--reloader", dest="reloader", default=False,
                      action="store_true", help="use WSGI reload monitor")
    parser.add_option("", "--debugger", dest="debugger", default=False,
                      action="store_true", help="use WSGI debugger")
    parser.add_option("", "--profiler-file", dest="profiler_file",
                      help="file to dump profile info to [%default]",
                      default="profiler.log")
    parser.add_option("", "--profiler-dir", dest="profiler_dir",
                      help="pstat.Stats files are saved to this directory " \
                          +"[%default]",
                      default=None)
    parser.add_option("", "--profiler", dest="profiler", default=False,
                      action="store_true", help="enable WSGI profiler")
    parser.add_option("", "--shell", dest="shell", default=False,
                      action="store_true", help="Load in shell.")
    parser.add_option("", "--show-sql", dest="show_sql", default=False,
                      action="store_true", help="show all SQL queries")
    parser.add_option("", "--threaded", dest="threaded", default=False,
                      action="store_true", help="use a threaded server")
    parser.add_option("", "--processes", dest="processes", type=int,
                      metavar="N", help="number of processes to use [%default]",
                      default=1)

    (opts, args) = parser.parse_args(args)
    if len(args) != 1:
        parser.error("invalid number of arguments")

    input_path, = args

    # Setup the base LNT logger.
    # Root logger in debug.
    logger = logging.getLogger(LOGGER_NAME)
    if opts.debugger:
        logger.setLevel(logging.DEBUG)
    handler = logging.StreamHandler()
    handler.setLevel(logging.DEBUG)
    handler.setFormatter(logging.Formatter(
            '%(asctime)s %(levelname)s: %(message)s',
            datefmt='%Y-%m-%d %H:%M:%S'))
    logger.addHandler(handler)

    # Enable full SQL logging, if requested.
    if opts.show_sql:
        sa_logger = logging.getLogger("sqlalchemy")
        if opts.debugger:
            sa_logger.setLevel(logging.DEBUG)
        sa_logger.setLevel(logging.INFO)
        sa_logger.addHandler(handler)

    import lnt.server.ui.app
    app = lnt.server.ui.app.App.create_standalone(input_path,)
    if opts.debugger:
        app.debug = True
    if opts.profiler:
        if opts.profiler_dir:
            if not os.path.isdir(opts.profiler_dir):
                os.mkdir(opts.profiler_dir)
        app.wsgi_app = werkzeug.contrib.profiler.ProfilerMiddleware(
            app.wsgi_app, stream = open(opts.profiler_file, 'w'),
            profile_dir = opts.profiler_dir)
    if opts.shell:
        from flask import current_app
        from flask import g
        ctx = app.test_request_context()
        ctx.push()

        vars = globals().copy()
        vars.update(locals())
        shell = code.InteractiveConsole(vars)
        shell.interact()
    else:
        app.run(opts.hostname, opts.port,
            use_reloader = opts.reloader,
            use_debugger = opts.debugger,
            threaded = opts.threaded,
            processes = opts.processes)

from create import action_create
from convert import action_convert
from import_data import action_import
from updatedb import action_updatedb
from viewcomparison import action_view_comparison

def action_checkformat(name, args):
    """check the format of an LNT test report file"""

    parser = OptionParser("%s [options] files" % name)

    (opts, args) = parser.parse_args(args)
    if len(args) > 1:
        parser.error("incorrect number of argments")

    if len(args) == 0:
        input = '-'
    else:
        input, = args

    if input == '-':
        input = StringIO.StringIO(sys.stdin.read())

    import lnt.server.db.v4db
    import lnt.server.config
    db = lnt.server.db.v4db.V4DB('sqlite:///:memory:',
                                 lnt.server.config.Config.dummyInstance())
    result = lnt.util.ImportData.import_and_report(
        None, None, db, input, 'json', commit = True)
    lnt.util.ImportData.print_report_result(result, sys.stdout, sys.stderr,
                                            verbose = True)

def action_runtest(name, args):
    """run a builtin test application"""

    # Runtest accepting options is deprecated, but lets not break the
    # world, so collect them anyways and pass them on.
    parser = OptionParser("%s test-name [options]" % name)
    parser.disable_interspersed_args()
    parser.add_option("", "--submit", dest="submit", type=str, default=None)
    parser.add_option("", "--commit", dest="commit", type=str, default=None)
    parser.add_option("", "--output", dest="output", type=str, default=None)
    parser.add_option("-v", "--verbose", dest="verbose", action="store_true")

    (deprecated_opts, args) = parser.parse_args(args)
    if len(args) < 1:
        parser.error("incorrect number of argments")

    test_name, args = args[0], args[1:]
    # Rebuild the deprecated arguments.
    for key, val in vars(deprecated_opts).iteritems():
        if val is not None:
            if isinstance(val, str):
                args.insert(0, val)
            args.insert(0, "--" + key)

            warning("--{} should be passed directly to the"
                        " test suite.".format(key))

    logger = logging.getLogger(LOGGER_NAME)
    logger.setLevel(logging.INFO)
    handler = logging.StreamHandler()
    handler.setLevel(logging.INFO)
    handler.setFormatter(logging.Formatter(
            '%(asctime)s %(levelname)s: %(message)s',
            datefmt='%Y-%m-%d %H:%M:%S'))
    logger.addHandler(handler)
    import lnt.tests
    try:
        test_instance = lnt.tests.get_test_instance(test_name)
    except KeyError:
        parser.error('invalid test name %r' % test_name)

    server_results = test_instance.run_test('%s %s' % (name, test_name), args)
    if server_results.get('result_url'):
        print "Results available at:", server_results['result_url']
    else:
        print "Results available at: no URL available"


def action_showtests(name, args):
    """show the available built-in tests"""

    parser = OptionParser("%s" % name)
    (opts, args) = parser.parse_args(args)
    if len(args) != 0:
        parser.error("incorrect number of argments")

    import lnt.tests

    print 'Available tests:'
    test_names = lnt.tests.get_test_names()
    max_name = max(map(len, test_names))
    for name in test_names:
        print '  %-*s - %s' % (max_name, name,
                               lnt.tests.get_test_description(name))

def action_submit(name, args):
    """submit a test report to the server"""

    parser = OptionParser("%s [options] <url> <file>+" % name)
    parser.add_option("", "--commit", dest="commit", type=int,
                      help=("whether the result should be committed "
                            "[%default]"),
                      default=True)
    parser.add_option("-v", "--verbose", dest="verbose",
                      help="show verbose test results",
                      action="store_true", default=False)

    (opts, args) = parser.parse_args(args)
    if len(args) < 2:
        parser.error("incorrect number of argments")

    if not opts.commit:
        warning("submit called with --commit=0, your results will not be saved"
                " at the server.")

    from lnt.util import ServerUtil
    files = ServerUtil.submitFiles(args[0], args[1:],
                                   opts.commit, opts.verbose)
    if opts.verbose:
        for f in files:
            lnt.util.ImportData.print_report_result(f, sys.stdout,
                                                    sys.stderr, True)

def action_update(name, args):
    """create and or auto-update the given database"""

    parser = OptionParser("%s [options] <db path>" % name)
    parser.add_option("", "--show-sql", dest="show_sql", default=False,
                      action="store_true", help="show all SQL queries")

    (opts, args) = parser.parse_args(args)
    if len(args) != 1:
        parser.error("incorrect number of argments")

    db_path, = args

    # Setup the base LNT logger.
    logger = logging.getLogger("lnt")
    logger.setLevel(logging.INFO)
    handler = logging.StreamHandler(sys.stderr)
    handler.setFormatter(logging.Formatter(
            '%(asctime)s %(levelname)s: %(message)s',
            datefmt='%Y-%m-%d %H:%M:%S'))
    logger.addHandler(handler)

    # Enable full SQL logging, if requested.
    if opts.show_sql:
        sa_logger = logging.getLogger("sqlalchemy")
        sa_logger.setLevel(logging.INFO)
        sa_logger.addHandler(handler)

    # Update the database.
    lnt.server.db.migrate.update_path(db_path)


def action_send_daily_report(name, args):
    """send a daily report email"""
    import datetime
    import email.mime.multipart
    import email.mime.text
    import smtplib

    import lnt.server.reporting.dailyreport

    parser = OptionParser("%s [options] <instance path> <address>" % (
            name,))
    parser.add_option("", "--database", dest="database", default="default",
                      help="database to use [%default]")
    parser.add_option("", "--testsuite", dest="testsuite", default="nts",
                      help="testsuite to use [%default]")
    parser.add_option("", "--host", dest="host", default="localhost",
                      help="email relay host to use [%default]")
    parser.add_option("", "--from", dest="from_address", default=None,
                      help="from email address (required)")
    parser.add_option("", "--today", dest="today", action="store_true",
                      help="send the report for today (instead of most recent)")
    parser.add_option("", "--subject-prefix", dest="subject_prefix",
                      help="add a subject prefix")
    parser.add_option("-n", "--dry-run", dest="dry_run", default=False,
                      action="store_true", help="Don't actually send email."
                      " Used for testing.")
    parser.add_option("", "--days", dest="days", default=3, type="int",
                      help="Number of days to show in report.")
    parser.add_option("", "--filter-machine-regex", dest="filter_machine_regex",
                      default=None,
                      help="only show machines that contain the regex.")

    (opts, args) = parser.parse_args(args)

    if len(args) != 2:
        parser.error("invalid number of arguments")
    if opts.from_address is None:
        parser.error("--from argument is required")

    path, to_address = args

    # Load the LNT instance.
    instance = lnt.server.instance.Instance.frompath(path)
    config = instance.config

    # Get the database.
    with contextlib.closing(config.get_database(opts.database)) as db:

        # Get the testsuite.
        ts = db.testsuite[opts.testsuite]

        if opts.today:
            date = datetime.datetime.utcnow()
        else:
            # Get a timestamp to use to derive the daily report to generate.
            latest = ts.query(ts.Run).\
                order_by(ts.Run.start_time.desc()).limit(1).first()

            # If we found a run, use it's start time (rounded up to the next
            # hour, so we make sure it gets included).
            if latest:
                date = latest.start_time + datetime.timedelta(hours=1)
            else:
                # Otherwise, just use now.
                date = datetime.datetime.utcnow()

        # Generate the daily report.
        note("building report data...")
        report = lnt.server.reporting.dailyreport.DailyReport(
            ts, year=date.year, month=date.month, day=date.day,
            day_start_offset_hours=date.hour, for_mail=True,
            num_prior_days_to_include=opts.days,
            filter_machine_regex=opts.filter_machine_regex)
        report.build()

        note("generating HTML report...")
        ts_url = "%s/db_%s/v4/%s" \
            % (config.zorgURL, opts.database, opts.testsuite)
        subject = "Daily Report: %04d-%02d-%02d" % (
            report.year, report.month, report.day)
        html_report = report.render(ts_url, only_html_body=False)

        if opts.subject_prefix is not None:
            subject = "%s %s" % (opts.subject_prefix, subject)

        # Form the multipart email message.
        msg = email.mime.multipart.MIMEMultipart('alternative')
        msg['Subject'] = subject
        msg['From'] = opts.from_address
        msg['To'] = to_address
        msg.attach(email.mime.text.MIMEText(html_report, "html"))

        # Send the report.
        if not opts.dry_run:
            s = smtplib.SMTP(opts.host)
            s.sendmail(opts.from_address, [to_address],
                       msg.as_string())
            s.quit()


def action_send_run_comparison(name, args):
    """send a run-vs-run comparison email"""
    import email.mime.multipart
    import email.mime.text
    import smtplib

    import lnt.server.reporting.dailyreport
    
    parser = OptionParser("%s [options] <instance path> "
                          "<run A ID> <run B ID>" % (
            name,))
    parser.add_option("", "--database", dest="database", default="default",
                      help="database to use [%default]")
    parser.add_option("", "--testsuite", dest="testsuite", default="nts",
                      help="testsuite to use [%default]")
    parser.add_option("", "--host", dest="host", default="localhost",
                      help="email relay host to use [%default]")
    parser.add_option("", "--from", dest="from_address", default=None,
                      help="from email address (required)")
    parser.add_option("", "--to", dest="to_address", default=None,
                      help="to email address (required)")
    parser.add_option("", "--subject-prefix", dest="subject_prefix",
                      help="add a subject prefix")
    parser.add_option("-n", "--dry-run", dest="dry_run", default=False,
                      action="store_true", help="Don't actually send email."
                      " Used for testing.")

    (opts, args) = parser.parse_args(args)

    if len(args) != 3:
        parser.error("invalid number of arguments")
    if opts.from_address is None:
        parser.error("--from argument is required")
    if opts.to_address is None:
        parser.error("--to argument is required")

    path, run_a_id, run_b_id = args

    # Setup the base LNT logger.
    logger = logging.getLogger("lnt")
    logger.setLevel(logging.ERROR)
    handler = logging.StreamHandler(sys.stderr)
    handler.setFormatter(logging.Formatter(
            '%(asctime)s %(levelname)s: %(message)s',
            datefmt='%Y-%m-%d %H:%M:%S'))
    logger.addHandler(handler)

    # Load the LNT instance.
    instance = lnt.server.instance.Instance.frompath(path)
    config = instance.config

    # Get the database.
    with contextlib.closing(config.get_database(opts.database)) as db:

        # Get the testsuite.
        ts = db.testsuite[opts.testsuite]

        # Lookup the two runs.
        run_a_id = int(run_a_id)
        run_b_id = int(run_b_id)
        run_a = ts.query(ts.Run).\
            filter_by(id=run_a_id).first()
        run_b = ts.query(ts.Run).\
            filter_by(id=run_b_id).first()
        if run_a is None:
            parser.error("invalid run ID %r (not in database)" % (run_a_id,))
        if run_b is None:
            parser.error("invalid run ID %r (not in database)" % (run_b_id,))

        # Generate the report.
        reports = lnt.server.reporting.runs.generate_run_report(
            run_b, baseurl=config.zorgURL, only_html_body=False, result=None,
            compare_to=run_a, baseline=None,
            aggregation_fn=min)
        subject, text_report, html_report, _ = reports

        if opts.subject_prefix is not None:
            subject = "%s %s" % (opts.subject_prefix, subject)

        # Form the multipart email message.
        msg = email.mime.multipart.MIMEMultipart('alternative')
        msg['Subject'] = subject
        msg['From'] = opts.from_address
        msg['To'] = opts.to_address
        msg.attach(email.mime.text.MIMEText(text_report, 'plain'))
        msg.attach(email.mime.text.MIMEText(html_report, 'html'))

        # Send the report.
        if not opts.dry_run:
            s = smtplib.SMTP(opts.host)
            s.sendmail(opts.from_address, [opts.to_address],
                       msg.as_string())
            s.quit()

def action_profile(name, args):
    if len(args) < 1 or args[0] not in ('upgrade', 'getVersion', 'getTopLevelCounters',
                                        'getFunctions', 'getCodeForFunction'):
        print >>sys.stderr, """lnt profile - available actions:
  upgrade        - Upgrade a profile to the latest version
  getVersion     - Print the version of a profile
  getTopLevelCounters - Print the whole-profile counter values
  getFunctions   - Print an overview of the functions in a profile
  getCodeForFunction - Print the code/instruction information for a function
"""
        return

    if args[0] == 'upgrade':
        parser = OptionParser("lnt profile upgrade <input> <output>")
        opts, args = parser.parse_args(args)
        if len(args) < 3:
            parser.error('Expected 2 arguments')

        profile.Profile.fromFile(args[1]).upgrade().save(filename=args[2])
        return

    if args[0] == 'getVersion':
        parser = OptionParser("lnt profile getVersion <input>")
        opts, args = parser.parse_args(args)
        if len(args) < 2:
            parser.error('Expected 1 argument')
        print profile.Profile.fromFile(args[1]).getVersion()
        return

    if args[0] == 'getTopLevelCounters':
        parser = OptionParser("lnt profile getTopLevelCounters <input>")
        opts, args = parser.parse_args(args)
        if len(args) < 2:
            parser.error('Expected 1 argument')
        print json.dumps(profile.Profile.fromFile(args[1]).getTopLevelCounters())
        return

    if args[0] == 'getFunctions':
        parser = OptionParser("lnt profile getTopLevelCounters <input>")
        opts, args = parser.parse_args(args)
        if len(args) < 2:
            parser.error('Expected 1 argument')
        print json.dumps(profile.Profile.fromFile(args[1]).getFunctions())
        return
    
    if args[0] == 'getCodeForFunction':
        parser = OptionParser("lnt profile getTopLevelCounters <input> <fn>")
        opts, args = parser.parse_args(args)
        if len(args) < 3:
            parser.error('Expected 2 arguments')
        print json.dumps(
            list(profile.Profile.fromFile(args[1]).getCodeForFunction(args[2])))
        return

    assert False

###

def _version_check():
    """
    Check that the installed version of the LNT is up-to-date with the running
    package.

    This check is used to force users of distribute's develop mode to reinstall
    when the version number changes (which may involve changing package
    requirements).
    """
    import pkg_resources

    # Get the current distribution.
    installed_dist = pkg_resources.get_distribution("LNT")
    installed_dist_name = "%s %s" % (installed_dist.project_name,
                                     installed_dist.version)
    current_dist_name = "LNT %s" % (lnt.__version__,)
    if pkg_resources.parse_version(installed_dist_name) != \
         pkg_resources.parse_version(current_dist_name):
        raise SystemExit("""\
error: installed distribution %s is not current (%s), you may need to reinstall
LNT or rerun 'setup.py develop' if using development mode.""" % (
                installed_dist_name, current_dist_name))

tool = lnt.util.multitool.MultiTool(locals(), "LNT %s" % (lnt.__version__,))

def main(*args, **kwargs):
    _version_check()
    return tool.main(*args, **kwargs)

if __name__ == '__main__':
    main()

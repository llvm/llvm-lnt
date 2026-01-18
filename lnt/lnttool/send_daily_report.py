import click
import sys
from lnt.util import logger


@click.command("send-daily-report")
@click.argument("instance_path", type=click.UNPROCESSED)
@click.argument("address")
@click.option("--database", default="default", show_default=True,
              help="database to use")
@click.option("--testsuite", default="nts", show_default=True,
              help="testsuite to use")
@click.option("--host", default="localhost", show_default=True,
              help="email relay host to use")
@click.option("--from", "from_address", default=None, required=True,
              help="from email address")
@click.option("--today", is_flag=True,
              help="send the report for today (instead of most recent)")
@click.option("--subject-prefix", help="add a subject prefix")
@click.option("--dry-run", is_flag=True, help="don't actually send email")
@click.option("--days", default=3, show_default=True,
              help="number of days to show in report")
@click.option("--filter-machine-regex",
              help="only show machines that contain the regex")
def action_send_daily_report(instance_path, address, database, testsuite, host,
                             from_address, today, subject_prefix, dry_run,
                             days, filter_machine_regex):
    """send a daily report email"""
    import contextlib
    import datetime
    import email.mime.multipart
    import email.mime.text
    import lnt.server.instance
    import lnt.server.reporting.dailyreport
    import smtplib

    # Load the LNT instance.
    instance = lnt.server.instance.Instance.frompath(instance_path)
    config = instance.config

    # Get the database.
    with contextlib.closing(config.get_database(database)) as db:
        session = db.make_session()

        # Get the testsuite.
        ts = db.testsuite[testsuite]

        if today:
            date = datetime.datetime.utcnow()
        else:
            # Get a timestamp to use to derive the daily report to generate.
            latest = session.query(ts.Run).\
                order_by(ts.Run.start_time.desc()).limit(1).first()

            # If we found a run, use its start time (rounded up to the next
            # hour, so we make sure it gets included).
            if latest:
                date = latest.start_time + datetime.timedelta(hours=1)
            else:
                # Otherwise, just use now.
                date = datetime.datetime.utcnow()

        # Generate the daily report.
        logger.info("building report data...")
        report = lnt.server.reporting.dailyreport.DailyReport(
            ts, year=date.year, month=date.month, day=date.day,
            day_start_offset_hours=date.hour, for_mail=True,
            num_prior_days_to_include=days,
            filter_machine_regex=filter_machine_regex)
        report.build(session)

        logger.info("generating HTML report...")
        ts_url = "%s/db_%s/v4/%s" \
            % (config.zorgURL, database, testsuite)
        subject = "Daily Report: %04d-%02d-%02d" % (
            report.year, report.month, report.day)
        html_report = report.render(ts_url, only_html_body=False)
        utf8_html_report = html_report.encode('utf-8')

        if subject_prefix is not None:
            subject = "%s %s" % (subject_prefix, subject)

        # Form the multipart email message.
        msg = email.mime.multipart.MIMEMultipart('alternative')
        msg['Subject'] = subject
        msg['From'] = from_address
        msg['To'] = address
        msg.attach(email.mime.text.MIMEText(utf8_html_report, 'html', 'utf-8'))

        # Send the report.
        if not dry_run:
            s = smtplib.SMTP(host)
            s.sendmail(from_address, [address],
                       msg.as_string())
            s.quit()
        else:
            out = sys.stdout
            out.write("From: %s\n" % msg['From'])
            out.write("To: %s\n" % msg['To'])
            out.write("Subject: %s\n" % msg['Subject'])
            out.write("=== html report\n")
            out.write(html_report + "\n")

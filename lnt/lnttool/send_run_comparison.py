import click
import logging
import sys
from .common import init_logger
from lnt.util import logger


@click.command("send-run-comparison")
@click.argument("instance_path", type=click.UNPROCESSED)
@click.argument("run_a_id")
@click.argument("run_b_id")
@click.option("--database", default="default", show_default=True,
              help="database to use")
@click.option("--testsuite", default="nts", show_default=True,
              help="testsuite to use")
@click.option("--host", default="localhost", show_default=True,
              help="email relay host to use")
@click.option("--from", "from_address", default=None, required=True,
              help="from email address")
@click.option("--to", "to_address", default=None, required=True,
              help="to email address")
@click.option("--subject-prefix", help="add a subject prefix")
@click.option("--dry-run", is_flag=True, help="don't actually send email")
def action_send_run_comparison(instance_path, run_a_id, run_b_id, database,
                               testsuite, host, from_address, to_address,
                               subject_prefix, dry_run):
    """send a run-vs-run comparison email"""
    import contextlib
    import email.mime.multipart
    import email.mime.text
    import lnt.server.instance
    import lnt.server.reporting.runs
    import lnt.server.ui.app
    import smtplib

    init_logger(logging.ERROR)

    # Load the LNT instance.
    instance = lnt.server.instance.Instance.frompath(instance_path)
    config = instance.config

    # Get the database.
    with contextlib.closing(config.get_database(database)) as db:
        session = db.make_session()

        # Get the testsuite.
        ts = db.testsuite[testsuite]

        # Lookup the two runs.
        run_a_id = int(run_a_id)
        run_b_id = int(run_b_id)
        run_a = session.query(ts.Run).\
            filter_by(id=run_a_id).first()
        run_b = session.query(ts.Run).\
            filter_by(id=run_b_id).first()
        if run_a is None:
            logger.error("invalid run ID %r (not in database)" % (run_a_id,))
        if run_b is None:
            logger.error("invalid run ID %r (not in database)" % (run_b_id,))

        # Generate the report.
        data = lnt.server.reporting.runs.generate_run_data(
            session, run_b, baseurl=config.zorgURL, result=None,
            compare_to=run_a, baseline=None, aggregation_fn=min)

        env = lnt.server.ui.app.create_jinja_environment()
        text_template = env.get_template('reporting/run_report.txt')
        text_report = text_template.render(data)
        utf8_text_report = text_report.encode('utf-8')
        html_template = env.get_template('reporting/run_report.html')
        html_report = html_template.render(data)
        utf8_html_report = html_report.encode('utf-8')

        subject = data['subject']
        if subject_prefix is not None:
            subject = "%s %s" % (subject_prefix, subject)

        # Form the multipart email message.
        msg = email.mime.multipart.MIMEMultipart('alternative')
        msg['Subject'] = subject
        msg['From'] = from_address
        msg['To'] = to_address
        msg.attach(email.mime.text.MIMEText(utf8_text_report, 'plain', 'utf-8'))
        msg.attach(email.mime.text.MIMEText(utf8_html_report, 'html', 'utf-8'))

        # Send the report.
        if not dry_run:
            mail_client = smtplib.SMTP(host)
            mail_client.sendmail(
                from_address,
                [to_address],
                msg.as_string())
            mail_client.quit()
        else:
            out = sys.stdout
            out.write("From: %s\n" % from_address)
            out.write("To: %s\n" % to_address)
            out.write("Subject: %s\n" % subject)
            out.write("=== text/plain report\n")
            out.write(text_report + "\n")
            out.write("=== html report\n")
            out.write(html_report + "\n")

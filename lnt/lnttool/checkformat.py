import click
import sys


@click.command("checkformat")
@click.argument("files", nargs=-1, type=click.Path(exists=True))
@click.option("--testsuite", "-s", default='nts')
def action_checkformat(files, testsuite):
    """check the format of LNT test report files"""
    import lnt.server.config
    import lnt.server.db.v4db
    import lnt.util.ImportData
    db = lnt.server.db.v4db.V4DB('sqlite:///:memory:',
                                 lnt.server.config.Config.dummy_instance())
    session = db.make_session()
    for file in files:
        result = lnt.util.ImportData.import_and_report(
            None, None, db, session, file, '<auto>', testsuite)
        lnt.util.ImportData.print_report_result(result, sys.stdout,
                                                sys.stderr, verbose=True)

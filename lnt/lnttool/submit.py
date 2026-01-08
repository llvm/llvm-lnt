import click
import sys
import logging
from .common import init_logger, submit_options
from lnt.server.db.rules_manager import register_hooks


def _print_result_url(results, verbose):
    result_url = results.get('result_url')
    if result_url is not None:
        if verbose:
            print("Results available at:", result_url)
        else:
            print(result_url)
    elif verbose:
        print("Results available at: no URL available")


@click.command("submit")
@click.argument("url")
@click.argument("files", nargs=-1, type=click.Path(exists=True), required=True)
@submit_options
@click.option("--verbose", "-v", is_flag=True,
              help="show verbose test results")
@click.option("--testsuite", "-s", default='nts', show_default=True,
              help="testsuite to use in case the url is a file path")
@click.option("--ignore-regressions", is_flag=True,
              help="disable regression tracking")
def action_submit(url, files, select_machine, merge, verbose, testsuite,
                  ignore_regressions):
    """submit a test report to the server"""
    from lnt.util import ServerUtil
    import lnt.util.ImportData

    if '://' not in url:
        init_logger(logging.DEBUG)
        register_hooks()

    results = ServerUtil.submitFiles(url, files, verbose,
                                     select_machine=select_machine,
                                     merge_run=merge, testsuite=testsuite,
                                     ignore_regressions=ignore_regressions)
    for submitted_file in results:
        if verbose:
            lnt.util.ImportData.print_report_result(
                submitted_file, sys.stdout, sys.stderr, True)
        _print_result_url(submitted_file, verbose)
    if len(files) != len(results):
        sys.exit(1)

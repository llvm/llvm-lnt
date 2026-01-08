"""Implement the command line 'lnt' tool."""
import click

from .admin import group_admin
from .check_no_errors import action_check_no_errors
from .checkformat import action_checkformat
from .convert import action_convert
from .create import action_create
from .import_data import action_import
from .import_report import action_importreport
from .profile import action_profile
from .runserver import action_runserver
from .runtest import group_runtest
from .send_daily_report import action_send_daily_report
from .send_run_comparison import action_send_run_comparison
from .showtests import action_showtests
from .submit import action_submit
from .updatedb import action_updatedb
from .viewcomparison import action_view_comparison


def show_version(ctx, param, value):
    """print the LNT version"""
    if not value or ctx.resilient_parsing:
        return
    import importlib.metadata
    version = importlib.metadata.version('llvm-lnt')
    print(f"LNT {version}")
    ctx.exit()


@click.group(invoke_without_command=True, no_args_is_help=True)
@click.option('--version', is_flag=True, callback=show_version,
              expose_value=False, is_eager=True, help=show_version.__doc__)
def main():
    """LNT command line tool

\b
Use ``lnt <command> --help`` for more information on a specific command.
    """
    pass


main.add_command(action_check_no_errors)
main.add_command(action_checkformat)
main.add_command(action_convert)
main.add_command(action_create)
main.add_command(action_import)
main.add_command(action_importreport)
main.add_command(action_profile)
main.add_command(action_runserver)
main.add_command(action_send_daily_report)
main.add_command(action_send_run_comparison)
main.add_command(action_showtests)
main.add_command(action_submit)
main.add_command(action_updatedb)
main.add_command(action_view_comparison)
main.add_command(group_admin)
main.add_command(group_runtest)

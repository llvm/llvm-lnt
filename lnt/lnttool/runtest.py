import click
import logging
from .common import init_logger


class RunTestCLI(click.Group):
    def list_commands(self, ctx):
        import lnt.tests
        return lnt.tests.get_names()

    def get_command(self, ctx, name):
        import lnt.tests
        try:
            return lnt.tests.get_module(name).cli_action
        except KeyError:
            return None


@click.group("runtest", cls=RunTestCLI, context_settings=dict(
    ignore_unknown_options=True, allow_extra_args=True,))
def group_runtest():
    """run a builtin test application"""
    init_logger(logging.INFO)

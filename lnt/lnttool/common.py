from lnt.util import logger
import click
import logging


def submit_options(func):
    func = click.option("--commit", type=int, help="deprecated/ignored option",
                        expose_value=False)(func)
    func = click.option("--update-machine", is_flag=True,
                        help="Update machine fields")(func)
    func = click.option("--merge", default="replace", show_default=True,
                        type=click.Choice(['reject', 'replace', 'append']),
                        help="Merge strategy when run already exists")(func)
    return func


def init_logger(loglevel, show_sql=False, stream=None):
    handler = logging.StreamHandler(stream)
    handler.setLevel(loglevel)
    handler.setFormatter(logging.Formatter(
        '%(asctime)s %(levelname)s: %(message)s', datefmt='%Y-%m-%d %H:%M:%S'))
    logger.addHandler(handler)
    logger.setLevel(loglevel)

    # Enable full SQL logging, if requested.
    if show_sql:
        sa_logger = logging.getLogger("sqlalchemy")
        sa_logger.setLevel(loglevel)
        sa_logger.addHandler(handler)

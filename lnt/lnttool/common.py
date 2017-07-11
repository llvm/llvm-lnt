from lnt.util import logger
import logging


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

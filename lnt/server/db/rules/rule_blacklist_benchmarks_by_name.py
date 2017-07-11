"""Given a set of filed changes - figure out if we really care.

This can be used to implement server side black lists.

"""
import re
import os
import sys
from lnt.util import logger
from flask import current_app

ignored = None


# Try and find the blacklist.
def _populate_blacklist():
    global ignored
    ignored = []
    try:
        path = current_app.old_config.blacklist
    except RuntimeError:
        path = os.path.join(os.path.dirname(sys.argv[0]), "blacklist")
    
    if path and os.path.isfile(path):
        logger.info("Loading blacklist file: {}".format(path))
        with open(path, 'r') as f:
            for l in f.readlines():
                ignored.append(re.compile(l.strip()))
    else:
        logger.warning("Ignoring blacklist file: {}".format(path))


def filter_by_benchmark_name(ts, field_change):
    """Is this a fieldchanges we care about?
    """
    if ignored is None:
        _populate_blacklist()
    benchmark_name = field_change.test.name
    ts_name = ts.name
    full_name = '.'.join([ts_name,
                          field_change.machine.name,
                          benchmark_name,
                          field_change.field.name])
    logger.info(full_name)
    for regex in ignored:
        if regex.match(full_name):
            logger.info("Dropping field change {} because it matches {}"
                        .format(full_name, regex.pattern))
            return False
    return True
    
is_useful_change = filter_by_benchmark_name

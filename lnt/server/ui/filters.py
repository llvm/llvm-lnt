import StringIO
import datetime
import pprint
import urllib
import time

from lnt.server.ui import util

def filter_asutctime(time):
    ts = datetime.datetime.utcfromtimestamp(time)
    return ts.strftime('%Y-%m-%d %H:%M:%S UTC')

def filter_asisotime(time):
    ts = datetime.datetime.utcfromtimestamp(time)
    return ts.isoformat()


def filter_aspctcell(value, class_=None, style=None, attributes=None, *args, **kwargs):
    cell = util.PctCell(value, *args, **kwargs)
    return cell.render(class_, style, attributes)

def filter_pprint(value):
    stream = StringIO.StringIO()
    pprint.pprint(value, stream)
    return stream.getvalue()

def filter_format_or_default(fmt, input, default):
    if input:
        return fmt % input
    else:
        return default

def filter_urlencode(args):
    return urllib.urlencode(args)

def filter_timedelta(start_time):
    return "%.2fs" % (time.time() - start_time)

def register(env):
    for name,object in globals().items():
        if name.startswith('filter_'):
            env.filters[name[7:]] = object

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


def filter_aspctcell(value, class_=None, style=None, attributes=None, *args,
                     **kwargs):
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


def filter_producerAsHTML(producer):
    if not producer:
        return ""
    return util.renderProducerAsHTML(producer)


def filter_shortname(test_name):
    return util.guess_test_short_name(test_name)


def filter_filesize(value):
    for unit in ['', 'K', 'M', 'G', 'T', 'P', 'E', 'Z']:
        if abs(value) < 1024.0:
            return "%3.2f %sB" % (value, unit)
        value /= 1024.0
    return "%.2f%sB" % (value, 'Yi')


def filter_print_value(value, field_unit, field_unit_abbrev, default = '-'):
    if value is None:
        return default

    if field_unit == 'bytes' and field_unit_abbrev == 'B':
        return filter_filesize(value)
    else:
        return '%.3f' % value


def register(env):
    for name, object in globals().items():
        if name.startswith('filter_'):
            env.filters[name[7:]] = object

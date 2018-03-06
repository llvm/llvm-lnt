import colorsys
import math
import re
from lnt.server.reporting.analysis import REGRESSED

from flask import g


def toColorString(col):
    r, g, b = [clamp(int(v * 255), 0, 255)
               for v in col]
    return "#%02x%02x%02x" % (r, g, b)


def safediv(a, b, default=None):
    try:
        return a / b
    except ZeroDivisionError:
        return default


def makeDarkerColor(h):
    return makeDarkColor(h, 0.50)


def makeDarkColor(h, v=0.8):
    h = h % 1.
    s = 0.95
    return colorsys.hsv_to_rgb(h, 0.9 + s * .1, v)


def makeMediumColor(h):
    h = h % 1.
    s = .68
    v = 0.92
    return colorsys.hsv_to_rgb(h, s, v)


def makeLightColor(h):
    h = h % 1.
    s = (0.5, 0.4)[h > 0.5 and h < 0.8]
    v = 1.0
    return colorsys.hsv_to_rgb(h, s, v)


def makeBetterColor(h):
    h = math.cos(h * math.pi * .5)
    s = .8 + ((math.cos(h * math.pi * .5) + 1) * .5) * .2
    v = .88
    return colorsys.hsv_to_rgb(h, s, v)


def any_true(list, predicate):
    for i in list:
        if predicate(i):
            return True
    return False


def any_false(list, predicate):
    return any_true(list, lambda x: not predicate(x))


def all_true(list, predicate):
    return not any_false(list, predicate)


def all_false(list, predicate):
    return not any_true(list, predicate)


def mean(values):
    return sum(values) / len(values)


def median(values):
    values = list(values)
    values.sort()
    N = len(values)
    return (values[(N - 1) // 2] +
            values[(N + 0) // 2]) * .5


def prependLines(prependStr, str):
    return ('\n' + prependStr).join(str.splitlines())


def pprint(object, useRepr=True):
    def recur(ob):
        return pprint(ob, useRepr)

    def wrapString(prefix, string, suffix):
        return '%s%s%s' % (prefix,
                           prependLines(' ' * len(prefix),
                                        string),
                           suffix)

    def pprintArgs(name, args):
        return wrapString(name + '(', ',\n'.join(map(recur, args)), ')')

    if isinstance(object, tuple):
        return wrapString('(', ',\n'.join(map(recur, object)),
                          [')', ',)'][len(object) == 1])
    elif isinstance(object, list):
        return wrapString('[', ',\n'.join(map(recur, object)), ']')
    elif isinstance(object, set):
        return pprintArgs('set', list(object))
    elif isinstance(object, dict):
        elts = []
        for k, v in object.items():
            kr = recur(k)
            vr = recur(v)
            elts.append('%s : %s' % (kr,
                                     prependLines(
                                         ' ' * (3 + len(kr.splitlines()[-1])),
                                         vr)))
        return wrapString('{', ',\n'.join(elts), '}')
    else:
        if useRepr:
            return repr(object)
        return str(object)


def prefixAndPPrint(prefix, object, useRepr=True):
    return prefix + prependLines(' ' * len(prefix), pprint(object, useRepr))


def clamp(v, minVal, maxVal):
    return min(max(v, minVal), maxVal)


def lerp(a, b, t):
    t_ = 1. - t
    return tuple([av * t_ + bv * t for av, bv in zip(a, b)])


class PctCell:
    # Color levels
    kNeutralColor = (1, 1, 1)
    kNegativeColor = (0, 1, 0)
    kPositiveColor = (1, 0, 0)
    # Invalid color
    kNANColor = (.86, .86, .86)
    kInvalidColor = (0, 0, 1)

    def __init__(self, value, reverse=False, precision=2, delta=False,
                 data=None):
        if delta and isinstance(value, float):
            value -= 1
        self.value = value
        self.reverse = reverse
        self.precision = precision
        self.data = data

    def getColor(self):
        v = self.value

        # NaN is the unique floating point number x with the property
        # that x != x. We use this to detect actual NaNs and handle
        # them appropriately.
        if not isinstance(v, float) or v != v:
            return self.kNANColor

        # Clamp value.
        v = clamp(v, -1, 1)

        if self.reverse:
            v = -v
        if v < 0:
            c = self.kNegativeColor
        else:
            c = self.kPositiveColor
        t = abs(v)

        # Smooth mapping to put first 20% of change into 50% of range, although
        # really we should compensate for luma.
        t = math.sin((t ** .477) * math.pi * .5)
        return lerp(self.kNeutralColor, c, t)

    def getValue(self):
        if self.value is None:
            return ""
        if not isinstance(self.value, float):
            return self.value
        return '%.*f%%' % (self.precision, self.value * 100)

    def getColorString(self):
        return toColorString(self.getColor())

    def render(self, class_=None, style=None, attributes=None):
        bgcolor = 'background-color:%s' % (self.getColorString(),)
        style = bgcolor if style is None else style + "; " + bgcolor

        attrs = []
        if style is not None:
            attrs.append('style="%s"' % (style,))
        if class_ is not None:
            attrs.append('class="%s"' % (class_,))
        if attributes is not None:
            for key, value in attributes.items():
                attrs.append('%s="%s"' % (key, value))
        attr_string = ' '.join(attrs)
        if self.data:
            return '<td %s>%s (%s)</td>' % \
                (attr_string, self.data, self.getValue())
        else:
            return '<td %s>%s</td>' % (attr_string, self.getValue())


def sorted(values, *args, **kwargs):
    values = list(values)
    values.sort(*args, **kwargs)
    return values


def renderProducerAsHTML(producer):
    # If the string looks like a buildbot link, render it prettily.
    m = re.match(r'(https?)://(.*)/builders/(.*)/builds/(\d+)', producer)
    if m:
        protocol = m.group(1)
        url = m.group(2)
        builder = m.group(3)
        build = m.group(4)

        png_url = \
            '%(protocol)s://%(url)s/png?builder=%(builder)s&amp;' \
            'number=%(build)s' % locals()
        img = '<img src="%(png_url)s" />' % locals()
        return '<a href="%(producer)s">%(builder)s #%(build)s %(img)s</a>' % \
            locals()

    elif re.search(r'^https?://.+', producer):
        return '<a href="' + producer + '">Producer</a>'

    else:
        return producer


FLASH_DANGER = "alert alert-danger"
FLASH_INFO = "alert alert-info"
FLASH_SUCCESS = "alert alert-success"
FLASH_WARNING = "alert alert-warning"


def guess_test_short_name(test_name):
    """In some places the fully qualified test name is too long,
    try to make a shorter one.
    """
    split_name = test_name.split("/")
    last_path_name = split_name[-1]

    # LNT Compile tests are stragely named:
    # compile/TestName/phase/(opt level)
    if last_path_name.startswith("("):
        return split_name[-3]
    else:
        return last_path_name


def baseline_key(ts_name=None):
    """A unique name for baseline session keys per DB and suite.

    Optionally, get the test-suite name from a parameter, when this is called
    during submission the global context does not know which test-suite we are
    in until too late.
    """
    if ts_name:
        name = ts_name
    else:
        name = g.db_name
    return "baseline-{}-{}".format(name, g.db_name)


integral_rex = re.compile(r"[\d]+")


def convert_revision(dotted, cache=None):
    """Turn a version number like 489.2.10 into something
    that is ordered and sortable.
    "1" -> (1)
    "1.2.3" -> (1,2,3)

    :param dotted: the string revision to convert
    :param cache: a dict to use as a cache or None for no cache.
        because this is called many times, it is a nice performance
        increase to cache these conversions.
    :return: a tuple with the numeric bits of this revision as ints.

    """
    if cache is not None:
        val = cache.get(dotted)
        if val:
            return val
        else:
            dotted_parsed = integral_rex.findall(dotted)
            val = tuple([int(d) for d in dotted_parsed])
            cache[dotted] = val
            return val
    dotted_parsed = integral_rex.findall(dotted)
    val = tuple([int(d) for d in dotted_parsed])
    return val


class PrecomputedCR():
    """Make a thing that looks like a comprison result, that is derived
    from a field change."""
    previous = 0
    current = 0
    pct_delta = 0.00
    bigger_is_better = False

    def __init__(self, old, new, bigger_is_better):
        self.previous = old
        self.current = new
        self.delta = new - old
        self.pct_delta = self.delta / old

    def get_test_status(self):
        return True

    def get_value_status(self, ignore_small=True):
        return REGRESSED

    def __json__(self):
        return self.__dict__

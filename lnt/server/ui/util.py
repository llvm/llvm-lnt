import colorsys
import math
import re

from flask import g


def toColorString(col):
    r, g, b = [clamp(int(v * 255), 0, 255)
               for v in col]
    return "#%02x%02x%02x" % (r, g, b)


def detectCPUs():
    """
    Detects the number of CPUs on a system. Cribbed from pp.
    """
    import os
    # Linux, Unix and MacOS:
    if hasattr(os, "sysconf"):
        if os.sysconf_names.has_key("SC_NPROCESSORS_ONLN"):
            # Linux & Unix:
            ncpus = os.sysconf("SC_NPROCESSORS_ONLN")
            if isinstance(ncpus, int) and ncpus > 0:
                return ncpus
        else:  # OSX:
            return int(os.popen2("sysctl -n hw.ncpu")[1].read())
    # Windows:
    if os.environ.has_key("NUMBER_OF_PROCESSORS"):
        ncpus = int(os.environ["NUMBER_OF_PROCESSORS"]);
        if ncpus > 0:
            return ncpus
        return 1  # Default


def pairs(list):
    return zip(list[:-1], list[1:])


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


# The hash color palette avoids green and red as these colours are already used
# in quite a few places to indicate "good" or "bad".
hash_color_palette = (
    colorsys.hsv_to_rgb(h=45. / 360, s=0.3, v=0.9999),  # warm yellow
    colorsys.hsv_to_rgb(h=210. / 360, s=0.3, v=0.9999),  # blue cyan
    colorsys.hsv_to_rgb(h=300. / 360, s=0.3, v=0.9999),  # mid magenta
    colorsys.hsv_to_rgb(h=150. / 360, s=0.3, v=0.9999),  # green cyan
    colorsys.hsv_to_rgb(h=225. / 360, s=0.3, v=0.9999),  # cool blue
    colorsys.hsv_to_rgb(h=180. / 360, s=0.3, v=0.9999),  # mid cyan
)


def get_rgb_colors_for_hashes(hash_strings):
    hash2color = {}
    unique_hash_counter = 0
    for hash_string in hash_strings:
        if hash_string is not None:
            if hash_string in hash2color:
                continue
            hash2color[hash_string] = hash_color_palette[unique_hash_counter]
            unique_hash_counter += 1
            if unique_hash_counter >= len(hash_color_palette):
                break
    result = []
    for hash_string in hash_strings:
        if hash_string is None:
            result.append(None)
        else:
            # If not one of the first N hashes, return rgb value 0,0,0 which is
            # white.
            rgb = hash2color.get(hash_string, (0.999, 0.999, 0.999))
            result.append(toColorString(rgb))
    return result


class multidict:
    def __init__(self, elts=()):
        self.data = {}
        for key, value in elts:
            self[key] = value

    def __contains__(self, item):
        return item in self.data

    def __getitem__(self, item):
        return self.data[item]

    def __setitem__(self, key, value):
        if key in self.data:
            self.data[key].append(value)
        else:
            self.data[key] = [value]

    def items(self):
        return self.data.items()

    def values(self):
        return self.data.values()

    def keys(self):
        return self.data.keys()

    def __len__(self):
        return len(self.data)

    def get(self, key, default=None):
        return self.data.get(key, default)


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


def geometric_mean(l):
    iPow = 1. / len(l)
    return reduce(lambda a, b: a * b, [v ** iPow for v in l])


def mean(l):
    return sum(l) / len(l)


def median(l):
    l = list(l)
    l.sort()
    N = len(l)
    return (l[(N - 1) // 2] +
            l[(N + 0) // 2]) * .5


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
            return '<td %s>%s (%s)</td>' % (
            attr_string, self.data, self.getValue())
        else:
            return '<td %s>%s</td>' % (attr_string, self.getValue())


def sorted(l, *args, **kwargs):
    l = list(l)
    l.sort(*args, **kwargs)
    return l


def renderProducerAsHTML(producer):
    # If the string looks like a buildbot link, render it prettily.
    m = re.match(r'http://(.*)/builders/(.*)/builds/(\d+)', producer)
    if m:
        url = m.group(1)
        builder = m.group(2)
        build = m.group(3)

        png_url = 'http://%(url)s/png?builder=%(builder)s&number=%(build)s' % locals()
        img = '<img src="%(png_url)s">' % locals()
        return '<a href="%(producer)s">%(builder)s #%(build)s %(img)s</a>' % locals()

    elif producer.startswith('http://'):
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
    
    Optionally, get the test-suite name from a parameter, when this is called during
    submission the global context does not know which test-suite we are in until too late.
    """
    if ts_name:
        name = ts_name
    else:
        name = g.db_name
    return "baseline-{}-{}".format(name, g.db_name)


integral_rex = re.compile(r"[\d]+")


def convert_revision(dotted):
    """Turn a version number like 489.2.10 into something
    that is ordered and sortable.
    For now 489.2.10 will be returned as a tuple of ints.
    """
    dotted = integral_rex.findall(dotted)
    return tuple([int(d) for d in dotted])


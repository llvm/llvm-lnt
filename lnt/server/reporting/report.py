"""
Common functions and classes that are used by reports.
"""

import colorsys

from collections import namedtuple

OrderAndHistory = namedtuple('OrderAndHistory', ['max_order', 'recent_orders'])


def pairs(lst):
    """Make an iterable of all pairs of consecutive elements in lst."""
    return zip(lst[:-1], lst[1:])


# The hash color palette avoids green and red as these colours are already used
# in quite a few places to indicate "good" or "bad".
_hash_color_palette = (
    colorsys.hsv_to_rgb(h=45. / 360, s=0.3, v=0.9999),  # warm yellow
    colorsys.hsv_to_rgb(h=210. / 360, s=0.3, v=0.9999),  # blue cyan
    colorsys.hsv_to_rgb(h=300. / 360, s=0.3, v=0.9999),  # mid magenta
    colorsys.hsv_to_rgb(h=150. / 360, s=0.3, v=0.9999),  # green cyan
    colorsys.hsv_to_rgb(h=225. / 360, s=0.3, v=0.9999),  # cool blue
    colorsys.hsv_to_rgb(h=180. / 360, s=0.3, v=0.9999),  # mid cyan
)


def _clamp(v, minVal, maxVal):
    return min(max(v, minVal), maxVal)


def _toColorString(col):
    r, g, b = [_clamp(int(v * 255), 0, 255)
               for v in col]
    return "#%02x%02x%02x" % (r, g, b)


def _get_rgb_colors_for_hashes(hash_strings):
    hash2color = {}
    unique_hash_counter = 0
    for hash_string in hash_strings:
        if hash_string is not None:
            if hash_string in hash2color:
                continue
            hash2color[hash_string] = _hash_color_palette[unique_hash_counter]
            unique_hash_counter += 1
            if unique_hash_counter >= len(_hash_color_palette):
                break
    result = []
    for hash_string in hash_strings:
        if hash_string is None:
            result.append(None)
        else:
            # If not one of the first N hashes, return rgb value 0,0,0 which is
            # white.
            rgb = hash2color.get(hash_string, (0.999, 0.999, 0.999))
            result.append(_toColorString(rgb))
    return result


# Helper classes to make the sparkline chart construction easier in the jinja
# template.
class RunResult:
    def __init__(self, comparisonResult):
        self.cr = comparisonResult
        self.hash = self.cr.cur_hash
        self.samples = self.cr.samples
        if self.samples is None:
            self.samples = []


class RunResults:
    """
    RunResults contains pre-processed data to easily construct the HTML for
    a single row in the results table, showing how one test on one board
    evolved over a number of runs.
    """
    def __init__(self):
        self.results = []
        self._complete = False
        self.min_sample = None
        self.max_sample = None

    def __getitem__(self, i):
        return self.results[i]

    def __len__(self):
        return len(self.results)

    def append(self, day_result):
        assert not self._complete
        self.results.append(day_result)

    def complete(self):
        """
        complete() needs to be called after all appends to this object, but
        before the data is used the jinja template.
        """
        self._complete = True
        all_samples = []
        for dr in self.results:
            if dr is None:
                continue
            if dr.cr.samples is not None and not dr.cr.failed:
                all_samples.extend(dr.cr.samples)
        if len(all_samples) > 0:
            self.min_sample = min(all_samples)
            self.max_sample = max(all_samples)
        hashes = []
        for dr in self.results:
            if dr is None:
                hashes.append(None)
            else:
                hashes.append(dr.hash)
        rgb_colors = _get_rgb_colors_for_hashes(hashes)
        for i, dr in enumerate(self.results):
            if dr is not None:
                dr.hash_rgb_color = rgb_colors[i]


# Compute static CSS styles for elements. We use the style directly on
# elements instead of via a stylesheet to support major email clients
# (like Gmail) which can't deal with embedded style sheets.
# These are derived from the static style.css file we use elsewhere.

report_css_styles = {
    "body": ("color:#000000; background-color:#ffffff; "
             "font-family: Helvetica, sans-serif; font-size:9pt"),
    "table": ("font-size:9pt; border-spacing: 0px; "
              "border: 1px solid black"),
    "th": (
        "background-color:#eee; color:#666666; font-weight: bold; "
        "cursor: default; text-align:center; font-weight: bold; "
        "font-family: Verdana; padding:5px; padding-left:8px"),
    "td": "padding:5px; padding-left:8px",
    "right": "text-align: right;"
}

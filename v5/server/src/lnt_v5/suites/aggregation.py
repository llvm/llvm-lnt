"""The two stages of a run's geomean (O9): a test's samples to one value, then the tests to their
geometric mean.

In a module of its own because both the per-suite DDL, which constrains the stored aggregation, and
the code computing and serving the geomeans need it, and neither should import the other.
"""

from __future__ import annotations

import math
import statistics
from collections.abc import Callable, Iterable, Sequence
from enum import StrEnum, auto


class SampleAggregation(StrEnum):
    """How a test's samples within one run are reduced to one value.

    The same names the API speaks and `{suite}.run_summary.sample_agg` stores.
    """

    MEDIAN = auto()
    MEAN = auto()
    MIN = auto()
    MAX = auto()

    def __call__(self, values: Sequence[float]) -> float:
        return _AGGREGATE[self](values)


def _mean(values: Sequence[float]) -> float:
    """The arithmetic mean, which D3 lets reach the top of the float range.

    `fmean` sums in floating point, so values near that top overflow it with an error although
    their mean is representable. `statistics.mean` sums exactly instead, and is only slower.
    """
    try:
        return statistics.fmean(values)
    except OverflowError:
        return float(statistics.mean(values))


def _median(values: Sequence[float]) -> float:
    """The middle value, or the mean of the middle two for an even number of values, as the
    client's median does. Not `statistics.median`, whose `(a + b) / 2` overflows to infinity."""
    ordered = sorted(values)
    middle = len(ordered) // 2
    if len(ordered) % 2:
        return ordered[middle]
    return _mean(ordered[middle - 1 : middle + 1])


_AGGREGATE: dict[SampleAggregation, Callable[[Sequence[float]], float]] = {
    SampleAggregation.MEDIAN: _median,
    SampleAggregation.MEAN: _mean,
    SampleAggregation.MIN: min,
    SampleAggregation.MAX: max,
}


def geomean(values: Iterable[float]) -> float | None:
    """The geometric mean of the positive values, or None if there are none (O9).

    Finite whenever the values are: it never exceeds the largest of them.
    """
    positive = [value for value in values if value > 0]
    if not positive:
        return None
    return math.exp(math.fsum(map(math.log, positive)) / len(positive))

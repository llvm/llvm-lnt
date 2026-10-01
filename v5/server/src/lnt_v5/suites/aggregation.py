"""The two stages of a run's geomean (D15): a test's samples to one value, then the tests to their
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

    The same names the API speaks and `{suite}.run_geomean.sample_agg` stores.
    """

    MEDIAN = auto()
    MEAN = auto()
    MIN = auto()
    MAX = auto()

    def __call__(self, values: Sequence[float]) -> float:
        return _AGGREGATE[self](values)


# `statistics.median` averages the two middle values of an even-sized sample, as the client's median
# does.
_AGGREGATE: dict[SampleAggregation, Callable[[Sequence[float]], float]] = {
    SampleAggregation.MEDIAN: statistics.median,
    SampleAggregation.MEAN: statistics.fmean,
    SampleAggregation.MIN: min,
    SampleAggregation.MAX: max,
}


def geomean(values: Iterable[float]) -> float | None:
    """The geometric mean of the positive values, or None if there are none (D15)."""
    positive = [value for value in values if value > 0]
    if not positive:
        return None
    return math.exp(math.fsum(map(math.log, positive)) / len(positive))

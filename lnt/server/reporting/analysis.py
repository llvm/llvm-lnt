"""
Utilities for helping with the analysis of data, for reporting purposes.
"""

from lnt.util import stats
from lnt.server.ui import util
from lnt.testing import PASS, FAIL, XFAIL

REGRESSED = 'REGRESSED'
IMPROVED = 'IMPROVED'
UNCHANGED_PASS = 'UNCHANGED_PASS'
UNCHANGED_FAIL = 'UNCHANGED_FAIL'

# The smallest measureable change we can detect in seconds.
MIN_VALUE_PRECISION = 0.0001


def calc_geomean(run_values):
    # NOTE Geometric mean applied only to positive values, so fix it by
    # adding MIN_VALUE to each value and substract it from the result.
    # Since we are only interested in the change of the central tendency,
    # this workaround is good enough.

    values = [v + MIN_VALUE_PRECISION for v in run_values if v is not None]

    if not values:
        return None

    return util.geometric_mean(values) - MIN_VALUE_PRECISION


class ComparisonResult:
    """A ComparisonResult is ultimatly responsible for determining if a test
    improves, regresses or does not change, given some new and old data."""

    def __init__(self, aggregation_fn,
                 cur_failed, prev_failed, samples, prev_samples,
                 confidence_lv=0.05, bigger_is_better=False):
        self.aggregation_fn = aggregation_fn
        if samples:
            self.current = aggregation_fn(samples)
        else:
            self.current = None
        if prev_samples:
            self.previous = aggregation_fn(prev_samples)
        else:
            self.previous = None

        # Compute the comparison status for the test value.
        if self.current and self.previous and self.previous != 0:
            self.delta = self.current - self.previous
            self.pct_delta = self.delta / self.previous
        else:
            self.delta = 0
            self.pct_delta = 0.0

        # If we have multiple values for this run, use that to estimate the
        # distribution.
        if samples and len(samples) > 1:
            self.stddev = stats.standard_deviation(samples)
            self.MAD = stats.median_absolute_deviation(samples)
        else:
            self.stddev = None
            self.MAD = None

        self.stddev_mean = None  # Only calculate this if needed.
        self.failed = cur_failed
        self.prev_failed = prev_failed
        self.samples = samples
        self.prev_samples = prev_samples

        self.confidence_lv = confidence_lv
        self.bigger_is_better = bigger_is_better

    @property
    def stddev_mean(self):
        """The mean around stddev for current sampples. Cached after first call.
        """
        if not self.stddev_mean:
            self.stddev_mean = stats.mean(self.samples)
        return self.stddev_mean

    def __repr__(self):
        """Print this ComparisonResult's constructor.

        Handy for generating test cases for comparisons doing odd things."""
        fmt = "{}(" + "{}, " * 7 + ")"
        return fmt.format(self.__class__.__name__,
                          self.aggregation_fn.__name__,
                          self.failed,
                          self.prev_failed,
                          self.samples,
                          self.prev_samples,
                          self.confidence_lv,
                          bool(self.bigger_is_better))

    def is_result_interesting(self):
        """is_result_interesting() -> bool

        Check whether the result is worth displaying, either because of a
        failure, a test status change or a performance change."""
        if self.get_test_status() != UNCHANGED_PASS:
            return True
        if self.get_value_status() in (REGRESSED, IMPROVED):
            return True
        return False

    def get_test_status(self):
        # Compute the comparison status for the test success.
        if self.failed:
            if self.prev_failed:
                return UNCHANGED_FAIL
            else:
                return REGRESSED
        else:
            if self.prev_failed:
                return IMPROVED
            else:
                return UNCHANGED_PASS

    def get_value_status(self, confidence_interval=2.576,
                         value_precision=MIN_VALUE_PRECISION, ignore_small=True):
        if self.current is None or self.previous is None:
            return None

        # Don't report value errors for tests which fail, or which just started
        # passing.
        #
        # FIXME: One bug here is that we risk losing performance data on tests
        # which flop to failure then back. What would be nice to do here is to
        # find the last value in a passing run, or to move to using proper keyed
        # reference runs.
        if self.failed:
            return UNCHANGED_FAIL
        elif self.prev_failed:
            return UNCHANGED_PASS 

        # Always ignore percentage changes below 1%, for now, we just don't have
        # enough time to investigate that level of stuff.
        if ignore_small and abs(self.pct_delta) < .01:
            return UNCHANGED_PASS

        # Always ignore changes with small deltas. There is no mathematical
        # basis for this, it should be obviated by appropriate statistical
        # checks, but practical evidence indicates what we currently have isn't
        # good enough (for reasons I do not yet understand).
        if ignore_small and abs(self.delta) < .01:
            return UNCHANGED_PASS

        # Ignore tests whose delta is too small relative to the precision we can
        # sample at; otherwise quantization means that we can't measure the
        # standard deviation with enough accuracy.
        if abs(self.delta) <= 2 * value_precision * confidence_interval:
            return UNCHANGED_PASS

        # Use Mann-Whitney U test to test null hypothesis that result is
        # unchanged.
        if len(self.samples) >= 4 and len(self.prev_samples) >= 4:
            same = stats.mannwhitneyu(self.samples, self.prev_samples,
                                      self.confidence_lv)
            if same:
                return UNCHANGED_PASS

        # If we have a comparison window, then measure using a symmetic
        # confidence interval.
        if self.stddev is not None:
            is_significant = abs(self.delta) > (self.stddev *
                                                confidence_interval)

            # If the delta is significant, return
            if is_significant:
                if self.delta < 0:
                    return REGRESSED if self.bigger_is_better else IMPROVED
                else:
                    return IMPROVED if self.bigger_is_better else REGRESSED
            else:
                return UNCHANGED_PASS

        # Otherwise, report any changes above 0.2%, which is a rough
        # approximation for the smallest change we expect "could" be measured
        # accurately.
        if not ignore_small or abs(self.pct_delta) >= .002:
            if self.pct_delta < 0:
                return REGRESSED if self.bigger_is_better else IMPROVED
            else:
                return IMPROVED if self.bigger_is_better else REGRESSED
        else:
            return UNCHANGED_PASS


class RunInfo(object):
    def __init__(self, testsuite, runs_to_load,
                 aggregation_fn=stats.safe_min, confidence_lv=.05):
        self.testsuite = testsuite
        self.aggregation_fn = aggregation_fn
        self.confidence_lv = confidence_lv

        self.sample_map = util.multidict()
        self.loaded_run_ids = set()

        self._load_samples_for_runs(runs_to_load)

    @property
    def test_ids(self):
        return set(key[1] for key in self.sample_map.keys())

    def get_sliding_runs(self, run, compare_run, num_comparison_runs=0):
        """
        Get num_comparison_runs most recent runs,
        This query is expensive.
        """
        runs = [run]
        runs_prev = self.testsuite.get_previous_runs_on_machine(run, num_comparison_runs)
        runs += runs_prev

        if compare_run is not None:
            compare_runs = [compare_run]
            comp_prev = self.testsuite.get_previous_runs_on_machine(compare_run, num_comparison_runs)
            compare_runs += comp_prev
        else:
            compare_runs = []

        return runs, compare_runs

    def get_run_comparison_result(self, run, compare_to, test_id, field):
        if compare_to is not None:
            compare_to = [compare_to]
        else:
            compare_to = []
        return self.get_comparison_result([run], compare_to, test_id, field)

    def get_comparison_result(self, runs, compare_runs, test_id, field):
        # Get the field which indicates the requested field's status.
        status_field = field.status_field

        # Load the sample data for the current and previous runs and the
        # comparison window.
        run_samples = []
        prev_samples = []
        for run in runs:
            samples = self.sample_map.get((run.id, test_id))
            if samples is not None:
                run_samples.extend(samples)
        for run in compare_runs:
            samples = self.sample_map.get((run.id, test_id))
            if samples is not None:
                prev_samples.extend(samples)

        # Determine whether this (test,pset) passed or failed in the current and
        # previous runs.
        #
        # FIXME: Support XFAILs and non-determinism (mixed fail and pass)
        # better.
        run_failed = prev_failed = False
        if status_field:
            for sample in run_samples:
                run_failed |= sample[status_field.index] == FAIL
            for sample in prev_samples:
                prev_failed |= sample[status_field.index] == FAIL

        # Get the current and previous values.
        run_values = [s[field.index] for s in run_samples
                      if s[field.index] is not None]
        prev_values = [s[field.index] for s in prev_samples
                       if s[field.index] is not None]
        
        r = ComparisonResult(self.aggregation_fn,
                             run_failed, prev_failed, run_values,
                             prev_values, self.confidence_lv,
                             bigger_is_better=field.bigger_is_better)
        return r

    def get_geomean_comparison_result(self, run, compare_to, field, tests):
        if tests:
            prev_values,run_values = zip(*[(cr.previous,cr.current) for _,_,cr in tests])
        else:
            prev_values,run_values = [], []

        return ComparisonResult(calc_geomean,
                                cur_failed=bool(run_values),
                                prev_failed=bool(prev_values),
                                samples=run_values,
                                prev_samples=prev_values,
                                confidence_lv=0,
                                bigger_is_better=field.bigger_is_better)

    def _load_samples_for_runs(self, run_ids):
        # Find the set of new runs to load.
        to_load = set(run_ids) - self.loaded_run_ids
        if not to_load:
            return

        # Batch load all of the samples for the needed runs.
        #
        # We speed things up considerably by loading the column data directly
        # here instead of requiring SA to materialize Sample objects.
        columns = [self.testsuite.Sample.run_id,
                   self.testsuite.Sample.test_id]
        columns.extend(f.column for f in self.testsuite.sample_fields)
        q = self.testsuite.query(*columns)
        q = q.filter(self.testsuite.Sample.run_id.in_(to_load))
        for data in q:
            run_id = data[0]
            test_id = data[1]
            sample_values = data[2:]
            self.sample_map[(run_id, test_id)] = sample_values

        self.loaded_run_ids |= to_load

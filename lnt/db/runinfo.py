REGRESSED = 'REGRESSED'
IMPROVED = 'IMPROVED'
UNCHANGED_PASS = 'UNCHANGED_PASS'
UNCHANGED_FAIL = 'UNCHANGED_FAIL'

class ComparisonResult:
    def __init__(self, cur_value, prev_value, delta, pct_delta, stddev, MAD,
                 cur_failed, prev_failed, samples, stddev_mean = None,
                 stddev_is_estimated = False):
        self.current = cur_value
        self.previous = prev_value
        self.delta = delta
        self.pct_delta = pct_delta
        self.stddev = stddev
        self.MAD = MAD
        self.failed = cur_failed
        self.prev_failed = prev_failed
        self.samples = samples
        self.stddev_mean = stddev_mean
        self.stddev_is_estimated = stddev_is_estimated

    def get_samples(self):
        return self.samples

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
                         value_precision=0.0001, ignore_small=True):
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

        # Ignore tests whose delt is too small relative to the precision we can
        # sample at; otherwise quantization means that we can't measure the
        # standard deviation with enough accuracy.
        if abs(self.delta) <= 2 * value_precision * confidence_interval:
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

        # If we have a comparison window, then measure using a symmetic
        # confidence interval.
        if self.stddev is not None:
            is_significant = abs(self.delta) > (self.stddev *
                                                confidence_interval)

            # If the stddev is estimated, then it is also only significant if
            # the delta from the estimate mean is above the confidence interval.
            if self.stddev_is_estimated:
                is_significant &= (abs(self.current - self.stddev_mean) >
                                   self.stddev * confidence_interval)

            # If the delta is significant, return 
            if is_significant:
                if self.delta < 0:
                    return IMPROVED
                else:
                    return REGRESSED
            else:
                return UNCHANGED_PASS

        # Otherwise, report any changes above 0.2%, which is a rough
        # approximation for the smallest change we expect "could" be measured
        # accurately.
        if abs(self.pct_delta) >= .002:
            if self.pct_delta < 0:
                return IMPROVED
            else:
                return REGRESSED
        else:
            return UNCHANGED_PASS

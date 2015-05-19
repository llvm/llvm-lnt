# Check that analysis produces correct results
#
# RUN: python %s
import unittest
import lnt.util.stats as stats
from lnt.server.reporting.analysis import ComparisonResult, REGRESSED, IMPROVED
from lnt.server.reporting.analysis import UNCHANGED_PASS


class ComparisonResultTest(unittest.TestCase):
    """Test the generation of differnt types of comparison results."""

    def test_comp(self):
        """Test a real example."""
        curr_samples = [0.0887, 0.0919, 0.0903]
        prev = 0.0858
        cur = min(curr_samples)
        stddev = stats.standard_deviation(curr_samples)
        MAD = stats.median_absolute_deviation(curr_samples)
        stddev_mean = stats.mean(curr_samples)
        uninteresting = ComparisonResult(cur, prev, cur-prev,
                                         (cur-prev)/prev, stddev, MAD,
                                         False, False, curr_samples, [prev],
                                         stddev_mean)

        self.assertFalse(uninteresting.is_result_interesting())
        self.assertEquals(uninteresting.get_test_status(), UNCHANGED_PASS)
        self.assertEquals(uninteresting.get_value_status(), UNCHANGED_PASS)

    def test_slower(self):
        """Test getting a simple regression."""
        slower = ComparisonResult(10, 5, 5, 0.5, None, None,
                                  False, False, [10], [5], None)
        self.assertEquals(slower.get_value_status(), REGRESSED)
        self.assertTrue(slower.is_result_interesting())

    def test_faster(self):
        """Test getting a simple improvement."""

        faster = ComparisonResult(5, 10, -5, -0.5, None, None,
                                  False, False, [5], [10], None)
        self.assertEquals(faster.get_value_status(), IMPROVED)
        self.assertTrue(faster.is_result_interesting())

    def test_improved_status(self):
        """Test getting a test status improvement."""
        improved = ComparisonResult(None, None, None, None, None, None,
                                    False, True, [5], [10], None)
        self.assertEquals(improved.get_test_status(), IMPROVED)

    def test_regressed_status(self):
        """Test getting a test status improvement."""
        improved = ComparisonResult(None, None, None, None, None, None,
                                    True, False, [5], [10], None)
        self.assertEquals(improved.get_test_status(), REGRESSED)


if __name__ == '__main__':
    unittest.main()

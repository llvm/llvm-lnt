# Check that analysis produces correct results
#
# RUN: python %s
import unittest
import lnt.util.stats as stats
from lnt.server.reporting.analysis import ComparisonResult, REGRESSED, IMPROVED
from lnt.server.reporting.analysis import UNCHANGED_PASS, UNCHANGED_FAIL


class ComparisonResultTest(unittest.TestCase):
    """Test the generation of differnt types of comparison results."""

    def test_comp(self):
        """Test a real example."""
        curr_samples = [0.0887, 0.0919, 0.0903]
        prev = [0.0858]
        uninteresting = ComparisonResult(min, False, False, curr_samples, prev)

        self.assertFalse(uninteresting.is_result_interesting())
        self.assertEquals(uninteresting.get_test_status(), UNCHANGED_PASS)
        self.assertEquals(uninteresting.get_value_status(), UNCHANGED_PASS)

    def test_slower(self):
        """Test getting a simple regression."""
        slower = ComparisonResult(min,
                                  False, False, [10], [5])
        self.assertEquals(slower.get_value_status(), REGRESSED)
        self.assertTrue(slower.is_result_interesting())

    def test_faster(self):
        """Test getting a simple improvement."""

        faster = ComparisonResult(min,
                                  False, False, [5], [10])
        self.assertEquals(faster.get_value_status(), IMPROVED)
        self.assertTrue(faster.is_result_interesting())

    def test_improved_status(self):
        """Test getting a test status improvement."""
        improved = ComparisonResult(min,
                                    False, True, [1], None)
        self.assertEquals(improved.get_test_status(), IMPROVED)

    def test_regressed_status(self):
        """Test getting a test status improvement."""
        improved = ComparisonResult(min,
                                    True, False, None, [10])
        self.assertEquals(improved.get_test_status(), REGRESSED)

    def test_keep_on_failing_status(self):
        """Test getting a repeated fail."""
        improved = ComparisonResult(min,
                                    True, True, None, None)
        self.assertEquals(improved.get_test_status(), UNCHANGED_FAIL)

if __name__ == '__main__':
    unittest.main()

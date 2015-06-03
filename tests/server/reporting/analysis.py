# Check that analysis produces correct results
#
# RUN: python %s
import unittest

from lnt.server.reporting.analysis import ComparisonResult, REGRESSED, IMPROVED
from lnt.server.reporting.analysis import UNCHANGED_PASS, UNCHANGED_FAIL
from lnt.server.reporting.analysis import absmin_diff

FLAT_LINE = [1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0,
             1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0]

FLAT_NOISE = [1.0129, 1.0131, 1.039, 1.0399, 1.0071, 1.0003, 1.023, 1.0386,
              1.0025, 1.0273, 1.0014, 1.0101, 1.0075, 1.007, 1.0207, 1.0274,
              1.0252, 1.0394, 1.0225, 1.0154, 1.0066, 1.0007, 1.0311, 1.0077]

BIG_NUMBERS_FLAT = [10.2177, 10.4559, 10.463, 10.1278, 10.0132, 10.3997, 10.256,
                    10.1849, 10.4397, 10.453, 10.1414, 10.4185, 10.0477, 10.3637,
                    10.2025, 10.0212, 10.4823, 10.1047, 10.2676, 10.2971, 10.2329,
                    10.0271, 10.0571, 10.4414]

FLAT_NOISE2 = [10.2177, 10.4559, 10.463, 10.1278, 10.0132, 10.3997, 10.256,
               10.1849, 10.4397, 10.453, 10.1414, 10.4185, 10.0477, 10.3637,
               10.2025, 10.0212, 10.4823, 10.1047, 10.2676, 10.2971, 10.2329,
               10.0271, 10.0571, 10.4414]

SIMPLE_REGRESSION = [1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 2.0, 2.0,
                     2.0, 2.0, 2.0, 2.0, 2.0, 2.0, 2.0, 2.0, 2.0, 2.0, 2.0, 2.0]

REGRESS_5 = [11.3978, 11.2272, 11.3756, 11.0, 11.1964, 11.0341, 11.1875,
             11.2624, 11.3429, 11.0012, 12.2821, 12.2141, 12.3077, 12.4856,
             12.3829, 12.4266, 12.3724, 12.3023, 12.0148, 12.1289, 12.2068,
             12.2897, 12.0671, 12.2238]

MS_5_REG = [11.3978, 11.2272, 11.3756, 11.0, 11.1964, 11.0341, 11.1875,
            11.2624, 11.3429, 11.0012, 12.2821, 12.2141, 12.3077, 12.4856,
            12.3829, 12.4266, 12.3724, 12.3023, 12.0148, 12.1289, 12.2068,
            12.2897, 12.0671, 12.2238]

IMP = [3.0, 3.0, 3.0, 3.0, 3.0, 3.0, 3.0, 3.0, 3.0, 3.0, 2.0, 2.0, 2.0,
       2.0, 2.0, 2.0, 2.0, 2.0, 2.0, 2.0, 2.0, 2.0, 2.0, 2.0]

IMP_NOISE = [13.2326, 13.1521, 13.0828, 13.4, 13.3142, 13.0989, 13.2671,
             13.1749, 13.3357, 13.0381, 12.3538, 12.1364, 12.0743, 12.4843,
             12.225, 12.261, 12.2779, 12.4818, 12.3725, 12.026, 12.2646,
             12.0656, 12.0327, 12.4735]

BIMODAL = [1.0, 2.0, 1.0, 2.0, 1.0, 2.0, 1.0, 2.0, 1.0, 2.0, 1.0, 2.0, 1.0,
           2.0, 1.0, 2.0, 1.0, 2.0, 1.0, 2.0, 1.0, 2.0, 1.0, 2.0]

BIMODAL_NOISE = [11.1597, 12.0476, 11.2654, 12.2211, 11.2945, 12.2029, 11.3946,
                 12.1823, 11.3261, 12.4447, 11.1011, 12.4827, 11.4645, 12.3512,
                 11.381, 12.1887, 11.0718, 12.4719, 11.0017, 12.4311, 11.3296,
                 12.0678, 11.0258, 12.3331]

BM_ALTERNATE = [1.0, 2.0, 2.0, 1.0, 1.0, 2.0, 2.0, 1.0, 1.0, 2.0, 2.0, 1.0, 1.0,
                2.0, 2.0, 1.0, 1.0, 2.0, 2.0, 1.0, 1.0, 2.0, 2.0, 1.0]

BM_AL_NOISE = [11.3276, 12.0247, 12.2933, 11.337, 11.0047, 12.2884, 12.4807,
               11.4142, 11.2305, 12.4549, 12.4898, 11.2168, 11.0961, 12.3487,
               12.395, 11.0562, 11.2327, 12.3907, 12.3533, 11.2095, 11.3616,
               12.2507, 12.295, 11.0373]

BM_AL_REG = [1.0, 2.0, 2.0, 1.0, 1.0, 2.0, 2.0, 1.0, 1.0, 2.0, 2.0, 3.0, 3.0,
             2.0, 2.0, 3.0, 3.0, 2.0, 2.0, 3.0, 3.0, 2.0, 2.0]

BM_REGRESSION = [1.0, 2.0, 1.0, 2.0, 1.0, 2.0, 1.0, 2.0, 1.0, 2.0, 1.0, 2.0, 3.0,
                 2.0, 3.0, 2.0, 3.0, 2.0, 3.0, 2.0, 3.0, 2.0, 3.0, 2.0]

BM_REGS_NOISE = [11.1433, 12.0805, 12.3661, 11.0146, 11.1983, 12.2693, 12.3474,
                 11.4173, 11.3068, 12.2658, 12.1376, 13.3669, 13.1601, 12.0867,
                 12.23, 13.3021, 13.263, 12.3641, 12.3352, 13.0674, 13.1938,
                 12.2187, 12.1801]

BM_REG_OVERLAP = [1.0, 2.0, 1.0, 2.0, 1.0, 2.0, 1.0, 2.0, 1.0, 2.0, 1.0, 2.0, 2.5,
                  1.5, 2.5, 1.5, 2.5, 1.5, 2.5, 1.5, 2.5, 1.5, 2.5, 1.5]

BM_REG_OVER_NOISE = [11.4327, 12.3285, 11.1276, 12.1334, 11.2259, 12.0603, 11.3169,
                     12.4749, 11.1805, 12.0481, 11.1331, 12.012, 12.8302, 11.5071,
                     12.6074, 11.6872, 12.9957, 11.5772, 12.8381, 11.8985, 12.7692,
                     11.6686, 12.6311, 11.8401]

SPIKE = [1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 15, 1.0,
         1.0, 1.0, 2.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0]

NOISE_SPIKE = [11.4116, 11.3406, 11.3591, 11.2415, 11.1551, 11.0909, 11.3657,
               11.0299, 25.0867, 11.2155, 11.1742, 11.487, 11.2852, 11.3026,
               11.1036, 12.2208, 11.0029, 11.4335, 11.4661, 11.0444, 11.0467,
               11.4942, 11.1692, 11.1597]

SLOW_REG = [1.0, 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9, 2.0, 2.1, 2.2,
            2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 2.9, 3.0, 3.1, 3.2, 3.3]

SLOW_REG_NOISE = [11.094, 11.1011, 11.5267, 11.5397, 11.6993, 11.7814, 11.6809,
                  12.06, 12.281, 12.0899, 12.3967, 12.5441, 12.6527, 12.5586,
                  12.8025, 12.9391, 13.0077, 12.7716, 13.0799, 13.324, 13.3028,
                  13.4567, 13.2734, 13.6797]

SLOW_IMP = [2.4, 2.3, 2.2, 2.1, 2.0, 1.9, 1.8, 1.7, 1.6, 1.5, 1.4, 1.3, 1.2,
            1.1, 1.0, 0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3, 0.2, 0.1]

SLOW_IMP_NOISE = [12.4592, 12.7874, 12.4891, 12.3433, 12.1183, 12.3755, 12.0194,
                  11.7551, 11.9412, 11.9822, 11.55, 11.3235, 11.6681, 11.5486,
                  11.2267, 11.0775, 11.1642, 10.8639, 10.8378, 10.8704, 10.5302,
                  10.5058, 10.5191, 10.2733]


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
        slower = ComparisonResult(min, False, False, [10], [5])
        self.assertEquals(slower.get_value_status(), REGRESSED)
        self.assertTrue(slower.is_result_interesting())

    def test_faster(self):
        """Test getting a simple improvement."""

        faster = ComparisonResult(min, False, False, [5], [10])
        self.assertEquals(faster.get_value_status(), IMPROVED)
        self.assertTrue(faster.is_result_interesting())

    def test_really_faster(self):
        """Test getting a simple improvement."""

        faster = ComparisonResult(min, False, False, [5, 6], [10, 10, 10])
        self.assertEquals(faster.get_value_status(), IMPROVED)
        self.assertTrue(faster.is_result_interesting())

    def test_improved_status(self):
        """Test getting a test status improvement."""
        improved = ComparisonResult(min, False, True, [1], None)
        self.assertEquals(improved.get_test_status(), IMPROVED)

    def test_regressed_status(self):
        """Test getting a test status improvement."""
        improved = ComparisonResult(min, True, False, None, [10])
        self.assertEquals(improved.get_test_status(), REGRESSED)

    def test_keep_on_failing_status(self):
        """Test getting a repeated fail."""
        improved = ComparisonResult(min, True, True, None, None)
        self.assertEquals(improved.get_test_status(), UNCHANGED_FAIL)

    def test_noticeable_regression(self):
        """Test a big looking jump."""
        regressed = ComparisonResult(min, False, False, [10.0, 10.1],
                                     [5.0, 5.1, 4.9, 5.0])
        self.assertEquals(regressed.get_value_status(), REGRESSED)

    def test_no_regression_flat_line(self):
        """This is a flat line, it should have no changes."""
        flat = ComparisonResult(min, False, False, [1.0], FLAT_LINE[0:10])
        self.assertEquals(flat.get_value_status(), UNCHANGED_PASS)

    def test_no_regression_flat_line_noise(self):
        """Now 4% noise."""
        flat = ComparisonResult(min, False, False, [1.020], FLAT_NOISE[0:10])
        ret = flat.get_value_status()
        # Fixme
        # self.assertEquals(ret, UNCHANGED_PASS)

    def test_big_no_regression_flat_line_noise(self):
        """Same data, but bigger 10 + 5% variation."""
        flat = ComparisonResult(min, False, False, [10.25], FLAT_NOISE2[0:10])
        ret = flat.get_value_status()
        # Fixme
        # self.assertEquals(ret, UNCHANGED_PASS)

    def test_big_no_regression_flat_line_multi(self):
        """Same data, but bigger 10 + 5% variation, multisample current."""
        flat = ComparisonResult(min, False, False, [10.0606, 10.4169, 10.1859],
                                BIG_NUMBERS_FLAT[0:10])
        ret = flat.get_value_status()
        # Fixme
        # self.assertEquals(ret, UNCHANGED_PASS)

    def test_simple_regression(self):
        """Flat line that jumps to another flat line."""
        flat = ComparisonResult(
            min, False, False, [SIMPLE_REGRESSION[10]], SIMPLE_REGRESSION[0:9])
        self.assertEquals(flat.get_value_status(), REGRESSED)

    def test_noisy_regression_5(self):
        """A regression in 5% noise."""
        flat = ComparisonResult(min, False, False, [12.2821], REGRESS_5[0:9])
        self.assertEquals(flat.get_value_status(), REGRESSED)

    def test_noisy_regression_5_multi(self):
        """A regression in 5% noise, more current samples."""
        flat = ComparisonResult(min, False, False, [12.2821, 12.2141, 12.3077],
                                MS_5_REG[0:9])
        ret = flat.get_value_status()
        self.assertEquals(ret, REGRESSED)

    def test_simple_improvement(self):
        """An improvement without noise."""
        flat = ComparisonResult(min, False, False, [IMP[10]], IMP[0:9])
        self.assertEquals(flat.get_value_status(), IMPROVED)

    def test_noise_improvement(self):
        """An improvement with 5% noise."""
        flat = ComparisonResult(min, False, False, [IMP_NOISE[10]],
                                IMP_NOISE[0:9])
        self.assertEquals(flat.get_value_status(), IMPROVED)

    def test_bimodal(self):
        """A bimodal line, with no regressions."""
        bimodal = ComparisonResult(min, False, False, [BIMODAL[10]],
                                   BIMODAL[0:9])
        # Fixme
        # self.assertEquals(bimodal.get_value_status(), UNCHANGED_PASS)

    def test_noise_bimodal(self):
        """Bimodal line with 5% noise."""
        bimodal = ComparisonResult(min, False, False, [BIMODAL_NOISE[10]],
                                   BIMODAL_NOISE[0:9])
        # Fixme
        # self.assertEquals(bimodal.get_value_status(), UNCHANGED_PASS)

    def test_bimodal_alternating(self):
        """Bimodal which sticks in a mode for a while."""
        bimodal = ComparisonResult(min, False, False, [BM_ALTERNATE[10]],
                                   BM_ALTERNATE[0:9])
        # Fixme
        # self.assertEquals(bimodal.get_value_status(), UNCHANGED_PASS)

    def test_noise_bimodal_alternating(self):
        """Bimodal alternating with 5% noise."""
        bimodal = ComparisonResult(min, False, False, [BM_AL_NOISE[10]],
                                   BM_AL_NOISE[0:9])
        # Fixme
        # self.assertEquals(bimodal.get_value_status(), UNCHANGED_PASS)

    def test_bimodal_alternating_regression(self):
        """Bimodal alternating regression."""
        bimodal = ComparisonResult(min, False, False, [BM_AL_REG[11]],
                                   BM_AL_REG[0:10])
        # Fixme
        # self.assertEquals(bimodal.get_value_status(), REGRESSED)

    def test_bimodal_regression(self):
        """A regression in a bimodal line."""
        bimodal = ComparisonResult(min, False, False, [BM_REGRESSION[12]],
                                   BM_REGRESSION[0:11])
        # Fixme
        # self.assertEquals(bimodal.get_value_status(), REGRESSED)

    def test_noise_bimodal_regression(self):
        bimodal = ComparisonResult(
            min, False, False, [BM_REGS_NOISE[12]], BM_REGS_NOISE[0:11])
        # Fixme
        # self.assertEquals(bimodal.get_value_status(), REGRESSED)

    def test_bimodal_overlapping_regression(self):
        bimodal = ComparisonResult(min, False, False, [BM_REG_OVERLAP[12]],
                                   BM_REG_OVERLAP[0:11])
        # Fixme
        # self.assertEquals(bimodal.get_value_status(), REGRESSED)

    def test_noise_bimodal_overlapping_regression(self):
        bimodal = ComparisonResult(
            min, False, False, [BM_REG_OVER_NOISE[12]],
            BM_REG_OVER_NOISE[0:11])
        # Fixme
        # self.assertEquals(bimodal.get_value_status(), REGRESSED)

    def test_single_spike(self):
        spike = ComparisonResult(min, False, False, [SPIKE[12]], SPIKE[0:11])
        self.assertEquals(spike.get_value_status(), UNCHANGED_PASS)

    def test_noise_single_spike(self):
        spike = ComparisonResult(min, False, False,
                                 [NOISE_SPIKE[12]], NOISE_SPIKE[0:11])
        # Fixme
        # self.assertEquals(spike.get_value_status(), UNCHANGED_PASS)

    def test_slow_regression(self):
        slow = ComparisonResult(min, False, False,
                                [SLOW_REG[12]], SLOW_REG[0:11])
        # Fixme
        # self.assertEquals(slow.get_value_status(), REGRESSED)

    def test_noise_slow_regression(self):
        slow = ComparisonResult(
            min, False, False, [SLOW_REG_NOISE[12]], SLOW_REG_NOISE[0:11])
        # Fixme
        # self.assertEquals(slow.get_value_status(), REGRESSED)

    def test_slow_improvement(self):
        slow = ComparisonResult(
            min, False, False, [SLOW_IMP[12]], SLOW_IMP[0:11])
        # Fixme
        # self.assertEquals(slow.get_value_status(), IMPROVED)

    def test_noise_slow_improvement(self):
        slow = ComparisonResult(
            min, False, False, [SLOW_IMP_NOISE[12]], SLOW_IMP_NOISE[0:11])
        # Fixme
        # self.assertEquals(slow.get_value_status(), IMPROVED)


class AbsMinTester(unittest.TestCase):

    def test_absmin(self):
        """Test finding smallest difference."""
        self.assertEqual(absmin_diff(1, [2, 2, 3]), (-1, 2))
        self.assertEqual(absmin_diff(1, [1, 2, 3]), (0, 1))
        self.assertEqual(absmin_diff(1, [2]), (-1, 2))
        self.assertEqual(absmin_diff(1.5, [1, 4, 4]), (0.5, 1))
        self.assertEqual(absmin_diff(5, [1, 2, 1]), (3, 2))
        self.assertEqual(absmin_diff(1, [2, 0, 3]), (1, 0))


if __name__ == '__main__':
    unittest.main()

#
# create temporary instance
# Cleanup temporary directory in case one remained from a previous run - also
# see PR9904.
# RUN: rm -rf %t.instance
# RUN: python %{shared_inputs}/create_temp_instance.py \
# RUN:   %s %{shared_inputs}/SmallInstance %t.instance \
# RUN:   %S/Inputs/V4Pages_extra_records.sql
#
# RUN: python %s %t.instance

import unittest

import lnt.util.stats as stats

INDEX = 0


class TestLNTStatsTester(unittest.TestCase):

    @staticmethod
    def _loc_test_agg_mean(values):
        if values is None:
            return stats.agg_mean(None)
        agg_value, agg_index = stats.agg_mean(
            (value, index) for (index, value) in enumerate(values))
        return agg_value, agg_index

    def test_agg_mean(self):
        test_list1 = [1, 2, 3, 4, 6]
        self.assertEqual(TestLNTStatsTester._loc_test_agg_mean(test_list1),
                         (3.2, INDEX))
        test_list2 = [1.0, 2.0, 3.0, 4.0]
        self.assertEqual(TestLNTStatsTester._loc_test_agg_mean(test_list2),
                         (2.5, INDEX))
        test_list3 = [1.0]
        self.assertEqual(TestLNTStatsTester._loc_test_agg_mean(test_list3),
                         (1.0, INDEX))
        self.assertEqual(TestLNTStatsTester._loc_test_agg_mean([]),
                         (None, None))
        self.assertEqual(TestLNTStatsTester._loc_test_agg_mean(None),
                         (None, None))

        # Test it exactly how it is called in views.py without indirection
        agg_value, agg_index = stats.agg_mean(
            (value, index) for (index, value) in enumerate(test_list1))
        self.assertEqual((3.2, INDEX), (agg_value, agg_index))
        agg_value, agg_index = stats.agg_mean(
            (value, index) for (index, value) in enumerate(test_list2))
        self.assertEqual((2.5, INDEX), (agg_value, agg_index))
        agg_value, agg_index = stats.agg_mean(
            (value, index) for (index, value) in enumerate(test_list3))
        self.assertEqual((1.0, INDEX), (agg_value, agg_index))


if __name__ == '__main__':
    try:
        unittest.main()
    except AttributeError:
        # Command line parameters are treated as test cases, when \
        # running with lit rather than python directly.
        import sys
        if len(sys.argv) != 2:
            sys.exit("Something went horribly wrong. You need parameters.")
        del sys.argv[1:]
        unittest.main()

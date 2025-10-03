# RUN: python %s

import unittest

import lnt.util.stats as stats


class TestLNTStatsTester(unittest.TestCase):
    def test_safe_min(self):
        self.assertEqual(stats.safe_min([]), None)
        self.assertEqual(stats.safe_min([1]), 1)
        self.assertEqual(stats.safe_min([1, 2, 3]), 1)
        self.assertEqual(stats.safe_min([3, 2, 1]), 1)
        self.assertEqual(stats.safe_min([1, 1, 1]), 1)

    def test_safe_max(self):
        self.assertEqual(stats.safe_max([]), None)
        self.assertEqual(stats.safe_max([1]), 1)
        self.assertEqual(stats.safe_max([1, 2, 3]), 3)
        self.assertEqual(stats.safe_max([3, 2, 1]), 3)
        self.assertEqual(stats.safe_max([1, 1, 1]), 1)

    def test_mean(self):
        self.assertEqual(stats.mean([]), None)
        self.assertEqual(stats.mean([1]), 1)
        self.assertEqual(stats.mean([1, 2, 3]), 2)
        self.assertEqual(stats.mean([3, 2, 1]), 2)
        self.assertEqual(stats.mean([1, 1, 1]), 1)

    def test_median(self):
        self.assertEqual(stats.median([]), None)
        self.assertEqual(stats.median([1]), 1)
        self.assertEqual(stats.median([1, 2, 3]), 2)
        self.assertEqual(stats.median([3, 2, 1]), 2)
        self.assertEqual(stats.median([1, 1, 1]), 1)


if __name__ == '__main__':
    unittest.main()

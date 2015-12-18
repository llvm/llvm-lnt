# Check the rule import and execution facility
# RUN: python %s
"""Test the rule import"""
import unittest
import logging
import sys

logging.basicConfig(level=logging.DEBUG)

import lnt.server.db.rules as rules

class RuleProcssingTests(unittest.TestCase):
    """Test the Rules facility."""

    def setUp(self):
        pass
        
    def test_rule_loading(self):
        """Can we load the testhook rule?"""
        found_rules = rules.load_rules()
        self.assertIn('testhook', found_rules)
    
    def test_hook_loading(self):
        """Can we load and execute the test hook?"""
        hooks = rules.register_hooks()
        self.assertTrue(len(hooks['post_test_hook']) == 1)
        ret = hooks['post_test_hook'][0]()
        self.assertEqual(ret, "Foo.")
        self.assertIn('testhook', rules.DESCRIPTIONS)

if __name__ == '__main__':
    unittest.main(argv=[sys.argv[0], ])

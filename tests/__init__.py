import os
import lit.discovery

def test_all():
    return lit.discovery.load_test_suite([os.path.dirname(__file__)])

"""
Access to built-in tests.
"""
# FIXME: There are better ways to do this, no doubt. We also would like this to
# be extensible outside of the installation. Lookup how 'nose' handles this.

_known_tests = set(['compile', 'nt', 'test_suite'])


def get_names():
    """get_test_names() -> list

    Return the list of known built-in test names.
    """
    return _known_tests


def get_module(name):
    import importlib
    """get_test_instance(name) -> lnt.test.BuiltinTest

    Return an instance of the named test.
    """
    # Allow hyphens instead of underscores when specifying the test on the
    # command line. (test-suite instead of test_suite).
    name = name.replace('-', '_')

    if name not in _known_tests:
        raise KeyError(name)

    module_name = "lnt.tests.%s" % name
    module = importlib.import_module(module_name)
    return module


__all__ = ['get_names', 'get_module']

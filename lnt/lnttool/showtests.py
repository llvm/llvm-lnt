import click


@click.command("showtests")
def action_showtests():
    """show the available built-in tests"""
    import lnt.tests
    import inspect

    print('Available tests:')
    test_names = lnt.tests.get_names()
    max_name = max(map(len, test_names))
    for name in test_names:
        test_module = lnt.tests.get_module(name)
        description = inspect.cleandoc(test_module.__doc__)
        print('  %-*s - %s' % (max_name, name, description))

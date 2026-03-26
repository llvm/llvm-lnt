import click
import os
import sys


@click.command("checkformat")
@click.argument("files", nargs=-1, type=click.Path(exists=True))
def action_checkformat(files):
    """check the format of LNT test report files"""
    import lnt.testing
    for file in files:
        result = lnt.testing.validate_report(file, '<auto>')
        print("Importing %r" % os.path.basename(file))
        if result['success']:
            data = result['data']
            machine_name = data['machine'].get('name', 'unknown')
            num_tests = len(data['tests'])
            print("Validation succeeded. Machine: %s / Tests: %d"
                  % (machine_name, num_tests))
        else:
            print("Validation failed:", file=sys.stderr)
            print(result['error'], file=sys.stderr)
            message = result.get('message')
            if message:
                print(message, file=sys.stderr)

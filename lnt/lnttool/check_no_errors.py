import click
import sys


@click.command("check-no-errors")
@click.argument("files", nargs=-1, type=click.Path(exists=True))
def action_check_no_errors(files):
    '''Check that report contains "no_error": true.'''
    import json
    error_msg = None
    for file in files:
        try:
            data = json.load(open(file))
        except Exception as e:
            error_msg = 'Could not read report: %s' % e
            break
        # Get 'run' or 'Run' { 'Info' } section (old/new format)
        run_info = data.get('run', None)
        if run_info is None:
            run_info = data.get('Run', None)
            if run_info is not None:
                run_info = run_info.get('Info', None)
        if run_info is None:
            error_msg = 'Could not find run section'
            break
        no_errors = run_info.get('no_errors', False)
        if no_errors is not True and no_errors != "True":
            error_msg = 'run section does not specify "no_errors": true'
            break
    if error_msg is not None:
        sys.stderr.write("%s: %s\n" % (file, error_msg))
        sys.exit(1)

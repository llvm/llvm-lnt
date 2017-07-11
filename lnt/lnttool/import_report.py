import os

import click

import lnt.testing


@click.command("importreport", short_help="import simple space separated "
               "data into a report to submit.")
@click.argument("input", type=click.File('rb'), default="-", required=False)
@click.argument("output", type=click.File('wb'), default="report.json",
                required=False)
@click.option("--testsuite", "suite", default="nts", show_default=True,
              required=True, help="short name of the test suite to submit to")
@click.option("--order", required=True, help="Order to submit as number. "
              "Ex: a svn revision, or timestamp.")
@click.option("--machine", required=True,
              help="the name of the machine to submit under")
def action_importreport(input, output, suite, order, machine):
    """Import simple data into LNT. This takes a space separated
    key value file and creates an LNT report file, which can be submitted to
    an LNT server.  Example input file:

    \b
    foo.exec 123
    bar.size 456
    foo/bar/baz.size 789

    The format is "test-name.metric", so exec and size are valid metrics for
    the test suite you are submitting to.
    """

    machine_info = {}
    run_info = {'tag': suite}
    run_info['run_order'] = order
    machine = lnt.testing.Machine(machine,
                                  machine_info)
    ctime = os.path.getctime(input.name)
    mtime = os.path.getmtime(input.name)

    run = lnt.testing.Run(ctime, mtime, run_info)
    report = lnt.testing.Report(machine=machine, run=run, tests=[])

    for line in input.readlines():
        key, val = line.split()
        test = lnt.testing.TestSamples(suite + "." + key, [val])
        report.tests.extend([test])

    output.write(report.render())

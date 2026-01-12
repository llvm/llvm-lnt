import click


@click.command("importreport", short_help="import simple space separated "
               "data into a report to submit.")
@click.argument("input", type=click.File('r'), default="-", required=False)
@click.argument("output", type=click.File('w'), default="report.json",
                required=False)
@click.option("--testsuite", "suite", default="nts", show_default=True,
              required=True, help="short name of the test suite to submit to")
@click.option("--order", required=True, help="Order to submit as number. "
              "Ex: a svn revision, or timestamp.")
@click.option("--machine", required=True,
              help="the name of the machine to submit under")
@click.option("--run-info", multiple=True, type=str,
              help="Optional additional run information to include in the submission. "
                   "If provided, this must be a key-value pair separated by '='. This "
                   "argument may be repeated multiple times to provide multiple keys "
                   "and values in the run information.")
def action_importreport(input, output, suite, order, machine, run_info):
    """Import simple data into LNT. This takes a space separated
    key value file and creates an LNT report file, which can be submitted to
    an LNT server. Example input file:

    \b
    foo.exec 123
    bar.size 456
    foo/bar/baz.size 789

    The format is "test-name.metric", so exec and size are valid metrics for
    the test suite you are submitting to.
    """
    import lnt.testing
    import os

    machine = lnt.testing.Machine(machine, report_version=2)

    parsed_info = {}
    for s in run_info:
        if '=' not in s:
            raise click.BadParameter(f"--run-info must be in 'key=value' format, got: {s}")
        k, v = s.split('=', 1)  # Split only on the first '=' in case there are several in the string
        parsed_info[k] = v
    run_info = parsed_info
    run_info.update({'llvm_project_revision': order})

    ctime = os.path.getctime(input.name)
    mtime = os.path.getmtime(input.name)
    run = lnt.testing.Run(start_time=ctime, end_time=mtime,
                          info=run_info,
                          report_version=2)

    tests = {}  # name => lnt.testing.Test
    for line in input.readlines():
        key, val = line.split()
        (testname, metric) = key.split(".")
        metric_type = float if metric not in ("hash", "profile") else str

        if testname not in tests:
            tests[testname] = lnt.testing.Test(testname, [], info={}, report_version=2)
        test = tests[testname]

        samples = next((s for s in test.samples if s.metric == metric), None)
        if samples is None:
            test.samples.append(lnt.testing.MetricSamples(metric, [], report_version=2))
            samples = test.samples[-1]

        samples.add_samples([val], conv_f=metric_type)

    report = lnt.testing.Report(machine=machine, run=run, tests=list(tests.values()), report_version=2)
    output.write(report.render())

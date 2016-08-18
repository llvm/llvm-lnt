import os
from optparse import OptionParser

import lnt.testing


def action_importreport(name, args):
    """Import simple space separated data into a report to submit."""
    description = """Import simple data into LNT. This takes a space separated
    key value file and creates an LNT report file, which can be submitted to
    an LNT server.  Example input file:

    foo.exec 123
    bar.size 456
    foo/bar/baz.size 789

    The format is "test-name.metric", so exec and size are valid metrics for the
    test suite you are submitting to.
    to.
    """
    parser = OptionParser(
        "%s [<input>, [<output>]] \n\n%s" % (name, description))
    parser.add_option("", "--testsuite", dest="suite", default="nts",
                      help="Short name of the test suite to submit to."
                           " [%default]")
    parser.add_option("", "--order", dest="order",
                      help="Order to submit as number.  Ex: a svn revision,"
                           " or timestamp.")
    parser.add_option("", "--machine", dest="machine",
                      help="The name of the machine to submit under.")
    (opts, args) = parser.parse_args(args)

    input_file_name = None
    output = None

    if len(args) == 1:
        input_file_name, = args
        output = "report.json"
    elif len(args) == 2:
        input_file_name, output = args
    else:
        parser.error("Invalid number of arguments.")
    if not opts.suite or not opts.order or not opts.machine:
        parser.error("Testsuite, order and machine are required.")

    intput_fd = open(input_file_name, 'r')
    output_fd = open(output, 'wb')

    machine_info = {}
    run_info = {'tag': opts.suite}
    run_info['run_order'] = opts.order
    machine = lnt.testing.Machine(opts.machine,
                                  machine_info)
    ctime = os.path.getctime(input_file_name)
    mtime = os.path.getmtime(input_file_name)

    run = lnt.testing.Run(ctime, mtime, run_info)
    report = lnt.testing.Report(machine=machine, run=run, tests=[])

    for line in intput_fd.readlines():
        key, val = line.split()
        test = lnt.testing.TestSamples(opts.suite + "." + key, [val])
        report.tests.extend([test])

    output_fd.write(report.render())

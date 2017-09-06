"""
Base class for builtin-in tests.
"""

import sys
import os

from lnt.testing.util.misc import timestamp

import lnt.util.ServerUtil as ServerUtil
import lnt.util.ImportData as ImportData
import lnt.server.config as server_config


class OptsContainer(object):
    pass


class BuiltinTest(object):
    def __init__(self):
        self.opts = OptsContainer()
        pass

    def _fatal(self, msg):
        """This simulate the output provided by OptionParser.error"""
        prog_name = os.path.basename(sys.argv[0])
        sys.stderr.write("%s error: %s\n" % (prog_name, msg))
        sys.exit(2)

    def describe(self):
        """"describe() -> str

        Return a short description of the test.
        """

    def run_test(self, opts):
        """run_test(name, args) -> lnt.testing.Report

        Execute the test (accessed via name, for use in the usage message) with
        the given command line args.
        """
        raise RuntimeError("Abstract Method.")

    def log(self, message, ts=None):
        if not ts:
            ts = timestamp()
        print >>sys.stderr, '%s: %s' % (ts, message)

    @staticmethod
    def print_report(report, output):
        """Print the report object to the output path."""
        if output == '-':
            output_stream = sys.stdout
        else:
            output_stream = open(output, 'w')
        print >> output_stream, report.render()
        if output_stream is not sys.stdout:
            output_stream.close()

    def submit(self, report_path, config, ts_name=None):
        """Submit the results file to the server.  If no server
        was specified, use a local mock server.

        report_path is the location of the json report file.  config
        holds options for submission url, and verbosity.

        Returns the report from the server.
        """
        assert os.path.exists(report_path), "Failed report should have" \
            " never gotten here!"
        assert ts_name is not None

        server_report = None
        if config.submit_url is not None:
            self.log("submitting result to %r" % (config.submit_url,))
            server_report = ServerUtil.submitFile(
                config.submit_url, report_path, config.verbose,
                select_machine=config.select_machine, merge_run=config.merge)
        else:
            server_report = ImportData.no_submit()
        if server_report:
            ImportData.print_report_result(server_report, sys.stdout, sys.stderr,
                                           config.verbose)
        return server_report

    @staticmethod
    def show_results_url(server_results):
        """Print the result URL"""
        result_url = server_results.get('result_url', None)
        if result_url is not None:
            print "Results available at:", server_results['result_url']

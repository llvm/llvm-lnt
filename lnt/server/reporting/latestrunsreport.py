from lnt.server.reporting.analysis import REGRESSED, UNCHANGED_FAIL
from lnt.server.reporting.report import RunResult, RunResults, report_css_styles
import lnt.server.reporting.analysis
import lnt.server.ui.app


class LatestRunsReport(object):
    def __init__(self, ts, run_count):
        self.ts = ts
        self.run_count = run_count
        self.hash_of_binary_field = self.ts.Sample.get_hash_of_binary_field()
        self.fields = list(ts.Sample.get_metric_fields())

        # Computed values.
        self.result_table = None

    def build(self, session):
        ts = self.ts

        machines = session.query(ts.Machine).all()

        self.result_table = []
        for field in self.fields:
            field_results = []
            for machine in machines:
                machine_results = []
                machine_runs = list(reversed(
                    session.query(ts.Run)
                    .filter(ts.Run.machine_id == machine.id)
                    .order_by(ts.Run.start_time.desc())
                    .limit(self.run_count)
                    .all()))

                if len(machine_runs) < 2:
                    continue

                machine_runs_ids = [r.id for r in machine_runs]

                # take all tests from latest run and do a comparison
                oldest_run = machine_runs[0]

                run_tests = (session.query(ts.Test)
                             .join(ts.Sample)
                             .join(ts.Run)
                             .filter(ts.Sample.run_id == oldest_run.id)
                             .filter(ts.Sample.test_id == ts.Test.id)
                             .all())

                # Create a run info object.
                sri = lnt.server.reporting.analysis.RunInfo(session, ts, machine_runs_ids)

                # Build the result table of tests with interesting results.
                def compute_visible_results_priority(visible_results):
                    # We just use an ad hoc priority that favors showing tests with
                    # failures and large changes. We do this by computing the priority
                    # as tuple of whether or not there are any failures, and then sum
                    # of the mean percentage changes.
                    test, results = visible_results
                    had_failures = False
                    sum_abs_deltas = 0.
                    for result in results:
                        test_status = result.cr.get_test_status()

                        if (test_status == REGRESSED or test_status == UNCHANGED_FAIL):
                            had_failures = True
                        elif result.cr.pct_delta is not None:
                            sum_abs_deltas += abs(result.cr.pct_delta)
                    return (field.name, -int(had_failures), -sum_abs_deltas, test.name)

                for test in run_tests:
                    cr = sri.get_comparison_result(
                            [machine_runs[-1]], [oldest_run], test.id, field,
                            self.hash_of_binary_field)

                    # If the result is not "interesting", ignore it.
                    if not cr.is_result_interesting():
                        continue

                    # For all previous runs, analyze comparison results
                    test_results = RunResults()

                    for run in reversed(machine_runs):
                        cr = sri.get_comparison_result(
                                [run], [oldest_run], test.id, field,
                                self.hash_of_binary_field)
                        test_results.append(RunResult(cr))

                    test_results.complete()

                    machine_results.append((test, test_results))

                machine_results.sort(key=compute_visible_results_priority)

                # If there are visible results for this test, append it to the
                # view.
                if machine_results:
                    field_results.append((machine, len(machine_runs), machine_results))

            field_results.sort(key=lambda x: x[0].name)
            self.result_table.append((field, field_results))

    def render(self, ts_url, only_html_body=True):
        # Strip any trailing slash on the testsuite URL.
        if ts_url.endswith('/'):
            ts_url = ts_url[:-1]

        env = lnt.server.ui.app.create_jinja_environment()
        template = env.get_template('reporting/latest_runs_report.html')

        return template.render(
            report=self, styles=report_css_styles, analysis=lnt.server.reporting.analysis,
            ts_url=ts_url, only_html_body=only_html_body)

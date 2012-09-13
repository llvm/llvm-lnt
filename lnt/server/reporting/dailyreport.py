import datetime

import sqlalchemy.sql

import lnt.server.reporting.analysis

from lnt.server.ui import util

class DailyReport(object):
    def __init__(self, ts, year, month, day, num_prior_days_to_include = 3):
        self.ts = ts
        self.num_prior_days_to_include = num_prior_days_to_include
        self.year = year
        self.month = month
        self.day = day
        self.fields = list(ts.Sample.get_primary_fields())

        # Computed values.
        self.day_start_offset = None
        self.next_day = None
        self.prior_days = None
        self.reporting_machines = None
        self.reporting_tests = None
        self.result_table = None

    def build(self):
        ts = self.ts

        # Construct datetime instances for the report range.
        day_ordinal = datetime.datetime(self.year, self.month,
                                        self.day).toordinal()

        # Adjust the dates time component.  As we typically want to do runs
        # overnight, we define "daily" to really mean "daily plus some
        # offset". The offset should generally be whenever the last run finishes
        # on today's date.
        self.day_start_offset = datetime.timedelta(hours=16)

        self.next_day = (datetime.datetime.fromordinal(day_ordinal + 1) +
                         self.day_start_offset)
        self.prior_days = [(datetime.datetime.fromordinal(day_ordinal - i) +
                            self.day_start_offset)
                           for i in range(self.num_prior_days_to_include + 1)]

        # Find all the runs that occurred for each day slice.
        prior_runs = [ts.query(ts.Run).\
                          filter(ts.Run.start_time > prior_day).\
                          filter(ts.Run.start_time <= day).all()
                      for day,prior_day in util.pairs(self.prior_days)]

        # For every machine, we only want to report on the last run order that
        # was reported for that machine for the particular day range.
        #
        # Note that this *does not* mean that we will only report for one
        # particular run order for each day, because different machines may
        # report on different orders.
        #
        # However, we want to limit ourselves to a single run order for each
        # (day,machine) so that we don't obscure any details through our
        # aggregation.
        self.prior_days_machine_order_map = \
            [None] * self.num_prior_days_to_include
        for i,runs in enumerate(prior_runs):
            # Aggregate the runs by machine.
            machine_to_all_orders = util.multidict()
            for r in runs:
                machine_to_all_orders[r.machine] = r.order

            # Create a map from machine to max order.
            self.prior_days_machine_order_map[i] = machine_order_map = dict(
                (machine, max(orders))
                for machine,orders in machine_to_all_orders.items())

            # Update the run list to only include the runs with that order.
            prior_runs[i] = [r for r in runs
                             if r.order is machine_order_map[r.machine]]

        # Form a list of all relevant runs.
        relevant_runs = sum(prior_runs, [])

        # Find the union of all machines reporting in the relevant runs.
        self.reporting_machines = list(set(r.machine for r in relevant_runs))
        self.reporting_machines.sort(key = lambda m: m.name)

        # We aspire to present a "lossless" report, in that we don't ever hide
        # any possible change due to aggregation. In addition, we want to make
        # it easy to see the relation of results across all the reporting
        # machines. In particular:
        #
        #   (a) When a test starts failing or passing on one machine, it should
        #       be easy to see how that test behaved on other machines. This
        #       makes it easy to identify the scope of the change.
        #
        #   (b) When a performance change occurs, it should be easy to see the
        #       performance of that test on other machines. This makes it easy
        #       to see the scope of the change and to potentially apply human
        #       discretion in determining whether or not a particular result is
        #       worth considering (as opposed to noise).
        #
        # The idea is as follows, for each (machine, test, primary_field),
        # classify the result into one of REGRESSED, IMPROVED, UNCHANGED_FAIL,
        # ADDED, REMOVED, PERFORMANCE_REGRESSED, PERFORMANCE_IMPROVED.
        #
        # For now, we then just aggregate by test and present the results as
        # is. This is lossless, but not nearly as nice to read as the old style
        # per-machine reports. In the future we will want to find a way to
        # combine the per-machine report style of presenting results aggregated
        # by the kind of status change, while still managing to present the
        # overview across machines.

        relevant_run_ids = [r.id for r in relevant_runs]

        # Get the set all tests reported in the recent runs.
        self.reporting_tests = ts.query(ts.Test).filter(
            sqlalchemy.sql.exists('*', sqlalchemy.sql.and_(
                    ts.Sample.run_id.in_(relevant_run_ids),
                    ts.Sample.test_id == ts.Test.id))).all()
        self.reporting_tests.sort(key=lambda t: t.name)

        # Create a run info object.
        sri = lnt.server.reporting.analysis.RunInfo(ts, relevant_run_ids)

        # Aggregate runs by machine ID and day index.
        machine_runs = util.multidict()
        for day_index,day_runs in enumerate(prior_runs):
            for run in day_runs:
                machine_runs[(run.machine_id, day_index)] = run
                
        # Build the result table::
        #   result_table[field_index][test_index][day_index][machine_index] = \
        #     {samples}
        self.result_table = []
        for field in self.fields:
            field_results = []
            for test in self.reporting_tests:
                key = test
                test_results = []
                for day_index,day_runs in enumerate(prior_runs):
                    day_results = []
                    for machine in self.reporting_machines:
                        prev_runs = machine_runs.get(
                            (machine.id, day_index+1), ())
                        day_runs = machine_runs.get(
                            (machine.id, day_index), ())
                        cr = sri.get_comparison_result(
                            day_runs, prev_runs, test.id, field)
                        day_results.append(cr)
                    test_results.append(day_results)
                field_results.append(test_results)
            self.result_table.append(field_results)

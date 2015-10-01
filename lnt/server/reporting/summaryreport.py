import re

import lnt.testing
import lnt.util.stats

###
# Aggregation Function

class Aggregation(object):
    def __init__(self):
        self.is_initialized = False

    def __repr__(self):
        return repr(self.getvalue())

    def getvalue(self):
        abstract

    def append(self, values):
        if not self.is_initialized:
            self.is_initialized = True
            self._initialize(values)
        self._append(values)

class Sum(Aggregation):
    def __init__(self):
        Aggregation.__init__(self)
        self.sum = None

    def getvalue(self):
        return self.sum

    def _initialize(self, values):
        self.sum = [0.] * len(values)

    def _append(self, values):
        for i,value in enumerate(values):
            self.sum[i] += value

class Mean(Aggregation):
    def __init__(self):
        Aggregation.__init__(self)
        self.count = 0
        self.sum = None

    def getvalue(self):
        return [value/self.count for value in self.sum]

    def _initialize(self, values):
        self.sum = [0.] * len(values)

    def _append(self, values):
        for i,value in enumerate(values):
            self.sum[i] += value
        self.count += 1

class GeometricMean(Aggregation):
    def __init__(self):
        Aggregation.__init__(self)
        self.count = 0
        self.product = None

    def getvalue(self):
        return [value ** 1.0/self.count for value in self.product]

    def __repr__(self):
        return repr(self.geometric_mean)

    def _initialize(self, values):
        self.product = [1.] * len(values)

    def _append(self, values):
        for i,value in enumerate(values):
            self.product[i] *= value
        self.count += 1

class NormalizedMean(Mean):
    def _append(self, values):
        baseline = values[0]
        Mean._append(self, [v/baseline
                            for v in values])

###

class SummaryReport(object):
    def __init__(self, db, report_orders, report_machine_names,
                 report_machine_patterns):
        self.db = db
        self.testsuites = list(db.testsuite.values())
        self.report_orders = list((name,orders)
                                  for name,orders in report_orders)
        self.report_machine_names = set(report_machine_names)
        self.report_machine_patterns = list(report_machine_patterns)
        self.report_machine_rexes = [
            re.compile(pattern)
            for pattern in self.report_machine_patterns]

        self.data_table = None
        self.requested_machine_ids = None
        self.requested_machines = None
        self.runs_at_index = None

        self.warnings = []

    def build(self):
        # Build a per-testsuite list of the machines that match the specified
        # patterns.
        def should_be_in_report(machine):
            if machine.name in self.report_machine_names:
                return True
            for rex in self.report_machine_rexes:
                if rex.match(machine.name):
                    return True
        self.requested_machines = dict((ts, filter(should_be_in_report,
                                                   ts.query(ts.Machine).all()))
                                       for ts in self.testsuites)
        self.requested_machine_ids = dict(
            (ts, [m.id for m in machines])
            for ts,machines in self.requested_machines.items())

        # First, collect all the runs to summarize on, for each index in the
        # report orders.
        self.runs_at_index = []
        for _,orders in self.report_orders:
            # For each test suite...
            runs = []
            for ts in self.testsuites:
                # Find all the orders that match.
                result = ts.query(ts.Order.id).\
                    filter(ts.Order.llvm_project_revision.in_(
                        orders)).all()
                ts_order_ids = [id for id, in result]

                # Find all the runs that matchs those orders.
                if not ts_order_ids:
                    ts_runs = []
                else:
                    ts_runs = ts.query(ts.Run).\
                        filter(ts.Run.order_id.in_(ts_order_ids)).\
                        filter(ts.Run.machine_id.in_(
                            self.requested_machine_ids[ts])).all()

                if not ts_runs:
                    self.warnings.append(
                        'no runs for test suite %r in orders %r' % (
                            ts.name, orders))
                        
                runs.append((ts_runs, ts_order_ids))
            self.runs_at_index.append(runs)

        # Load the tests for each testsuite.
        self.tests = dict((ts, dict((test.id, test)
                                    for test in ts.query(ts.Test)))
                          for ts in self.testsuites)

        # Compute the base table for aggregation.
        #
        # The table is indexed by a test name and test features, which are
        # either extracted from the test name or from the test run (depending on
        # the suite).
        #
        # Each value in the table contains a array with one item for each
        # report_order entry, which contains all of the samples for that entry..
        #
        # The table keys are tuples of:
        #  (<test name>,
        #   <metric>, # Value is either 'Compile Time' or 'Execution Time'.
        #   <arch>,
        #   <build mode>, # Value is either 'Debug' or 'Release'.
        #   <machine id>)

        self.data_table = {}
        self._build_data_table()

        # Compute indexed data table by applying the indexing functions.
        self._build_indexed_data_table()

        # Normalize across all machines.
        self._build_normalized_data_table()

        # Build final organized data tables.
        self._build_final_data_tables()

    def _build_data_table(self):
        def get_nts_datapoints_for_sample(ts, sample):
            # Get the basic sample info.
            run_id = sample[0]
            machine_id = run_machine_id_map[run_id]
            run_parameters = run_parameters_map[run_id]

            # Get the test.
            test = ts_tests[sample[1]]

            # The test name for a sample in the NTS suite is just the name of
            # the sample test.
            test_name = test.name

            # The arch and build mode are derived from the run flags.
            arch = run_parameters['cc_target'].split('-')[0]
            if '86' in arch:
                arch = 'x86'

            if run_parameters['OPTFLAGS'] == '-O0':
                build_mode = 'Debug'
            else:
                build_mode = 'Release'

            # Return a datapoint for each passing field.
            for field_name, field, status_field in ts_sample_metric_fields:
                # Ignore failing samples.
                if status_field and \
                        sample[2 + status_field.index] == lnt.testing.FAIL:
                    continue

                # Ignore missing samples.
                value = sample[2 + field.index]
                if value is None:
                    continue

                # Otherwise, return a datapoint.
                if field_name == 'compile_time':
                    metric = 'Compile Time'
                else:
                    assert field_name == 'execution_time'
                    metric = 'Execution Time'
                yield ((test_name, metric, arch, build_mode, machine_id),
                       value)

        def get_compile_datapoints_for_sample(ts, sample):
            # Get the basic sample info.
            run_id = sample[0]
            machine_id = run_machine_id_map[run_id]
            run_parameters = run_parameters_map[run_id]

            # Get the test.
            test = ts_tests[sample[1]]

            # Extract the compile flags from the test name.
            base_name,flags = test.name.split('(')
            assert flags[-1] == ')'
            other_flags = []
            build_mode = None
            for flag in flags[:-1].split(','):
                # If this is an optimization flag, derive the build mode from
                # it.
                if flag.startswith('-O'):
                    if '-O0' in flag:
                        build_mode = 'Debug'
                    else:
                        build_mode = 'Release'
                    continue

                # If this is a 'config' flag, derive the build mode from it.
                if flag.startswith('config='):
                    if flag == "config='Debug'":
                        build_mode = 'Debug'
                    else:
                        assert flag == "config='Release'"
                        build_mode = 'Release'
                    continue

                # Otherwise, treat the flag as part of the test name.
                other_flags.append(flag)

            # Form the test name prefix from the remaining flags.
            test_name_prefix = '%s(%s)' % (base_name, ','.join(other_flags))

            # Extract the arch from the run info (and normalize).
            arch = run_parameters['cc_target'].split('-')[0]
            if arch.startswith('arm'):
                arch = 'ARM'
            elif '86' in arch:
                arch = 'x86'

            # The metric is fixed.
            metric = 'Compile Time'

            # Report the user and wall time.
            for field_name, field, status_field in ts_sample_metric_fields:
                if field_name not in ('user_time', 'wall_time'):
                    continue

                # Ignore failing samples.
                if status_field and \
                        sample[2 + status_field.index] == lnt.testing.FAIL:
                    continue

                # Ignore missing samples.
                value = sample[2 + field.index]
                if value is None:
                    continue

                # Otherwise, return a datapoint.
                yield (('%s.%s' % (test_name_prefix, field_name), metric, arch,
                        build_mode, machine_id), value)

        def get_datapoints_for_sample(ts, sample):
            # The exact datapoints in each sample depend on the testsuite
            if ts.name == 'nts':
                return get_nts_datapoints_for_sample(ts, sample)
            else:
                assert ts.name == 'compile'
                return get_compile_datapoints_for_sample(ts, sample)

        # For each column...
        for index, runs in enumerate(self.runs_at_index):
            # For each test suite and run list...
            for ts, (ts_runs, _) in zip(self.testsuites, runs):
                ts_tests = self.tests[ts]

                # Compute the metric fields.
                ts_sample_metric_fields = [
                    (f.name, f, f.status_field)
                    for f in ts.Sample.get_metric_fields()]

                # Compute a mapping from run id to run.
                run_id_map = dict((r.id, r)
                                  for r in ts_runs)

                # Compute a mapping from run id to machine id.
                run_machine_id_map = dict((r.id, r.machine.name)
                                          for r in ts_runs)

                # Preload the run parameters.
                run_parameters_map = dict((r.id, r.parameters)
                                          for r in ts_runs)

                # Load all the samples for all runs we are interested in.
                columns = [ts.Sample.run_id, ts.Sample.test_id]
                columns.extend(f.column for f in ts.sample_fields)
                samples = ts.query(*columns).filter(
                    ts.Sample.run_id.in_(run_id_map.keys()))
                for sample in samples:
                    run = run_id_map[sample[0]]
                    datapoints = list()
                    for key,value in get_datapoints_for_sample(ts, sample):
                        items = self.data_table.get(key)
                        if items is None:
                            items = [[]
                                     for _ in self.report_orders]
                            self.data_table[key] = items
                        items[index].append(value)

    def _build_indexed_data_table(self):
        def is_in_execution_time_filter(name):
            for key in ("SPEC", "ClamAV", "lencod", "minisat", "SIBSim4",
                        "SPASS", "sqlite3", "viterbi", "Bullet"):
                if key in name:
                    return True

        def compute_index_name(key):
            test_name,metric,arch,build_mode,machine_id = key

            # If this is a nightly test..
            if test_name.startswith('SingleSource/') or \
                    test_name.startswith('MultiSource/') or \
                    test_name.startswith('External/'):
                # If this is a compile time test, aggregate all values into a
                # cumulative compile time.
                if metric == 'Compile Time':
                    return ('Lmark', metric, build_mode, arch, machine_id), Sum

                # Otherwise, this is an execution time. Index the cumulative
                # result of a limited set of benchmarks.
                assert metric == 'Execution Time'
                if is_in_execution_time_filter(test_name):
                    return ('Lmark', metric, build_mode, arch, machine_id), Sum

                # Otherwise, ignore the test.
                return

            # Otherwise, we have a compile time suite test.

            # Ignore user time results for now.
            if not test_name.endswith('.wall_time'):
                return

            # Index full builds across all job sizes.
            if test_name.startswith('build/'):
                project_name,subtest_name = re.match(
                    r'build/(.*)\(j=[0-9]+\)\.(.*)', str(test_name)).groups()
                return (('Full Build (%s)' % (project_name,),
                         metric, build_mode, arch, machine_id),
                        NormalizedMean)

            # Index single file tests across all inputs.
            if test_name.startswith('compile/'):
                file_name,stage_name,subtest_name = re.match(
                    r'compile/(.*)/(.*)/\(\)\.(.*)', str(test_name)).groups()
                return (('Single File (%s)' % (stage_name,),
                         metric, build_mode, arch, machine_id),
                        Mean)

            # Index PCH generation tests by input.
            if test_name.startswith('pch-gen/'):
                file_name,subtest_name = re.match(
                    r'pch-gen/(.*)/\(\)\.(.*)', str(test_name)).groups()
                return (('PCH Generation (%s)' % (file_name,),
                         metric, build_mode, arch, machine_id),
                        Mean)

            # Otherwise, ignore the test.
            return

        def is_missing_samples(values):
            for samples in values:
                if not samples:
                    return True

        self.indexed_data_table = {}
        for key,values in self.data_table.items():
            # Ignore any test which is missing some data.
            if is_missing_samples(values):
                self.warnings.append("missing values for %r" % (key,))
                continue

            # Select the median values.
            medians = [lnt.util.stats.median(samples)
                       for samples in values]

            # Compute the index name, and ignore unused tests.
            result = compute_index_name(key)
            if result is None:
                continue

            index_name,index_class = result
            item = self.indexed_data_table.get(index_name)
            if item is None:
                self.indexed_data_table[index_name] = item = index_class()
            item.append(medians)
            
    def _build_normalized_data_table(self):
        self.normalized_data_table = {}
        for key,indexed_value in self.indexed_data_table.items():
            test_name, metric, build_mode, arch, machine_id = key
            if test_name.startswith('Single File'):
                aggr = Mean
            else:
                aggr = NormalizedMean
            normalized_key = (test_name, metric, build_mode, arch)
            item = self.normalized_data_table.get(normalized_key)
            if item is None:
                self.normalized_data_table[normalized_key] = \
                    item = aggr()
            item.append(indexed_value.getvalue())

    single_file_stage_order = [
        'init', 'driver', 'syntax', 'irgen_only', 'codegen', 'assembly']
    def _build_final_data_tables(self):
        self.grouped_table = {}
        self.single_file_table = {}
        for key,normalized_value in self.normalized_data_table.items():
            test_name, metric, build_mode, arch = key

            # If this isn't a single file test, add a plot for it grouped by
            # metric and build mode.
            group_key = (metric, build_mode)
            if not test_name.startswith('Single File'):
                items = self.grouped_table[group_key] = self.grouped_table.get(
                    group_key, [])

                items.append((test_name, arch,
                              normalized_value.getvalue()))
                continue

            # Add to the single file stack.
            stage_name, = re.match('Single File \((.*)\)', test_name).groups()
            try:
                stack_index = self.single_file_stage_order.index(stage_name)
            except ValueError:
                stack_index = None
            
            # If we don't have an index for this stage, ignore it.
            if stack_index is None:
                continue

            # Otherwise, add the last value to the single file stack.
            stack = self.single_file_table.get(group_key)
            if stack is None:
                self.single_file_table[group_key] = stack = \
                    [None] * len(self.single_file_stage_order)
            stack[stack_index] = normalized_value.getvalue()[-1]

            # If this is the last single file stage, also add a plot for it.
            if stage_name == self.single_file_stage_order[-1]:
                items = self.grouped_table[group_key] = self.grouped_table.get(
                    group_key, [])
                values = normalized_value.getvalue()
                baseline = values[0]
                items.append(('Single File Tests', arch,
                              [v/baseline for v in values]))

# Test `lnt v5 import-v4-mirror --dry-run`, and the conversion it performs,
# on mirrors built by hand.
#
# RUN: rm -rf %t.dir && mkdir -p %t.dir
# RUN: python %s %t.dir > %t.out
# RUN: filecheck %s < %t.out

import copy
import gzip
import hashlib
import json
import os
import sys

from click.testing import CliRunner

from lnt.lnttool.v5 import action_import_v4_mirror
from lnt.util.import_v4_mirror import (convert_run, make_plan, read_mirror,
                                       read_run)

TMP = sys.argv[1]
URL = 'http://v4.example.com'

SCHEMA = {
    'format_version': '2',
    'name': 'nts',
    'metrics': [
        {'name': 'compile_time', 'type': 'Real', 'display_name': 'Compile Time',
         'unit': 'seconds', 'unit_abbrev': 's', 'bigger_is_better': False},
        {'name': 'exec_status', 'type': 'Status',
         'display_name': 'exec_status', 'unit': '', 'unit_abbrev': None,
         'bigger_is_better': True, 'ignore_same_hash': False},
        {'name': 'hash', 'type': 'Hash', 'display_name': 'hash'},
    ],
    'machine_fields': [{'name': 'os'}],
    'run_fields': [{'name': 'llvm_project_revision', 'order': True}],
}


def run(run_id, machine, revision, tests, **fields):
    summary = {'id': run_id, 'start_time': '2026-01-01T00:00:00',
               'end_time': '2026-01-01T01:00:00', 'order_id': 1,
               'order_by': 'llvm_project_revision',
               'llvm_project_revision': revision, **fields}
    return {'generated_by': 'fake', 'machine': machine, 'run': summary,
            'tests': [{'id': i, 'run_id': run_id, **t}
                      for i, t in enumerate(tests)]}


def sample(name, **metrics):
    return {'name': name, 'compile_time': None, 'exec_status': None,
            'hash': None, **metrics}


def write(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'wb') as f:
        f.write(data)
    return hashlib.sha256(data).hexdigest()


def make_mirror(name, machines, schema=SCHEMA, unfetched=(), database='default'):
    """A mirror holding suite nts, whose machines are (machine, [run]).

    The first machine's listing also lists the runs `unfetched`, which the
    mirror does not hold.
    """
    path = os.path.join(TMP, name)
    encode = lambda doc: json.dumps(doc).encode()  # noqa: E731
    entry = {'schema': {'sha256': write(os.path.join(path, 'nts/schema.json'),
                                        encode(schema))},
             'machines': {}}
    for machine, runs in machines:
        listing = {'generated_by': 'fake', 'machine': machine,
                   'runs': [r['run'] for r in runs]}
        if not entry['machines']:
            listing['runs'] += [run(i, machine, '1', [])['run']
                                for i in unfetched]
        mid = str(machine['id'])
        entry['machines'][mid] = {
            'name': machine['name'], 'fetched_at': '2026-01-01T00:00:00Z',
            'sha256': write(os.path.join(path, 'nts/machines/%s.json' % mid),
                            encode(listing)),
            'runs': {}}
        for r in runs:
            data = encode(r)
            write(os.path.join(path, 'nts/runs/%s.json.gz' % r['run']['id']),
                  gzip.compress(data))
            entry['machines'][mid]['runs'][str(r['run']['id'])] = {
                'sha256': hashlib.sha256(data).hexdigest()}
    manifest = {'format_version': '1',
                'source': {'url': URL, 'database': database},
                'suites': {'nts': entry}}
    write(os.path.join(path, 'manifest.json'), encode(manifest))
    return path


def import_(*args):
    result = CliRunner().invoke(action_import_v4_mirror, list(args))
    print(result.output, end='')
    print('exit: %d' % result.exit_code)


def dump(value):
    print(json.dumps(value, indent=1, sort_keys=True))


# ---------------------------------------------------------------------------
print('# CONVERSION')
M1 = {'id': 1, 'name': 'machine-a', 'os': 'linux', 'cpu': 'x86', 'ram': None}
M2 = {'id': 2, 'name': 'machine-b'}
basic = make_mirror('basic', [
    (M1, [run(10, M1, 'r100', [
        sample('test/a', compile_time=1.5, exec_status=0.0, hash='abc'),
        sample('test/b'),
        sample('test/a', compile_time=2, exec_status=1),
    ], extra_field='value', dropped=None)]),
    (M2, [run(11, M2, 'experiment', []), run(12, M2, 'r2147483648', [])]),
], unfetched=[13])
mirrored = read_mirror(basic, 'nts')
plan = make_plan(mirrored, 'target')
dump(plan.schema)
for r in mirrored.runs:
    dump(convert_run(plan, r, read_run(mirrored, r)))
import_(basic, '--suite', 'nts', '--target-suite', 'target', '--dry-run')

# The v4 metric types, mapped. A display name equal to the metric's name and
# an empty unit become null, and keys v5 doesn't know are dropped.
# CHECK-LABEL: # CONVERSION
# CHECK:       "commit_fields": [],
# CHECK-NEXT:  "machine_fields": [
# CHECK-NEXT:   {
# CHECK-NEXT:    "display_name": null,
# CHECK-NEXT:    "name": "os",
# CHECK-NEXT:    "searchable": false,
# CHECK-NEXT:    "type": "text"
# CHECK-NEXT:   },
# CHECK-NEXT:   {
# CHECK-NEXT:    "display_name": null,
# CHECK-NEXT:    "name": "cpu",
# CHECK-NEXT:    "searchable": false,
# CHECK-NEXT:    "type": "text"
# CHECK-NEXT:   },
# CHECK-NEXT:   {
# CHECK-NEXT:    "display_name": null,
# CHECK-NEXT:    "name": "ram",
# CHECK-NEXT:    "searchable": false,
# CHECK-NEXT:    "type": "text"
# CHECK-NEXT:   }
# CHECK-NEXT:  ],
# CHECK-NEXT:  "metrics": [
# CHECK-NEXT:   {
# CHECK-NEXT:    "bigger_is_better": false,
# CHECK-NEXT:    "display_name": "Compile Time",
# CHECK-NEXT:    "name": "compile_time",
# CHECK-NEXT:    "type": "real",
# CHECK-NEXT:    "unit": "seconds",
# CHECK-NEXT:    "unit_abbrev": "s"
# CHECK-NEXT:   },
# CHECK-NEXT:   {
# CHECK-NEXT:    "bigger_is_better": true,
# CHECK-NEXT:    "display_name": null,
# CHECK-NEXT:    "name": "exec_status",
# CHECK-NEXT:    "type": "integer",
# CHECK-NEXT:    "unit": null,
# CHECK-NEXT:    "unit_abbrev": null
# CHECK-NEXT:   },
# CHECK-NEXT:   {
# CHECK-NEXT:    "bigger_is_better": false,
# CHECK-NEXT:    "display_name": null,
# CHECK-NEXT:    "name": "hash",
# CHECK-NEXT:    "type": "text",
# CHECK-NEXT:    "unit": null,
# CHECK-NEXT:    "unit_abbrev": null
# CHECK-NEXT:   }
# CHECK-NEXT:  ],
# CHECK-NEXT:  "name": "target"
#
# Run 10: samples are grouped by test, in the order the tests first appear,
# without their null metrics, and a sample without any value is kept.
# CHECK:       "commit": {
# CHECK-NEXT:   "ordinal": 100,
# CHECK-NEXT:   "value": "r100"
# CHECK-NEXT:  },
# CHECK-NEXT:  "format_version": "5",
# CHECK-NEXT:  "machine": {
# CHECK-NEXT:   "fields": {
# CHECK-NEXT:    "cpu": "x86",
# CHECK-NEXT:    "os": "linux"
# CHECK-NEXT:   },
# CHECK-NEXT:   "name": "machine-a",
# CHECK-NEXT:   "tracked": false
# CHECK-NEXT:  },
# CHECK-NEXT:  "run_parameters": {
# CHECK-NEXT:   "end_time": "2026-01-01T01:00:00",
# CHECK-NEXT:   "extra_field": "value",
# CHECK-NEXT:   "start_time": "2026-01-01T00:00:00"
# CHECK-NEXT:  },
# CHECK-NEXT:  "tests": [
# CHECK-NEXT:   {
# CHECK-NEXT:    "name": "test/a",
# CHECK-NEXT:    "samples": [
# CHECK-NEXT:     {
# CHECK-NEXT:      "compile_time": 1.5,
# CHECK-NEXT:      "exec_status": 0,
# CHECK-NEXT:      "hash": "abc"
# CHECK-NEXT:     },
# CHECK-NEXT:     {
# CHECK-NEXT:      "compile_time": 2,
# CHECK-NEXT:      "exec_status": 1
# CHECK-NEXT:     }
# CHECK-NEXT:    ]
# CHECK-NEXT:   },
# CHECK-NEXT:   {
# CHECK-NEXT:    "name": "test/b",
# CHECK-NEXT:    "samples": [
# CHECK-NEXT:     {}
# CHECK-NEXT:    ]
# CHECK-NEXT:   }
# CHECK-NEXT:  ],
# CHECK-NEXT:  "uuid": "1047ee06-d530-5b6a-bfb3-1506d5a76b15"
#
# Run 11: a commit that is not a revision has no ordinal, and neither has one
# too large to be a v5 ordinal (run 12).
# CHECK:       "commit": {
# CHECK-NEXT:   "value": "experiment"
# CHECK-NEXT:  },
# CHECK:       "commit": {
# CHECK-NEXT:   "value": "r2147483648"
# CHECK-NEXT:  },
#
# CHECK:      Importing suite 'nts' of http://v4.example.com (database 'default') into suite 'target' (dry run)
# CHECK-NEXT: Schema: 3 metric(s) and 3 machine field(s)
# CHECK-NEXT: Commits: 3, of which 1 have an ordinal
# CHECK-NEXT: Warning: the mirror lacks 1 run(s) that the v4 instance listed
# CHECK-NEXT: Converted 3 run(s) of 2 machine(s); 0 failure(s).
# CHECK-NEXT: exit: 0


# ---------------------------------------------------------------------------
print('# MACHINE NAMES')
# Among machines of the same name, the one with the lowest identifier keeps
# it. A "/" becomes "_".
D = [{'id': i, 'name': 'dup'} for i in (4, 9, 7)]
S = {'id': 5, 'name': 'with/slash'}
names = make_mirror('names', [(m, []) for m in D + [S]])
import_(names, '--suite', 'nts', '--target-suite', 'target', '--dry-run')
# CHECK-LABEL: # MACHINE NAMES
# CHECK:      machine 5 (with/slash) is imported as 'with_slash'
# CHECK-NEXT: machine 7 (dup) is imported as 'dup-import-7'
# CHECK-NEXT: machine 9 (dup) is imported as 'dup-import-9'
# CHECK:      exit: 0

# Names that end up the same, or that v5 does not accept, are errors.
clash = make_mirror('clash', [
    ({'id': 1, 'name': 'a/b'}, []), ({'id': 2, 'name': 'a_b'}, []),
    ({'id': 3, 'name': 'x'}, []), ({'id': 4, 'name': 'x-import-5'}, []),
    ({'id': 5, 'name': 'x'}, []), ({'id': 6, 'name': '..'}, []),
])
import_(clash, '--suite', 'nts', '--target-suite', 'target', '--dry-run')
# CHECK:      error: machine 6: its name '..' cannot appear in a URL path
# CHECK-NEXT: error: machines 1, 2 would all be named 'a_b'
# CHECK-NEXT: error: machines 4, 5 would all be named 'x-import-5'
# CHECK-NEXT: exit: 1


# ---------------------------------------------------------------------------
print('# PLAN ERRORS')
# Every problem with the suite as a whole is reported, and nothing is
# converted.
bad_schema = copy.deepcopy(SCHEMA)
bad_schema['metrics'] += [{'name': 'blob', 'type': 'Blob'},
                          {'name': 'Exec-Time', 'type': 'Real'},
                          {'name': 'run_id', 'type': 'Real'}]
bad_schema['run_fields'].append({'name': 'other', 'order': True})
M = {'id': 1, 'name': 'm', 'tracked': 'yes', 'count': 3}
plan_errors = make_mirror('plan-errors', [
    (M, [run(1, M, 'r5', []), run(2, M, '5', [])])], schema=bad_schema)
import_(plan_errors, '--suite', 'nts', '--target-suite', 'target', '--dry-run')
# CHECK-LABEL: # PLAN ERRORS
# CHECK:      error: the schema has 2 run fields marked "order", rather than exactly one
# CHECK-NEXT: error: metric 'blob': type 'Blob' cannot be imported
# CHECK-NEXT: error: metrics entry 'Exec-Time': 'Exec-Time' is not a valid v5 name
# CHECK-NEXT: error: metrics entry 'run_id': the name is reserved by v5
# CHECK-NEXT: error: machine_fields entry 'tracked': the name is reserved by v5
# CHECK-NEXT: error: machine 1 (m): 3 is not a valid value for field 'count'
# CHECK-NEXT: exit: 1

# Two revisions with the same ordinal.
M = {'id': 1, 'name': 'm'}
ordinals = make_mirror('ordinals', [
    (M, [run(1, M, 'r5', []), run(2, M, '5', []), run(3, M, '6', [])])])
import_(ordinals, '--suite', 'nts', '--target-suite', 'target', '--dry-run')
# CHECK:      error: commits '5', 'r5' would all have ordinal 5
# CHECK-NEXT: exit: 1

# An invalid target suite name.
import_(ordinals, '--suite', 'nts', '--target-suite', 'pg_nts', '--dry-run')
# CHECK:      error: suite name: 'pg_nts' is reserved by v5


# ---------------------------------------------------------------------------
print('# RUN ERRORS')
# A run that cannot be converted is reported, and the others are converted.
M = {'id': 1, 'name': 'm'}
runs = [
    run(1, M, 'a/b', []),
    run(2, M, None, []),
    run(3, M, '3', [sample('t', compile_time='fast')]),
    run(4, M, '4', [sample('t', exec_status=1.5)]),
    run(5, M, '5', [sample('t', unknown=1)]),
    run(6, M, '6', [], bad=float('nan')),
    run(7, M, '7', [sample('t', compile_time=1)]),
    run(8, M, '8', [sample('t', hash='a\0b')]),
]
run_errors = make_mirror('run-errors', [(M, runs)])
# Damage run 7's file.
with open(os.path.join(run_errors, 'nts/runs/7.json.gz'), 'wb') as f:
    f.write(gzip.compress(b'{}'))
import_(run_errors, '--suite', 'nts', '--target-suite', 'target', '--dry-run')
# CHECK-LABEL: # RUN ERRORS
# CHECK:      run 1 of machine 1 (m): its commit 'a/b' cannot appear in a URL path
# CHECK-NEXT: run 2 of machine 1 (m): it has no llvm_project_revision
# CHECK-NEXT: run 3 of machine 1 (m): test 't', metric 'compile_time': 'fast' is not a valid real value
# CHECK-NEXT: run 4 of machine 1 (m): test 't', metric 'exec_status': 1.5 is not a valid integer value
# CHECK-NEXT: run 5 of machine 1 (m): test 't': 'unknown' is not a metric of the suite
# CHECK-NEXT: run 6 of machine 1 (m): a run parameter is nan
# CHECK-NEXT: run 7 of machine 1 (m): nts/runs/7.json.gz does not have the hash the manifest records
# CHECK-NEXT: run 8 of machine 1 (m): test 't', metric 'hash': 'a\x00b' is not a valid text value
# CHECK-NEXT: Converted 0 run(s) of 1 machine(s); 8 failure(s).
# CHECK-NEXT: exit: 1


# ---------------------------------------------------------------------------
print('# SCHEMA OVERRIDE')
M = {'id': 1, 'name': 'm', 'os': 'linux', 'cpu': 'x86'}
override_mirror = make_mirror('override', [(M, [run(1, M, '1', [])])])
derived = make_plan(read_mirror(override_mirror, 'nts'), 'target').schema


def override(name, change):
    schema = copy.deepcopy(derived)
    change(schema)
    path = os.path.join(TMP, name + '.json')
    write(path, json.dumps(schema).encode())
    return path


def fix_units(schema):
    schema['metrics'][1]['bigger_is_better'] = False
    schema['metrics'].append({'name': 'extra', 'type': 'real'})


# A schema that declares what the derived one does can differ in anything else.
import_(override_mirror, '--suite', 'nts', '--target-suite', 'target',
        '--dry-run', '--schema', override('good', fix_units))
# CHECK-LABEL: # SCHEMA OVERRIDE
# CHECK:      Schema: 4 metric(s) and 2 machine field(s), from --schema
# CHECK:      exit: 0


def break_it(schema):
    schema['name'] = 'other'
    del schema['metrics'][0]
    schema['machine_fields'][1]['type'] = 'integer'


import_(override_mirror, '--suite', 'nts', '--target-suite', 'target',
        '--dry-run', '--schema', override('bad', break_it))
# CHECK:      error: --schema: its name is 'other' rather than the target suite's, 'target'
# CHECK-NEXT: error: --schema: metrics does not declare 'compile_time'
# CHECK-NEXT: error: --schema: machine_fields entry 'cpu' has type 'integer' rather than 'text'
# CHECK-NEXT: exit: 1


# ---------------------------------------------------------------------------
print('# MIRROR ERRORS')
import_(basic, '--suite', 'compile', '--target-suite', 'target', '--dry-run')
# CHECK-LABEL: # MIRROR ERRORS
# CHECK:      error: {{.*}}basic cannot be imported: there is no suite 'compile' in the mirror
# CHECK-NEXT: exit: 1

with open(os.path.join(basic, 'nts/schema.json'), 'a') as f:
    f.write(' ')
import_(basic, '--suite', 'nts', '--target-suite', 'target', '--dry-run')
# CHECK:      error: {{.*}}basic cannot be imported: nts/schema.json does not have the hash the manifest records
# CHECK-NEXT: exit: 1

with open(os.path.join(names, 'manifest.json')) as f:
    manifest = json.load(f)
manifest['format_version'] = '2'
write(os.path.join(names, 'manifest.json'), json.dumps(manifest).encode())
import_(names, '--suite', 'nts', '--target-suite', 'target', '--dry-run')
# CHECK:      error: {{.*}}names cannot be imported: its format version is '2', but only version '1' can be imported
# CHECK-NEXT: exit: 1

# Only dry runs are supported so far.
import_(basic, '--suite', 'nts', '--target-suite', 'target')
# CHECK:      Error: only --dry-run is supported for now
# CHECK-NEXT: exit: 2

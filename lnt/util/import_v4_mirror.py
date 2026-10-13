"""Import a test suite of a mirror made by ``lnt mirror-v4`` into LNT v5.

This implements ``lnt v5 import-v4-mirror``. docs/import_v4_mirror.rst
specifies how a mirrored suite is converted; the comments below refer to it as
"the spec". The mirror's format is specified by docs/mirror_v4.rst.

The import has two phases. Planning reads the suite's schema and machine
listings, which are small, and decides everything that depends on the suite as
a whole: the target schema, the name of each machine, and the commits'
ordinals. Converting then turns each run into a v5 submission on its own, from
its document and the plan.
"""

import collections
import gzip
import hashlib
import json
import math
import os
import re
import uuid
import zlib
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, TextIO

from lnt.util.mirror_v4 import (FORMAT_VERSION, MANIFEST, machine_path,
                                run_path, schema_path)

# A JSON object read from the mirror or written for v5.
JSONObject = dict[str, Any]

# Where the import reports its progress, one line at a time.
Echo = Callable[[str], None]

# v4 metric types, and the v5 types they become.
METRIC_TYPES = {'Real': 'real', 'Status': 'integer', 'Hash': 'text'}

# Suffix given to a machine whose name an older machine already has.
DUPLICATE_SUFFIX = '-import-%s'

# v5's rules for names of suites and of schema entries.
_NAME_RE = re.compile(r'[a-z][a-z0-9_]*')
_NAME_MAX = 63
_RESERVED_SUITE_NAMES = {'public', 'information_schema'}
_V5_TYPES = {'real', 'integer', 'text', 'datetime'}
# The built-in columns of the v5 tables that schema entries add columns to:
# a metric is a column of the sample and test coverage tables, a machine field
# one of the machine table, and a commit field one of the commit table.
_METRIC_BUILTINS = {'id', 'run_id', 'test_id', 'machine_id'}
_MACHINE_FIELD_BUILTINS = {'id', 'name', 'tracked'}
_COMMIT_FIELD_BUILTINS = {'id', 'commit', 'ordinal', 'tag'}

# The length v5 allows for machine names, commit values and test names.
_IDENTIFIER_MAX = 256

# v5 ordinals are 32-bit, and integer metrics 64-bit.
_ORDINAL_RE = re.compile(r'r?([0-9]+)')
_ORDINAL_MAX = 2**31 - 1
_INTEGER_MIN, _INTEGER_MAX = -2**63, 2**63 - 1

# Keys of v4 objects that do not become v5 data: the v4 API's own bookkeeping.
_MACHINE_KEYS_DROPPED = {'id', 'name'}
_RUN_KEYS_DROPPED = {'id', 'order_id', 'order_by'}
_SAMPLE_KEYS_DROPPED = {'id', 'run_id', 'name'}


class PlanError(Exception):
    """Problems that stop the import before any run is converted."""

    def __init__(self, problems: list[str]) -> None:
        super().__init__('\n'.join(problems))
        self.problems = problems


class ConversionError(Exception):
    """A run that cannot be converted."""


# ----------------------------------------------------------------------------
# Reading the mirror
# ----------------------------------------------------------------------------

@dataclass
class MirroredRun:
    id: str
    machine_id: str
    sha256: str       # of its document, as the manifest records it
    # The fields of the run that its commit is derived from, as its machine's
    # listing reports them.
    commit_fields: JSONObject


@dataclass
class MirroredSuite:
    path: str
    url: str
    database: str
    suite: str
    schema: JSONObject
    order_fields: list[str]          # run fields marked "order" by the schema
    commit_field: str | None         # given with --commit-field
    machines: dict[str, JSONObject]  # v4 machine id -> machine object
    runs: list[MirroredRun]          # in increasing order of v4 id
    # Runs in the listings that the mirror does not hold, because the refresh
    # that made it could not fetch them.
    missing: int


def _read(mirror_dir: str, relpath: str, sha256: str,
          compressed: bool = False) -> bytes:
    """The contents of a file the manifest references, checked against it."""
    try:
        with open(os.path.join(mirror_dir, relpath), 'rb') as f:
            data = f.read()
        if compressed:
            data = gzip.decompress(data)
    except (OSError, EOFError, zlib.error) as e:
        raise ValueError('%s cannot be read: %s' % (relpath, e))
    if hashlib.sha256(data).hexdigest() != sha256:
        raise ValueError('%s does not have the hash the manifest records'
                         % relpath)
    return data


def _parse(data: bytes, what: str) -> JSONObject:
    try:
        document = json.loads(data)
    except ValueError as e:
        raise ValueError('%s is not valid JSON: %s' % (what, e))
    if not isinstance(document, dict):
        raise ValueError('%s is not a JSON object' % what)
    return document


def read_mirror(mirror_dir: str, suite: str,
                commit_field: str | None = None) -> MirroredSuite:
    """Read what planning needs of `suite` in the mirror at `mirror_dir`.

    `commit_field` is the run field given with --commit-field, if any.

    The listings are read one at a time, keeping only what planning needs of
    them: those of a large suite take gigabytes once parsed.
    """
    try:
        with open(os.path.join(mirror_dir, MANIFEST), 'rb') as f:
            manifest = _parse(f.read(), MANIFEST)
        if manifest.get('format_version') != FORMAT_VERSION:
            raise ValueError('its format version is %r, but only version %r '
                             'can be imported'
                             % (manifest.get('format_version'),
                                FORMAT_VERSION))
        if suite not in manifest['suites']:
            raise ValueError("there is no suite '%s' in the mirror" % suite)
        entry = manifest['suites'][suite]
        schema = _parse(_read(mirror_dir, schema_path(suite),
                              entry['schema']['sha256']), 'the schema')
        for key in ('metrics', 'machine_fields', 'run_fields'):
            if not all(isinstance(e, dict) for e in schema.get(key, [])):
                raise ValueError('the schema has a malformed %s list' % key)
        order_fields = [f.get('name') for f in schema.get('run_fields', [])
                        if f.get('order')]
        if not all(isinstance(field, str) for field in order_fields):
            raise ValueError('the schema has a malformed run_fields list')
        machines: dict[str, JSONObject] = {}
        runs: list[MirroredRun] = []
        missing = 0
        for machine_id, machine in entry['machines'].items():
            listing = _parse(_read(mirror_dir,
                                   machine_path(suite, machine_id),
                                   machine['sha256']),
                             'the listing of machine %s' % machine_id)
            int(machine_id)
            if not isinstance(listing['machine'], dict):
                raise ValueError('the listing of machine %s is malformed'
                                 % machine_id)
            machines[machine_id] = listing['machine']
            summaries = {str(run['id']): run for run in listing['runs']}
            missing += len(summaries.keys() - machine['runs'].keys())
            for run_id, run in machine['runs'].items():
                summary = summaries[run_id]
                fields = {key: summary.get(key)
                          for key in order_fields + [commit_field]
                          if key is not None}
                runs.append(MirroredRun(run_id, machine_id, run['sha256'],
                                        fields))
        runs.sort(key=lambda run: int(run.id))
        return MirroredSuite(mirror_dir, manifest['source']['url'],
                             manifest['source']['database'], suite, schema,
                             order_fields, commit_field, machines, runs,
                             missing)
    except OSError as e:
        raise PlanError(['%s is not a readable mirror: %s' % (mirror_dir, e)])
    except ValueError as e:
        raise PlanError(['%s cannot be imported: %s' % (mirror_dir, e)])
    except (AttributeError, KeyError, TypeError) as e:
        raise PlanError(['%s cannot be imported: it is malformed (%r)'
                         % (mirror_dir, e)])


def read_run(mirrored: MirroredSuite, run: MirroredRun) -> JSONObject:
    """The document of a mirrored run."""
    try:
        return _parse(_read(mirrored.path, run_path(mirrored.suite, run.id),
                            run.sha256, compressed=True), 'its document')
    except ValueError as e:
        raise ConversionError(str(e))


# ----------------------------------------------------------------------------
# Planning
# ----------------------------------------------------------------------------

@dataclass
class Plan:
    mirrored: MirroredSuite
    schema: JSONObject              # the schema to create the target suite with
    metric_types: dict[str, str]    # metric -> its type in the target schema
    order_field: str
    machines: dict[str, JSONObject]  # v4 machine id -> v5 machine object
    ordinals: dict[str, int | None]  # commit value -> ordinal


def _check_name(name: Any, what: str, problems: list[str]) -> None:
    if not isinstance(name, str) or not _NAME_RE.fullmatch(name) or \
            len(name) > _NAME_MAX:
        problems.append('%s: %r is not a valid v5 name' % (what, name))


def _identifier_problem(value: Any) -> str | None:
    """Why `value` cannot be a v5 machine name or commit value, if it can't.

    Neither can contain a "/", or be "." or "..", since they appear in URL
    paths.
    """
    if not isinstance(value, str) or not value:
        return '%r is not a non-empty string' % (value,)
    if len(value) > _IDENTIFIER_MAX:
        return '%r is longer than %d characters' % (value, _IDENTIFIER_MAX)
    if '/' in value or value in ('.', '..') or '\0' in value:
        return '%r cannot appear in a URL path' % (value,)
    return None


def check_schema(schema: JSONObject, problems: list[str]) -> None:
    """Check the parts of a v5 schema that a converted suite could get wrong.

    The v5 instance validates the whole schema when the suite is created; this
    only lets a dry run report what the conversion is responsible for. The
    schema may come from the user (--schema), so nothing about its shape is
    assumed.
    """
    found: list[str] = []
    name = schema.get('name')
    _check_name(name, 'suite name', found)
    if isinstance(name, str) and \
            (name in _RESERVED_SUITE_NAMES or name.startswith('pg_')):
        found.append('suite name: %r is reserved by v5' % name)
    lists = [('metrics', _METRIC_BUILTINS),
             ('machine_fields', _MACHINE_FIELD_BUILTINS),
             ('commit_fields', _COMMIT_FIELD_BUILTINS)]
    for key, builtins in lists:
        entries = schema.get(key, [])
        if not isinstance(entries, list) or \
                not all(isinstance(e, dict) for e in entries):
            found.append('%s: not a list of objects' % key)
            continue
        names = [e.get('name') for e in entries]
        for entry in entries:
            entry_name, entry_type = entry.get('name'), entry.get('type')
            what = '%s entry %r' % (key, entry_name)
            _check_name(entry_name, what, found)
            if isinstance(entry_name, str):
                if entry_name in builtins:
                    found.append('%s: the name is reserved by v5' % what)
                if names.count(entry_name) > 1:
                    found.append('%s: the name is declared more than once'
                                 % what)
            if not isinstance(entry_type, str) or entry_type not in _V5_TYPES:
                found.append('%s: %r is not a v5 type' % (what, entry_type))
            for label in ('display_name', 'unit', 'unit_abbrev'):
                value = entry.get(label)
                if value is not None and \
                        (not isinstance(value, str) or not value):
                    found.append('%s: %s %r is not a non-empty string'
                                 % (what, label, value))
    # An entry declared twice is reported twice; keep each message once.
    problems.extend(dict.fromkeys(found))


def _derive_schema(mirrored: MirroredSuite, target_suite: str,
                   problems: list[str]) -> JSONObject:
    """The target schema the spec derives.

    The schema is in the normalized form a v5 instance returns, with every
    optional key present.
    """
    metrics = []
    for metric in mirrored.schema.get('metrics', []):
        name, v4_type = metric.get('name'), metric.get('type')
        v5_type = METRIC_TYPES.get(v4_type) if isinstance(v4_type, str) else None
        if v5_type is None:
            problems.append('metric %r: type %r cannot be imported'
                            % (name, metric.get('type')))
            continue
        display_name = metric.get('display_name')
        metrics.append({
            'name': name,
            'type': v5_type,
            # v4 reports a metric without a display name with its name.
            'display_name': None if display_name == name else display_name,
            'unit': metric.get('unit') or None,
            'unit_abbrev': metric.get('unit_abbrev') or None,
            'bigger_is_better': bool(metric.get('bigger_is_better')),
        })

    declared = [f.get('name')
                for f in mirrored.schema.get('machine_fields', [])]
    undeclared = sorted({key for machine in mirrored.machines.values()
                         for key in machine
                         if key not in _MACHINE_KEYS_DROPPED and
                         key not in declared})
    machine_fields = [{'name': name, 'type': 'text', 'display_name': None,
                       'searchable': False}
                      for name in declared + undeclared]

    schema = {'name': target_suite, 'metrics': metrics,
              'machine_fields': machine_fields, 'commit_fields': []}
    check_schema(schema, problems)
    return schema


def _check_override(override: JSONObject, derived: JSONObject,
                    problems: list[str]) -> None:
    """Check that `override` can stand in for the derived schema."""
    if override.get('name') != derived['name']:
        problems.append('--schema: its name is %r rather than the target '
                        "suite's, %r" % (override.get('name'),
                                         derived['name']))
    for key in ('metrics', 'machine_fields'):
        entries = override.get(key, [])
        types = {}
        if isinstance(entries, list):
            types = {e.get('name'): e.get('type') for e in entries
                     if isinstance(e, dict) and isinstance(e.get('name'), str)}
        for entry in derived[key]:
            if entry['name'] not in types:
                problems.append('--schema: %s does not declare %r'
                                % (key, entry['name']))
            elif types[entry['name']] != entry['type']:
                problems.append('--schema: %s entry %r has type %r rather '
                                'than %r' % (key, entry['name'],
                                             types[entry['name']],
                                             entry['type']))
    check_schema(override, problems)


def _name_machines(mirrored: MirroredSuite,
                   problems: list[str]) -> dict[str, JSONObject]:
    """The v5 machine object of each v4 machine, by v4 identifier."""
    by_name: dict[str, list[str]] = collections.defaultdict(list)
    for machine_id in sorted(mirrored.machines, key=int):
        v4_name = mirrored.machines[machine_id].get('name')
        if isinstance(v4_name, str):
            by_name[v4_name].append(machine_id)
        else:
            problems.append('machine %s: its name, %r, is not a string'
                            % (machine_id, v4_name))

    machines: dict[str, JSONObject] = {}
    for v4_name, ids in by_name.items():
        # The oldest machine of a name keeps it.
        for i, machine_id in enumerate(ids):
            name = v4_name.replace('/', '_')
            if i > 0:
                name += DUPLICATE_SUFFIX % machine_id
            fields = {}
            for key, value in mirrored.machines[machine_id].items():
                if key in _MACHINE_KEYS_DROPPED or value is None:
                    continue
                if not isinstance(value, str) or '\0' in value:
                    problems.append('machine %s (%s): %r is not a valid '
                                    'value for field %r'
                                    % (machine_id, v4_name, value, key))
                fields[key] = value
            machines[machine_id] = {'name': name, 'tracked': False,
                                    'fields': fields}

    owners: dict[str, list[str]] = collections.defaultdict(list)
    for machine_id, machine in machines.items():
        owners[machine['name']].append(machine_id)
    for name, ids in sorted(owners.items()):
        problem = _identifier_problem(name)
        if problem:
            problems.append('machine %s: its name %s' % (ids[0], problem))
        if len(ids) > 1:
            problems.append('machines %s would all be named %r'
                            % (', '.join(sorted(ids, key=int)), name))
    return machines


def _commit_value(value: Any) -> str | None:
    """A v4 order field's value as a commit value, if it can be one."""
    if isinstance(value, str):
        return value
    if isinstance(value, int) and not isinstance(value, bool):
        return str(value)
    return None


def ordinal(commit: str) -> int | None:
    """The ordinal of the commit `commit`, if it has one."""
    match = _ORDINAL_RE.fullmatch(commit)
    if match is None or int(match.group(1)) > _ORDINAL_MAX:
        return None
    return int(match.group(1))


def _commit_source(run: JSONObject, order_field: str,
                   commit_field: str | None) -> str:
    """The field of the v4 run `run` that its commit is taken from."""
    if commit_field is not None and run.get(commit_field) is not None:
        return commit_field
    return order_field


def _run_ordinal(run: JSONObject, order_field: str) -> int | None:
    """The ordinal of the commit of the v4 run `run`, if it has one."""
    revision = _commit_value(run.get(order_field))
    return ordinal(revision) if revision is not None else None


def _order_commits(mirrored: MirroredSuite, order_field: str,
                   problems: list[str]) -> dict[str, int | None]:
    """The ordinal of each commit, by commit value."""
    commit_field = mirrored.commit_field
    if commit_field is not None and \
            all(run.commit_fields.get(commit_field) is None
                for run in mirrored.runs):
        problems.append('--commit-field: no run has a %s' % commit_field)
    ordinals: dict[str, int | None] = {}
    disputed: set[str] = set()
    for run in mirrored.runs:
        source = _commit_source(run.commit_fields, order_field, commit_field)
        commit = _commit_value(run.commit_fields.get(source))
        if commit is None:
            continue
        value = _run_ordinal(run.commit_fields, order_field)
        if commit in ordinals and ordinals[commit] != value:
            disputed.add(commit)
        ordinals.setdefault(commit, value)
    for commit in sorted(disputed):
        problems.append('the runs of commit %r do not agree on its ordinal'
                        % commit)
    values: dict[int, list[str]] = collections.defaultdict(list)
    for commit, value in ordinals.items():
        if value is not None:
            values[value].append(commit)
    for value, commits in sorted(values.items()):
        if len(commits) > 1:
            problems.append('commits %s would all have ordinal %d'
                            % (', '.join(repr(c) for c in sorted(commits)),
                               value))
    return ordinals


def make_plan(mirrored: MirroredSuite, target_suite: str,
              override: JSONObject | None = None) -> Plan:
    """Plan the import of `mirrored` into the v5 suite `target_suite`.

    `override` is the schema given with --schema, if any. Raises PlanError with
    every problem found.
    """
    problems: list[str] = []
    if len(mirrored.order_fields) != 1:
        problems.append('the schema has %d run fields marked "order", rather '
                        'than exactly one' % len(mirrored.order_fields))
    schema = _derive_schema(mirrored, target_suite, problems)
    if override is not None:
        _check_override(override, schema, problems)
        schema = override
    machines = _name_machines(mirrored, problems)
    ordinals: dict[str, int | None] = {}
    if len(mirrored.order_fields) == 1:
        ordinals = _order_commits(mirrored, mirrored.order_fields[0], problems)
    if problems:
        raise PlanError(problems)
    # Samples are checked against the target schema, which check_schema has
    # found well-formed.
    metric_types = {m['name']: m['type'] for m in schema.get('metrics', [])}
    return Plan(mirrored, schema, metric_types, mirrored.order_fields[0],
                machines, ordinals)


# ----------------------------------------------------------------------------
# Converting
# ----------------------------------------------------------------------------

def run_uuid(mirrored: MirroredSuite, run_id: str) -> str:
    """The UUID of the v5 run that a v4 run becomes.

    It is derived from the v4 run's API URL, so that a run always gets the
    same UUID, however many times it is imported.
    """
    url = '%s/api/db_%s/v4/%s/runs/%s' % (mirrored.url, mirrored.database,
                                          mirrored.suite, run_id)
    return str(uuid.uuid5(uuid.NAMESPACE_URL, url))


def _check_storable(value: Any, where: str) -> None:
    """Reject what v5 cannot store anywhere: NULs, and non-finite numbers."""
    if isinstance(value, str):
        if '\0' in value:
            raise ConversionError('%s contains a NUL character' % where)
    elif isinstance(value, float):
        if not math.isfinite(value):
            raise ConversionError('%s is %r' % (where, value))
    elif isinstance(value, dict):
        for key, item in value.items():
            _check_storable(key, where)
            _check_storable(item, where)
    elif isinstance(value, list):
        for item in value:
            _check_storable(item, where)


def _is_finite_number(value: Any) -> bool:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return False
    try:
        return math.isfinite(value)
    except OverflowError:
        # An int too large to be a float.
        return False


def _typed(value: Any, v5_type: str, what: str) -> Any:
    """`value` as a value of the v5 type `v5_type`."""
    if v5_type == 'real' and _is_finite_number(value):
        return value
    if v5_type == 'integer' and _is_finite_number(value) and \
            value == int(value) and _INTEGER_MIN <= value <= _INTEGER_MAX:
        return int(value)
    if v5_type == 'text' and isinstance(value, str) and '\0' not in value:
        return value
    raise ConversionError('%s: %r is not a valid %s value'
                          % (what, value, v5_type))


def convert_run(plan: Plan, run: MirroredRun,
                document: JSONObject) -> JSONObject:
    """The v5 submission that a v4 run becomes, given its document."""
    try:
        v4_run = document['run']
        samples = document['tests']
        if not isinstance(v4_run, dict) or not isinstance(samples, list):
            raise TypeError('unexpected shape')
    except (KeyError, TypeError):
        raise ConversionError('its document does not have the shape of a v4 '
                              'run')

    source = _commit_source(v4_run, plan.order_field,
                            plan.mirrored.commit_field)
    commit_value = _commit_value(v4_run.get(source))
    if commit_value is None:
        raise ConversionError('it has no valid %s: %r'
                              % (source, v4_run.get(source)))
    problem = _identifier_problem(commit_value)
    if problem:
        raise ConversionError('its commit %s' % problem)
    commit: JSONObject = {'value': commit_value}
    run_ordinal = _run_ordinal(v4_run, plan.order_field)
    if run_ordinal is not None:
        commit['ordinal'] = run_ordinal

    run_parameters = {key: value for key, value in v4_run.items()
                      if value is not None and
                      key not in _RUN_KEYS_DROPPED and key != source}
    _check_storable(run_parameters, 'a run parameter')

    tests: dict[str, list[JSONObject]] = {}
    for sample in samples:
        if not isinstance(sample, dict):
            raise ConversionError('a sample is not a JSON object')
        name = sample.get('name')
        if not isinstance(name, str) or not name or \
                len(name) > _IDENTIFIER_MAX or '\0' in name:
            raise ConversionError('%r is not a valid test name' % (name,))
        values = {}
        for key, value in sample.items():
            if key in _SAMPLE_KEYS_DROPPED or value is None:
                continue
            if key not in plan.metric_types:
                raise ConversionError('test %r: %r is not a metric of the '
                                      'suite' % (name, key))
            values[key] = _typed(value, plan.metric_types[key],
                                 'test %r, metric %r' % (name, key))
        tests.setdefault(name, []).append(values)

    return {
        'format_version': '5',
        'uuid': run_uuid(plan.mirrored, run.id),
        'machine': plan.machines[run.machine_id],
        'commit': commit,
        'run_parameters': run_parameters,
        'tests': [{'name': name, 'samples': samples}
                  for name, samples in tests.items()],
    }


# ----------------------------------------------------------------------------
# The command
# ----------------------------------------------------------------------------

def _describe(plan: Plan, run: MirroredRun) -> str:
    machine = plan.mirrored.machines[run.machine_id]
    return 'run %s of machine %s (%s)' % (run.id, run.machine_id,
                                          machine.get('name'))


def convert(mirror_dir: str, suite: str, out: TextIO,
            target_suite: str | None = None,
            override: JSONObject | None = None,
            commit_field: str | None = None, schema_out: str | None = None,
            echo: Echo = print) -> int:
    """Convert every run of `suite` in the mirror at `mirror_dir`.

    Each run's submission is written to `out` as a line of JSON, and the
    target schema to the file `schema_out`, if given. `echo` gets the report.
    Returns the number of runs that cannot be converted. Raises PlanError if
    the suite cannot be converted at all.
    """
    mirrored = read_mirror(mirror_dir, suite, commit_field)
    target_suite = target_suite if target_suite is not None else suite
    echo("Converting suite '%s' of %s (database '%s') into suite '%s'"
         % (suite, mirrored.url, mirrored.database, target_suite))
    plan = make_plan(mirrored, target_suite, override)
    if schema_out is not None:
        with open(schema_out, 'w') as f:
            f.write(json.dumps(plan.schema, indent=2) + '\n')

    echo('Schema: %d metric(s) and %d machine field(s)%s'
         % (len(plan.schema.get('metrics', [])),
            len(plan.schema.get('machine_fields', [])),
            ', from --schema' if override is not None else ''))
    for machine_id in sorted(plan.machines, key=int):
        v4_name = mirrored.machines[machine_id]['name']
        if plan.machines[machine_id]['name'] != v4_name:
            echo('  machine %s (%s) is renamed %r'
                 % (machine_id, v4_name, plan.machines[machine_id]['name']))
    ordered = sum(1 for value in plan.ordinals.values() if value is not None)
    echo('Commits: %d, of which %d have an ordinal'
         % (len(plan.ordinals), ordered))
    if mirrored.missing:
        echo('Warning: the mirror lacks %d run(s) that the v4 instance listed'
             % mirrored.missing)

    failures = 0
    for run in mirrored.runs:
        try:
            submission = convert_run(plan, run, read_run(mirrored, run))
        except ConversionError as e:
            failures += 1
            echo('  %s: %s' % (_describe(plan, run), e))
            continue
        out.write(json.dumps(submission) + '\n')
    echo('Converted %d run(s) of %d machine(s); %d failure(s).'
         % (len(mirrored.runs) - failures, len(plan.machines), failures))
    return failures

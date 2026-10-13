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
from typing import Any

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
_NAME_RE = re.compile(r'^[a-z][a-z0-9_]*$')
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
_ORDINAL_RE = re.compile(r'^r?([0-9]+)$')
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
    commit: Any       # the value of its order field, from the listing


@dataclass
class MirroredSuite:
    path: str
    url: str
    database: str
    suite: str
    schema: JSONObject
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


def read_mirror(mirror_dir: str, suite: str) -> MirroredSuite:
    """Read what planning needs of `suite` in the mirror at `mirror_dir`.

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
        order_fields = [f.get('name') for f in schema.get('run_fields', [])
                        if f.get('order')]
        machines: dict[str, JSONObject] = {}
        runs: list[MirroredRun] = []
        missing = 0
        for machine_id, machine in entry['machines'].items():
            listing = _parse(_read(mirror_dir,
                                   machine_path(suite, machine_id),
                                   machine['sha256']),
                             'the listing of machine %s' % machine_id)
            machines[machine_id] = listing['machine']
            summaries = {str(run['id']): run for run in listing['runs']}
            missing += len(summaries.keys() - machine['runs'].keys())
            for run_id, run in machine['runs'].items():
                commit = None
                if len(order_fields) == 1:
                    commit = summaries[run_id].get(order_fields[0])
                runs.append(MirroredRun(run_id, machine_id, run['sha256'],
                                        commit))
    except OSError as e:
        raise PlanError(['%s is not a readable mirror: %s' % (mirror_dir, e)])
    except (KeyError, TypeError, ValueError) as e:
        raise PlanError(['%s cannot be imported: %s' % (mirror_dir, e)])
    runs.sort(key=lambda run: int(run.id))
    return MirroredSuite(mirror_dir, manifest['source']['url'],
                         manifest['source']['database'], suite, schema,
                         machines, runs, missing)


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
    metric_types: dict[str, str]    # the v5 type of each v4 metric
    order_field: str
    machines: dict[str, JSONObject]  # v4 machine id -> v5 machine object
    ordinals: dict[str, int | None]  # commit value -> ordinal


def _check_name(name: Any, what: str, problems: list[str]) -> None:
    if not isinstance(name, str) or not _NAME_RE.match(name) or \
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
    only lets a dry run report what the conversion is responsible for.
    """
    _check_name(schema.get('name'), 'suite name', problems)
    name = schema.get('name')
    if name in _RESERVED_SUITE_NAMES or \
            (isinstance(name, str) and name.startswith('pg_')):
        problems.append('suite name: %r is reserved by v5' % name)
    lists = [('metrics', _METRIC_BUILTINS),
             ('machine_fields', _MACHINE_FIELD_BUILTINS),
             ('commit_fields', _COMMIT_FIELD_BUILTINS)]
    for key, builtins in lists:
        entries = schema.get(key, [])
        if not isinstance(entries, list) or \
                not all(isinstance(e, dict) for e in entries):
            problems.append('%s: not a list of objects' % key)
            continue
        names = [e.get('name') for e in entries]
        for entry in entries:
            what = '%s entry %r' % (key, entry.get('name'))
            _check_name(entry.get('name'), what, problems)
            if entry.get('name') in builtins:
                problems.append('%s: the name is reserved by v5' % what)
            if names.count(entry.get('name')) > 1:
                problems.append('%s: the name is declared more than once'
                                % what)
            if entry.get('type') not in _V5_TYPES:
                problems.append('%s: %r is not a v5 type'
                                % (what, entry.get('type')))
            for label in ('display_name', 'unit', 'unit_abbrev'):
                value = entry.get(label)
                if value is not None and \
                        (not isinstance(value, str) or not value):
                    problems.append('%s: %s %r is not a non-empty string'
                                    % (what, label, value))
    # Duplicates are reported once per entry; keep each message once.
    problems[:] = list(dict.fromkeys(problems))


def _derive_schema(mirrored: MirroredSuite, target_suite: str,
                   problems: list[str]) -> tuple[JSONObject, dict[str, str]]:
    """The target schema the spec derives, and the type of each metric.

    The schema is in the normalized form a v5 instance returns, with every
    optional key present.
    """
    metrics = []
    metric_types = {}
    for metric in mirrored.schema.get('metrics', []):
        name = metric.get('name')
        v5_type = METRIC_TYPES.get(metric.get('type'))
        if v5_type is None:
            problems.append('metric %r: type %r cannot be imported'
                            % (name, metric.get('type')))
            continue
        metric_types[name] = v5_type
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
    return schema, metric_types


def _check_override(override: JSONObject, derived: JSONObject,
                    problems: list[str]) -> None:
    """Check that `override` can stand in for the derived schema."""
    if override.get('name') != derived['name']:
        problems.append('--schema: its name is %r rather than the target '
                        "suite's, %r" % (override.get('name'),
                                         derived['name']))
    for key in ('metrics', 'machine_fields'):
        entries = override.get(key, [])
        types = {e.get('name'): e.get('type') for e in entries
                 if isinstance(e, dict)} if isinstance(entries, list) else {}
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
    by_name: dict[Any, list[str]] = collections.defaultdict(list)
    for machine_id in sorted(mirrored.machines, key=int):
        by_name[mirrored.machines[machine_id].get('name')].append(machine_id)

    machines: dict[str, JSONObject] = {}
    for v4_name, ids in by_name.items():
        if not isinstance(v4_name, str):
            problems.append('machine %s: its name, %r, is not a string'
                            % (ids[0], v4_name))
            continue
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


def ordinal(commit: str) -> int | None:
    """The ordinal of the commit `commit`, if it has one."""
    match = _ORDINAL_RE.match(commit)
    if match is None or int(match.group(1)) > _ORDINAL_MAX:
        return None
    return int(match.group(1))


def _order_commits(mirrored: MirroredSuite,
                   problems: list[str]) -> dict[str, int | None]:
    """The ordinal of each commit, by commit value."""
    ordinals = {}
    for run in mirrored.runs:
        if run.commit is not None:
            commit = str(run.commit)
            ordinals[commit] = ordinal(commit)
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
    order_fields = [f.get('name') for f in mirrored.schema.get('run_fields', [])
                    if f.get('order')]
    if len(order_fields) != 1:
        problems.append('the schema has %d run fields marked "order", rather '
                        'than exactly one' % len(order_fields))
    schema, metric_types = _derive_schema(mirrored, target_suite, problems)
    if override is not None:
        _check_override(override, schema, problems)
        schema = override
    machines = _name_machines(mirrored, problems)
    ordinals = _order_commits(mirrored, problems)
    if problems:
        raise PlanError(problems)
    return Plan(mirrored, schema, metric_types, order_fields[0], machines,
                ordinals)


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


def _typed(value: Any, v5_type: str, what: str) -> Any:
    """`value` as a value of the v5 type `v5_type`."""
    is_number = isinstance(value, (int, float)) and \
        not isinstance(value, bool)
    if v5_type == 'real' and is_number and math.isfinite(value):
        return value
    if v5_type == 'integer' and is_number and math.isfinite(value) and \
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

    commit_value = v4_run.get(plan.order_field)
    if commit_value is None:
        raise ConversionError('it has no %s' % plan.order_field)
    commit_value = str(commit_value)
    problem = _identifier_problem(commit_value)
    if problem:
        raise ConversionError('its commit %s' % problem)
    commit: JSONObject = {'value': commit_value}
    if plan.ordinals.get(commit_value) is not None:
        commit['ordinal'] = plan.ordinals[commit_value]

    run_parameters = {key: value for key, value in v4_run.items()
                      if value is not None and
                      key not in _RUN_KEYS_DROPPED and
                      key != plan.order_field}
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


def dry_run(mirror_dir: str, suite: str, target_suite: str,
            override: JSONObject | None = None, echo: Echo = print) -> int:
    """Plan the import and convert every run, without submitting anything.

    Returns the number of runs that cannot be converted. Raises PlanError if
    the suite cannot be imported at all.
    """
    mirrored = read_mirror(mirror_dir, suite)
    echo("Importing suite '%s' of %s (database '%s') into suite '%s' "
         '(dry run)' % (suite, mirrored.url, mirrored.database, target_suite))
    plan = make_plan(mirrored, target_suite, override)

    echo('Schema: %d metric(s) and %d machine field(s)%s'
         % (len(plan.schema.get('metrics', [])),
            len(plan.schema.get('machine_fields', [])),
            ', from --schema' if override is not None else ''))
    for machine_id in sorted(plan.machines, key=int):
        v4_name = mirrored.machines[machine_id]['name']
        if plan.machines[machine_id]['name'] != v4_name:
            echo('  machine %s (%s) is imported as %r'
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
            convert_run(plan, run, read_run(mirrored, run))
        except ConversionError as e:
            failures += 1
            echo('  %s: %s' % (_describe(plan, run), e))
    echo('Converted %d run(s) of %d machine(s); %d failure(s).'
         % (len(mirrored.runs) - failures, len(plan.machines), failures))
    return failures

"""Mirror a test suite of an LNT v4 instance into a local directory.

This implements ``lnt mirror-v4``. docs/mirror_v4.rst specifies the mirror's
format and the guarantees maintained here; the comments below refer to it as
"the spec".

The central invariant, which every step is ordered to preserve: each run the
manifest lists under a machine appears in that machine's listing (the version of
it whose hash the manifest records), and its mirrored document embeds that
listing's summary of the run and that listing's machine. Payload files are
always written before the manifest references them, and the manifest stops
referencing a file before the file is overwritten or deleted.
"""

import contextlib
import datetime
import fcntl
import gzip
import hashlib
import json
import os
import re
import shutil
import tempfile
import threading
import time
import zlib
from collections.abc import Callable, Iterable, Iterator
from concurrent.futures import Future, ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from typing import Any, TypedDict, TypeVar, cast
from urllib.parse import quote

import requests

MANIFEST = 'manifest.json'

# The version of the mirror's format, recorded in its manifest. A refresh
# refuses a mirror of any other version rather than risk misreading it.
FORMAT_VERSION = '1'

# Where files are written before being moved into place. It is cleared whenever
# a refresh opens the mirror, so whatever an interrupted refresh left in it
# goes.
STAGING = '.mirror-tmp'

# How often, in fetched runs, the manifest is flushed during a refresh. A flush
# rewrites the whole manifest, so it is not done after every run; anything
# fetched but not yet flushed is adopted by the next refresh rather than fetched
# again.
FLUSH_EVERY = 100

# Requests are retried on connection errors, 5xx responses and the statuses
# below, with these delays (in seconds) before the second and third attempts.
RETRY_DELAYS = (1, 4)
RETRY_STATUSES = frozenset({408, 429})

# (connect, read) timeouts, in seconds. Runs are ~1 MB of JSON that a v4 server
# can take a while to produce.
TIMEOUT = (30, 300)

# Some deployments sit behind a proxy that rejects the default User-Agent of
# python-requests, so send one of our own.
USER_AGENT = 'lnt-mirror-v4'

# Run documents compress about as well at this level as at the maximum, at a
# fraction of the CPU time.
COMPRESS_LEVEL = 6

# Suite names end up in paths and URLs, and database names in URLs. v4 creates
# suites from schemas with names of the first form.
_SUITE_RE = re.compile(r'^[A-Za-z][A-Za-z0-9_]*$')
_DATABASE_RE = re.compile(r'^[A-Za-z0-9_][A-Za-z0-9_.-]*$')

# A JSON object from a server response. Its shape is the server's, and only the
# parts the refresh relies on are checked.
JSONObject = dict[str, Any]

# Where the refresh reports its progress, one line at a time.
Echo = Callable[[str], None]

_T = TypeVar('_T')


# The manifest, as the spec describes it.

class Source(TypedDict):
    url: str
    database: str


class SchemaEntry(TypedDict):
    sha256: str


class RunEntry(TypedDict):
    sha256: str


class MachineEntry(TypedDict):
    name: str
    fetched_at: str
    sha256: str
    runs: dict[str, RunEntry]


class SuiteEntry(TypedDict):
    schema: SchemaEntry
    machines: dict[str, MachineEntry]


class Manifest(TypedDict):
    format_version: str
    source: Source
    suites: dict[str, SuiteEntry]


class MirrorError(Exception):
    """A problem that stops the refresh before it modifies the mirror."""


class FetchError(Exception):
    """A response that could not be obtained from the server, or not used."""


class HTTPStatusError(FetchError):
    def __init__(self, url: str, status: int) -> None:
        super().__init__('%s returned HTTP %d' % (url, status))
        self.status = status


def _now() -> str:
    return datetime.datetime.now(datetime.timezone.utc) \
        .strftime('%Y-%m-%dT%H:%M:%SZ')


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _parse(data: bytes, what: str) -> JSONObject:
    """Parse a JSON object received from the server."""
    try:
        document = json.loads(data)
    except ValueError as e:
        raise FetchError('%s is not valid JSON: %s' % (what, e))
    if not isinstance(document, dict):
        raise FetchError('%s is not a JSON object' % what)
    return document


def _parse_listing(data: bytes,
                   machine_id: str) -> tuple[JSONObject, dict[str, JSONObject]]:
    """A machine's listing, as its machine object and its runs by identifier."""
    what = 'the listing of machine %s' % machine_id
    listing = _parse(data, what)
    try:
        machine = listing['machine']
        if not isinstance(machine.get('name'), str):
            raise ValueError('the machine has no name')
        summaries = {str(int(run['id'])): run for run in listing['runs']}
    except (AttributeError, KeyError, TypeError, ValueError) as e:
        raise FetchError('%s is malformed: %r' % (what, e))
    return machine, summaries


# ----------------------------------------------------------------------------
# HTTP
# ----------------------------------------------------------------------------

class Client:
    """Fetches the raw bodies of one suite's API responses."""

    def __init__(self, url: str, database: str, suite: str) -> None:
        self.base = '%s/api/db_%s/v4/%s' % (url, quote(database, safe=''),
                                            quote(suite, safe=''))
        # requests does not promise that a Session is safe to share between
        # threads, so give each worker its own.
        self._local = threading.local()
        self._stopping = threading.Event()

    def stop(self) -> None:
        """Send no more requests, and do not retry those in flight."""
        self._stopping.set()

    def _session(self) -> requests.Session:
        session: requests.Session | None = getattr(self._local, 'session', None)
        if session is None:
            session = requests.Session()
            session.headers['User-Agent'] = USER_AGENT
            self._local.session = session
        return session

    def get(self, path: str) -> bytes:
        """Return the body of GET <base>/<path>.

        Every request carries a query parameter no cache has seen: a caching
        proxy in front of the instance (lnt.llvm.org's CDN caches API responses
        for up to an hour) would otherwise serve listings that predate recent
        changes, and runs that predate their replacement.
        """
        url = '%s/%s' % (self.base, path)
        delays = iter(RETRY_DELAYS)
        while True:
            if self._stopping.is_set():
                raise FetchError('%s: not sent, the refresh is stopping' % url)
            error: FetchError
            try:
                response = self._session().get(
                    url, params={'_': str(time.time_ns())}, timeout=TIMEOUT)
            except requests.RequestException as e:
                error = FetchError('%s: %s' % (url, e))
            else:
                if response.status_code == 200:
                    return response.content
                error = HTTPStatusError(url, response.status_code)
                if response.status_code < 500 and \
                        response.status_code not in RETRY_STATUSES:
                    raise error
            delay = next(delays, None)
            # Waiting on the event rather than sleeping ends the wait as soon as
            # the refresh stops.
            if delay is None or self._stopping.wait(delay):
                raise error


# ----------------------------------------------------------------------------
# Mirror
# ----------------------------------------------------------------------------

def _sorted_by_id(mapping: dict[str, _T]) -> dict[str, _T]:
    """`mapping`, ordered by its keys as integers rather than as strings."""
    return {key: mapping[key] for key in sorted(mapping, key=int)}


def _fsync_directory(path: str) -> None:
    fd = os.open(path, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


class Mirror:
    def __init__(self, path: str) -> None:
        self.path = path
        # Set by `open`.
        self.manifest: Manifest
        self.is_new = False
        self._lock_fd: int | None = None
        # Whether worker threads may still write to the mirror (see _workers).
        self.workers_running = False
        # mkstemp creates files only their owner can read; give ours the
        # permissions any other new file would get. Querying the umask means
        # setting it, which is only safe before any worker thread starts.
        umask = os.umask(0)
        os.umask(umask)
        self._mode = 0o666 & ~umask
        # Directories that files were moved into since the last flush.
        self._moved_into: set[str] = set()
        self._moved_into_lock = threading.Lock()

    def open(self, url: str, database: str, create: bool) -> None:
        """Lock the mirror and load its manifest.

        With `create`, the directory is created if needed and the staging area
        cleared; otherwise (for a dry run) nothing is written, and a directory
        that does not exist is treated as an empty mirror.

        A directory that has no manifest must be empty: anything else is not a
        mirror, and refreshing it could delete files that are not ours.
        """
        if create:
            os.makedirs(self.path, exist_ok=True)
        if os.path.isdir(self.path):
            self._lock()
        self._load(url, database)
        if create:
            shutil.rmtree(os.path.join(self.path, STAGING), ignore_errors=True)

    def _load(self, url: str, database: str) -> None:
        source = Source(url=url, database=database)
        manifest_path = os.path.join(self.path, MANIFEST)
        if not os.path.exists(manifest_path):
            # The staging area alone is what a refresh leaves behind if it is
            # interrupted while writing the manifest of a new mirror.
            if os.path.isdir(self.path) and \
                    set(os.listdir(self.path)) - {STAGING}:
                raise MirrorError('%s is not empty and is not a mirror'
                                  % self.path)
            self.manifest = Manifest(format_version=FORMAT_VERSION,
                                     source=source, suites={})
            self.is_new = True
            return
        try:
            with open(manifest_path) as f:
                manifest = json.load(f)
        except ValueError as e:
            raise MirrorError('%s is not valid JSON: %s' % (manifest_path, e))
        if not isinstance(manifest, dict):
            raise MirrorError('%s is not a mirror manifest' % manifest_path)
        if manifest.get('format_version') != FORMAT_VERSION:
            raise MirrorError(
                '%s has format version %r, but this version of LNT only '
                'handles format version %r'
                % (manifest_path, manifest.get('format_version'),
                   FORMAT_VERSION))
        if not isinstance(manifest.get('suites'), dict):
            raise MirrorError('%s is not a mirror manifest' % manifest_path)
        if manifest.get('source') != source:
            recorded = manifest.get('source') or {}
            raise MirrorError(
                '%s is a mirror of database %r of %s, not of database %r '
                'of %s' % (self.path, recorded.get('database'),
                           recorded.get('url'), database, url))
        self.manifest = cast(Manifest, manifest)

    def _lock(self) -> None:
        """Take the mirror for this process, or fail if another has it.

        The lock is on the directory itself rather than on a file in it, so
        that taking it creates nothing (which matters for --dry-run), and it is
        released by the OS if the process dies.
        """
        self._lock_fd = os.open(self.path, os.O_RDONLY)
        try:
            fcntl.flock(self._lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            self.close()
            raise MirrorError('%s is in use by another refresh' % self.path)

    def close(self) -> None:
        # A mirror that workers may still write to stays locked, until the OS
        # releases the lock when the process exits.
        if self._lock_fd is not None and not self.workers_running:
            os.close(self._lock_fd)
            self._lock_fd = None

    def flush(self) -> None:
        suites: dict[str, SuiteEntry] = {}
        for name, suite in sorted(self.manifest['suites'].items()):
            machines: dict[str, MachineEntry] = {}
            for machine_id, machine in suite['machines'].items():
                machines[machine_id] = machine.copy()
                machines[machine_id]['runs'] = _sorted_by_id(machine['runs'])
            suites[name] = SuiteEntry(schema=suite['schema'],
                                      machines=_sorted_by_id(machines))
        manifest = Manifest(format_version=FORMAT_VERSION,
                            source=self.manifest['source'], suites=suites)
        data = (json.dumps(manifest, indent=2) + '\n').encode('utf-8')
        # The files the manifest references must be durable before it is, and
        # a rename is only durable once its directory is synced.
        self._sync_directories()
        self.write(MANIFEST, data)
        self._sync_directories()

    def _sync_directories(self) -> None:
        with self._moved_into_lock:
            directories, self._moved_into = self._moved_into, set()
        for directory in directories:
            _fsync_directory(directory)

    def write(self, relpath: str, data: bytes, compress: bool = False) -> None:
        """Atomically replace the file at `relpath` with `data`."""
        path = os.path.join(self.path, relpath)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        staging = os.path.join(self.path, STAGING)
        os.makedirs(staging, exist_ok=True)
        if compress:
            # mtime=0, so that the same document always compresses to the
            # same bytes.
            data = gzip.compress(data, compresslevel=COMPRESS_LEVEL, mtime=0)
        fd, tmp = tempfile.mkstemp(dir=staging)
        os.fchmod(fd, self._mode)
        with os.fdopen(fd, 'wb') as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
        with self._moved_into_lock:
            self._moved_into.add(os.path.dirname(path))

    def read(self, relpath: str, compressed: bool = False) -> bytes | None:
        """The contents of the file at `relpath`, or None if unreadable."""
        try:
            with open(os.path.join(self.path, relpath), 'rb') as f:
                data = f.read()
            return gzip.decompress(data) if compressed else data
        except (OSError, EOFError, zlib.error):
            return None


def schema_path(suite: str) -> str:
    return '%s/schema.json' % suite


def machine_path(suite: str, machine_id: str) -> str:
    return '%s/machines/%s.json' % (suite, machine_id)


def run_path(suite: str, run_id: str) -> str:
    return '%s/runs/%s.json.gz' % (suite, run_id)


# ----------------------------------------------------------------------------
# Refreshing
# ----------------------------------------------------------------------------

@dataclass
class _UnlistedMachine:
    """A machine whose listing could not be fetched.

    The refresh leaves what the mirror has for it untouched.
    """

    id: str
    name: str | None
    error: FetchError

    def describe(self) -> str:
        return 'machine %s (%s)' % (self.id, self.name)


@dataclass
class _MachinePlan:
    """What a refresh does with one machine, given its listing."""

    id: str
    fetched_at: str
    listing: bytes                   # raw bytes of the machine's listing
    machine: JSONObject              # the machine object, from the listing
    summaries: dict[str, JSONObject]  # run id -> run summary, from the listing
    listing_changed: bool = True     # whether it differs from the mirrored one
    # Mirrored runs kept as they are, by run id.
    kept: dict[str, RunEntry] = field(default_factory=dict)
    changed: set[str] = field(default_factory=set)  # runs no longer current
    removed: int = 0                 # mirrored runs gone from the server

    @property
    def name(self) -> str:
        name: str = self.machine['name']
        return name

    @property
    def to_fetch(self) -> list[str]:
        """The runs the mirror does not hold a current copy of."""
        return sorted((run_id for run_id in self.summaries
                       if run_id not in self.kept), key=int)

    def describe(self) -> str:
        return 'machine %s (%s)' % (self.id, self.name)

    def is_current(self, run_id: str, document: JSONObject) -> bool:
        """Whether a run document is current, according to the listing.

        Current means that the document embeds the run's summary and machine
        exactly as the listing reports them. Both can change independently: a
        replaced run gets a new summary, while renaming a machine, updating its
        fields, or moving runs to it from another machine changes the machine
        embedded in runs whose summary is unchanged.
        """
        return document.get('run') == self.summaries[run_id] and \
            document.get('machine') == self.machine

    def current_sha(self, run_id: str, data: bytes | None) -> str | None:
        """The sha256 of a mirrored run document if it is current, or None.
        """
        if data is None:
            return None
        try:
            document = _parse(data, 'run %s' % run_id)
        except FetchError:
            return None
        return _sha256(data) if self.is_current(run_id, document) else None


def _plan_machine(client: Client, mirror: Mirror, suite: str,
                  machine_id: str, mirrored: MachineEntry | None
                  ) -> _MachinePlan | _UnlistedMachine:
    """Fetch a machine's listing and work out what to do with its runs.

    `mirrored` is the machine's manifest entry, or None if it is new.
    """
    fetched_at = _now()
    try:
        listing = client.get('machines/%s' % machine_id)
        machine, summaries = _parse_listing(listing, machine_id)
    except FetchError as e:
        return _UnlistedMachine(machine_id,
                                mirrored['name'] if mirrored else None, e)
    plan = _MachinePlan(machine_id, fetched_at, listing, machine, summaries)
    if not mirrored:
        return plan

    # The fast path: every mirrored run is current according to the previous
    # listing, provided that listing is the version the manifest vouches for,
    # so a run whose summary and machine are the same in both listings is
    # still current. Otherwise (the refresh that wrote the listing was
    # interrupted before it could update the manifest), fall back to checking
    # the mirrored runs themselves.
    previous = mirror.read(machine_path(suite, machine_id))
    previous_summaries: dict[str, JSONObject] | None = None
    if previous is not None and _sha256(previous) == mirrored['sha256']:
        plan.listing_changed = previous != plan.listing
        try:
            previous_machine, previous_summaries = \
                _parse_listing(previous, machine_id)
        except FetchError:
            pass
        else:
            if previous_machine != plan.machine:
                previous_summaries = {}

    for run_id, run_entry in mirrored['runs'].items():
        if run_id not in plan.summaries:
            plan.removed += 1
            continue
        path = run_path(suite, run_id)
        if previous_summaries is not None:
            current = previous_summaries.get(run_id) == \
                plan.summaries[run_id] and \
                os.path.exists(os.path.join(mirror.path, path))
        else:
            current = plan.current_sha(
                run_id, mirror.read(path, compressed=True)) == \
                run_entry['sha256']
        if current:
            plan.kept[run_id] = run_entry
        else:
            plan.changed.add(run_id)
    return plan


@contextlib.contextmanager
def _workers(client: Client, mirror: Mirror, count: int,
             echo: Echo) -> Iterator[ThreadPoolExecutor]:
    """A pool of `count` threads sending requests through `client`.

    Leaving the block waits for every thread to finish, even when it is left by
    an exception, such as the user interrupting the refresh: a worker can write
    to the mirror, so it must be done before the mirror is unlocked, or it could
    overwrite a file that the manifest of the next refresh references. To keep
    that wait short, the workers stop sending and retrying requests, and only
    the requests in flight are waited for. If that wait is interrupted too, the
    mirror stays locked until the process exits.
    """
    pool = ThreadPoolExecutor(max_workers=count)
    mirror.workers_running = True
    try:
        yield pool
    except BaseException:
        client.stop()
        echo('Stopping: waiting for the requests in flight to finish...')
        raise
    finally:
        pool.shutdown(wait=True, cancel_futures=True)
        # Not reached if the wait is interrupted.
        mirror.workers_running = False


def _fetch_all(client: Client, mirror: Mirror, suite: str,
               pending: list[tuple[_MachinePlan, str]], workers: int,
               echo: Echo) -> tuple[int, int]:
    """Fetch and store the runs in `pending`, a list of (plan, run id).

    Returns the number of runs fetched and the number that failed. Workers only
    fetch and write payload files; the manifest is updated on this thread, and
    flushed every FLUSH_EVERY runs.
    """
    def fetch_and_store(plan: _MachinePlan, run_id: str) -> str:
        data = client.get('runs/%s' % run_id)
        if not plan.is_current(run_id, _parse(data, 'run %s' % run_id)):
            # The run or its machine changed on the server since the listing;
            # storing it would break the invariant. The next refresh will pick
            # it up.
            raise FetchError('run %s changed on the server during the refresh'
                             % run_id)
        mirror.write(run_path(suite, run_id), data, compress=True)
        return _sha256(data)

    fetched = failures = 0
    with _workers(client, mirror, workers, echo) as pool:
        futures: dict[Future[str], tuple[_MachinePlan, str]] = {
            pool.submit(fetch_and_store, plan, run_id): (plan, run_id)
            for plan, run_id in pending}
        for future in as_completed(futures):
            plan, run_id = futures[future]
            try:
                sha = future.result()
            except FetchError as e:
                failures += 1
                echo('  run %s of %s: %s' % (run_id, plan.describe(), e))
                continue
            mirror.manifest['suites'][suite]['machines'][plan.id]['runs'][
                run_id] = RunEntry(sha256=sha)
            fetched += 1
            if fetched % FLUSH_EVERY == 0:
                mirror.flush()
                echo('  fetched %d/%d' % (fetched, len(pending)))
    return fetched, failures


def _clean(mirror: Mirror, suite: str, entry: SuiteEntry) -> None:
    """Delete the payload files of `suite` that the manifest does not reference.
    """
    referenced = {
        'machines': {'%s.json' % machine_id for machine_id in entry['machines']},
        'runs': {'%s.json.gz' % run_id for machine in entry['machines'].values()
                 for run_id in machine['runs']},
    }
    for subdirectory, names in referenced.items():
        directory = os.path.join(mirror.path, suite, subdirectory)
        if not os.path.isdir(directory):
            continue
        for name in os.listdir(directory):
            if name not in names:
                os.remove(os.path.join(directory, name))


def refresh(url: str, mirror_dir: str, suite: str, database: str = 'default',
            machines: Iterable[str] = (), workers: int = 4,
            dry_run: bool = False, echo: Echo = print) -> int:
    """Refresh `suite` in the mirror at `mirror_dir`.

    Returns the number of things that could not be fetched: 0 means the
    machines refreshed now match the server. Raises MirrorError for problems
    that stop the refresh before the mirror is modified.
    """
    url = url.rstrip('/')
    if not _SUITE_RE.match(suite):
        raise MirrorError('invalid suite name: %r' % suite)
    if not _DATABASE_RE.match(database):
        raise MirrorError('invalid database name: %r' % database)

    created = not dry_run and not os.path.exists(mirror_dir)
    mirror = Mirror(mirror_dir)
    try:
        mirror.open(url, database, create=not dry_run)
        return _refresh_suite(mirror, url, suite, database, set(machines),
                              workers, dry_run, echo)
    except MirrorError:
        # Such an error comes before anything is written, so a directory this
        # refresh created is still empty, and is removed rather than left
        # behind.
        if created:
            try:
                os.rmdir(mirror_dir)
            except OSError:
                pass
        raise
    finally:
        mirror.close()


def _refresh_suite(mirror: Mirror, url: str, suite: str, database: str,
                   machine_filter: set[str], workers: int, dry_run: bool,
                   echo: Echo) -> int:
    for mirrored_suite in mirror.manifest['suites']:
        if mirrored_suite != suite and mirrored_suite.lower() == suite.lower():
            raise MirrorError(
                "suite '%s' would share a directory with the mirrored suite "
                "'%s' on case-insensitive file systems" % (suite, mirrored_suite))
    client = Client(url, database, suite)
    echo("Mirroring suite '%s' of %s (database '%s') into %s%s"
         % (suite, url, database, mirror.path,
            ' (dry run)' if dry_run else ''))

    # Everything that can make the refresh fail as a whole is checked before
    # the mirror is touched.
    try:
        schema = client.get('schema')
        _parse(schema, 'the schema')
        listing = _parse(client.get('machines'), 'the list of machines')
        server: dict[str, str] = {str(int(m['id'])): m['name']
                                  for m in listing['machines']}
    except HTTPStatusError as e:
        if e.status == 404:
            raise MirrorError("there is no suite '%s' in database '%s' of %s"
                              % (suite, database, url))
        raise MirrorError(str(e))
    except (FetchError, KeyError, TypeError, ValueError) as e:
        raise MirrorError(str(e))

    entry = mirror.manifest['suites'].get(suite) or SuiteEntry(
        schema=SchemaEntry(sha256=_sha256(schema)), machines={})
    mirrored = entry['machines']
    if machine_filter:
        unknown = machine_filter - set(server.values()) - \
            {m['name'] for m in mirrored.values()}
        if unknown:
            raise MirrorError("no machine named %s in suite '%s'" % (
                ', '.join("'%s'" % name for name in sorted(unknown)), suite))
        # A machine is in scope if its current name, or the name it had when
        # it was mirrored, is selected.
        in_scope = {i for i, name in server.items() if name in machine_filter}
        in_scope |= {i for i, m in mirrored.items()
                     if m['name'] in machine_filter}
    else:
        in_scope = set(server) | set(mirrored)

    removed_machines = sorted((i for i in in_scope if i not in server), key=int)
    for machine_id in removed_machines:
        echo('  machine %s (%s): no longer on the server, %s'
             % (machine_id, mirrored[machine_id]['name'],
                'to remove' if dry_run else 'removed'))

    # Machine listings are fetched concurrently: on a refresh of an up-to-date
    # mirror, they are most of the work.
    with _workers(client, mirror, workers, echo) as pool:
        plans = list(pool.map(
            lambda machine_id: _plan_machine(client, mirror, suite, machine_id,
                                             mirrored.get(machine_id)),
            sorted(in_scope - set(removed_machines), key=int)))
    failures = 0
    ok: list[_MachinePlan] = []
    for plan in plans:
        if isinstance(plan, _UnlistedMachine):
            failures += 1
            echo('  %s: could not fetch its listing: %s'
                 % (plan.describe(), plan.error))
            continue
        ok.append(plan)
        echo('  %s: %d run(s) to fetch, %d changed, %d removed, %d unchanged'
             % (plan.describe(), len(plan.to_fetch) - len(plan.changed),
                len(plan.changed), plan.removed, len(plan.kept)))

    if dry_run:
        echo('Dry run: the mirror was not modified.')
        return failures

    # From here on the mirror is modified. A new mirror gets its manifest
    # first, so that a directory holding any of our files is recognised as an
    # mirror even if this refresh is interrupted. Then the manifest is brought
    # to a state where it no longer references anything this refresh removes or
    # replaces; only then are payload files overwritten or deleted.
    if mirror.is_new:
        mirror.flush()
    mirror.manifest['suites'][suite] = entry
    if mirror.read(schema_path(suite)) != schema:
        mirror.write(schema_path(suite), schema)
    entry['schema'] = SchemaEntry(sha256=_sha256(schema))
    for machine_id in removed_machines:
        del mirrored[machine_id]

    for plan in ok:
        if plan.listing_changed:
            mirror.write(machine_path(suite, plan.id), plan.listing)
        mirrored[plan.id] = MachineEntry(
            name=plan.name, fetched_at=plan.fetched_at,
            sha256=_sha256(plan.listing), runs=dict(plan.kept))
    # A run the server moved to another machine may still be listed under its
    # old one, if that machine is out of scope or its listing could not be
    # fetched. It stops being listed there before its file is replaced.
    fetching = {run_id: plan.id for plan in ok for run_id in plan.to_fetch}
    for machine_id, machine in mirrored.items():
        for run_id in [run_id for run_id in machine['runs']
                       if fetching.get(run_id, machine_id) != machine_id]:
            del machine['runs'][run_id]
    mirror.flush()

    # Runs the refresh knows to have changed are fetched; any other run missing
    # from the manifest may have been fetched by an interrupted refresh, and is
    # reused if still current.
    pending: list[tuple[_MachinePlan, str]] = []
    adopted = 0
    for plan in ok:
        for run_id in plan.to_fetch:
            sha = None
            if run_id not in plan.changed:
                sha = plan.current_sha(run_id, mirror.read(
                    run_path(suite, run_id), compressed=True))
            if sha is None:
                pending.append((plan, run_id))
            else:
                mirrored[plan.id]['runs'][run_id] = RunEntry(sha256=sha)
                adopted += 1
    if adopted:
        echo('Reused %d run(s) left by an interrupted refresh' % adopted)

    fetched = 0
    try:
        if pending:
            echo('Fetching %d run(s) with %d worker(s)...'
                 % (len(pending), workers))
            fetched, fetch_failures = _fetch_all(client, mirror, suite,
                                                 pending, workers, echo)
            failures += fetch_failures
    finally:
        # Also when interrupted, so that the runs fetched so far are kept.
        mirror.flush()
    _clean(mirror, suite, entry)

    removed_runs = sum(plan.removed for plan in ok)
    echo('Fetched %d run(s); removed %d run(s) and %d machine(s); '
         '%d failure(s).' % (fetched, removed_runs, len(removed_machines),
                             failures))
    return failures
